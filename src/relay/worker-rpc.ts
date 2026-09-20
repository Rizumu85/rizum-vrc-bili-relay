import { RELAY_PROTOCOL_VERSION, type RelayReply } from "./protocol";

export class RelayWorkerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RelayWorkerError";
  }
}

export interface RpcMeasurement {
  event: string;
  request_id?: number;
  command?: string;
  queue_depth?: number;
  queue_ms?: number;
  elapsed_ms?: number;
  bytes?: number;
  code?: string;
}

// This scheduler knows the wire contract, not Bun processes or product rules.
// A synchronous worker can execute exactly one command at a time. Keep unsent
// work here, where it can still be cancelled without uncertain side effects.
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PENDING = 128;
const MAX_QUEUE_WAIT_MS = 60_000;
const REPLIES: Readonly<Record<string, RelayReply["type"]>> = {
  health: "health",
  inspect_source: "source_inspection",
  resolve_source: "source_resolution",
  start_relay: "relay_state",
  retarget_relay: "playback_state",
  relay_status: "relay_state",
  set_relay_paused: "relay_state",
  set_relay_rate: "relay_state",
  stop_relay: "relay_state",
  ensure_ffmpeg: "ffmpeg_state",
  bilibili_auth_status: "bilibili_auth_state",
  begin_bilibili_login: "bilibili_auth_state",
  poll_bilibili_login: "bilibili_auth_state",
  logout_bilibili: "bilibili_auth_state",
  list_favorite_folders: "favorite_folders",
  list_favorite_resources: "favorite_resources",
  search_favorite_resources: "favorite_resources",
  fetch_favorite_covers: "favorite_covers",
  list_watch_later: "favorite_resources",
  list_history: "favorite_resources",
  get_settings: "settings_state",
  reveal_stream_key: "stream_key_value",
  save_settings: "settings_state",
  shutdown: "shutdown_accepted",
};

interface Request {
  id: number;
  command: string;
  wire: string;
  bytes: number;
  timeoutMs: number;
  queuedAt: number;
  startedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (reply: RelayReply) => void;
  reject: (error: Error) => void;
}

export class WorkerRpc {
  private nextId = 1;
  private queue: Request[] = [];
  private active: Request | null = null;
  private terminal: RelayWorkerError | null = null;

  constructor(
    private readonly send: (line: string) => Promise<void>,
    private readonly onFatal: (error: RelayWorkerError) => void,
    private readonly record: (entry: RpcMeasurement) => void,
  ) {}

  request(command: Record<string, unknown>, timeoutMs = 15_000): Promise<RelayReply> {
    if (this.terminal) return Promise.reject(this.terminal);
    const type = command.type;
    if (typeof type !== "string" || !Object.hasOwn(REPLIES, type)) {
      return Promise.reject(new RelayWorkerError("invalid_request", "Unknown worker command"));
    }
    if (this.queue.length + Number(this.active !== null) >= MAX_PENDING) {
      return Promise.reject(new RelayWorkerError("worker_busy", "Worker request queue is full; command was not sent"));
    }
    const id = this.nextId++;
    let wire: string;
    try {
      wire = `${JSON.stringify({ ...command, id })}\n`;
    } catch {
      return Promise.reject(new RelayWorkerError("invalid_request", "Worker command could not be serialized"));
    }
    const bytes = Buffer.byteLength(wire, "utf8");
    if (bytes > MAX_REQUEST_BYTES) {
      return Promise.reject(new RelayWorkerError("invalid_request", "Worker command exceeds the 1 MiB limit; command was not sent"));
    }
    return new Promise((resolve, reject) => {
      const item: Request = { id, command: type, wire, bytes, timeoutMs, queuedAt: performance.now(), resolve, reject };
      item.timer = setTimeout(() => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.measure(item, "queue_expired", "worker_queue_timeout");
        reject(new RelayWorkerError("worker_queue_timeout", "Worker queue wait expired; command was not sent"));
      }, MAX_QUEUE_WAIT_MS);
      this.queue.push(item);
      this.measure(item, "queued");
      this.pump();
    });
  }

  accept(line: string): void {
    if (this.terminal) return;
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.fail(new RelayWorkerError("invalid_response", "Worker returned invalid JSON"));
      return;
    }
    if (!isObject(response) || !Number.isSafeInteger(response.id) || !this.active || response.id !== this.active.id) {
      this.fail(new RelayWorkerError("invalid_response", "Worker response has an unexpected request id"));
      return;
    }
    const item = this.active;
    if (response.status === "ok") {
      const reply = response.result;
      if (!isObject(reply) || reply.type !== REPLIES[item.command]) {
        this.fail(new RelayWorkerError("protocol_mismatch", "Worker reply does not match the dispatched command"));
        return;
      }
      if (item.command === "health" && reply.protocol_version !== RELAY_PROTOCOL_VERSION) {
        this.fail(new RelayWorkerError("protocol_mismatch", `Worker protocol does not match UI protocol ${RELAY_PROTOCOL_VERSION}`));
        return;
      }
      this.finish(item, "completed");
      item.resolve(reply as unknown as RelayReply);
    } else if (response.status === "error" && isObject(response.error)
      && typeof response.error.code === "string" && typeof response.error.message === "string") {
      this.finish(item, "command_error", response.error.code);
      item.reject(new RelayWorkerError(response.error.code, response.error.message));
    } else {
      this.fail(new RelayWorkerError("invalid_response", "Worker returned an invalid response envelope"));
      return;
    }
    // Do not dispatch from within the response parser's call stack.
    queueMicrotask(() => this.pump());
  }

  cancelQueued(error: RelayWorkerError): void {
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer);
      this.measure(item, "cancelled_unsent", error.code);
      item.reject(error);
    }
  }

  fail(error: RelayWorkerError): void {
    if (this.terminal) return;
    this.terminal = error;
    const item = this.active;
    this.active = null;
    if (item) {
      clearTimeout(item.timer);
      this.measure(item, "transport_failed", error.code);
      item.reject(error);
    }
    this.cancelQueued(error);
    this.onFatal(error);
  }

  private pump(): void {
    if (this.terminal || this.active || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    clearTimeout(item.timer);
    this.active = item;
    item.startedAt = performance.now();
    this.measure(item, "dispatched");
    item.timer = setTimeout(() => {
      if (this.active !== item) return;
      // The core may already have mutated state. Never silently forget this
      // request or replay it into another generation with a second publisher.
      this.fail(new RelayWorkerError("worker_timeout", `Worker command ${item.command} timed out after dispatch; the worker is being stopped and the command will not be retried`));
    }, item.timeoutMs);
    void this.send(item.wire).catch(() => {
      if (this.active === item) {
        this.fail(new RelayWorkerError("worker_io", "Could not write the worker command"));
      }
    });
  }

  private finish(item: Request, event: string, code?: string): void {
    clearTimeout(item.timer);
    this.active = null;
    this.measure(item, event, code);
  }

  private measure(item: Request, event: string, code?: string): void {
    const now = performance.now();
    this.record({
      event, request_id: item.id, command: item.command, bytes: item.bytes,
      queue_depth: this.queue.length, queue_ms: (item.startedAt ?? now) - item.queuedAt,
      elapsed_ms: item.startedAt === undefined ? undefined : now - item.startedAt, code,
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
