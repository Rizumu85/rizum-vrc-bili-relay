import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  RELAY_PROTOCOL_VERSION,
  type FfmpegStateReply,
  type FfmpegStatus,
  type HealthReply,
  type PlaybackStateReply,
  type RelayReply,
  type RelayResponse,
  type RelayStateReply,
  type RelayStatus,
  type RelayTarget,
  type SourceInspection,
  type SourceInspectionReply,
  type SourceResolution,
  type SourceResolutionReply,
} from "./protocol";

interface PendingRequest {
  resolve: (reply: RelayReply) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RelayWorkerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayWorkerError";
  }
}

export class RelayWorkerClient {
  private child: Bun.PipedSubprocess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closing = false;

  async health(): Promise<HealthReply> {
    const reply = await this.request({ type: "health" });
    if (reply.type !== "health") {
      throw new RelayWorkerError("protocol_mismatch", `Expected health reply, received ${reply.type}`);
    }
    if (reply.protocol_version !== RELAY_PROTOCOL_VERSION) {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `UI protocol ${RELAY_PROTOCOL_VERSION} does not match worker protocol ${reply.protocol_version}`,
      );
    }
    return reply;
  }

  async inspectSource(source: string): Promise<SourceInspection> {
    await this.health();
    const reply = await this.request({ type: "inspect_source", source });
    if (reply.type !== "source_inspection") {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `Expected source inspection, received ${reply.type}`,
      );
    }
    return (reply as SourceInspectionReply).inspection;
  }

  async resolveSource(source: string, requestedPart?: number): Promise<SourceResolution> {
    await this.health();
    const reply = await this.request(
      { type: "resolve_source", source, requested_part: requestedPart },
      30_000,
    );
    if (reply.type !== "source_resolution") {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `Expected source resolution, received ${reply.type}`,
      );
    }
    return (reply as SourceResolutionReply).resolution;
  }

  async startRelay(sessionId: string, target: RelayTarget): Promise<RelayStatus> {
    return this.relayRequest({ type: "start_relay", session_id: sessionId, target }, 20_000);
  }

  async retargetRelay(
    currentSessionId: string | undefined,
    source: string,
    requestedPart: number,
    target: RelayTarget,
  ): Promise<{ resolution: SourceResolution; relay: RelayStatus }> {
    await this.health();
    const reply = await this.request(
      {
        type: "retarget_relay",
        current_session_id: currentSessionId,
        source,
        requested_part: requestedPart,
        target,
      },
      40_000,
    );
    if (reply.type !== "playback_state") {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `Expected playback state, received ${reply.type}`,
      );
    }
    const playback = reply as PlaybackStateReply;
    return { resolution: playback.resolution, relay: playback.relay };
  }

  async relayStatus(sessionId: string): Promise<RelayStatus> {
    return this.relayRequest({ type: "relay_status", session_id: sessionId });
  }

  async stopRelay(sessionId: string): Promise<RelayStatus> {
    return this.relayRequest({ type: "stop_relay", session_id: sessionId });
  }

  async ensureFfmpeg(): Promise<FfmpegStatus> {
    await this.health();
    const reply = await this.request({ type: "ensure_ffmpeg" });
    if (reply.type !== "ffmpeg_state") {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `Expected FFmpeg state, received ${reply.type}`,
      );
    }
    return (reply as FfmpegStateReply).ffmpeg;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;

    try {
      await this.request({ type: "shutdown" }, 1_000);
      await child.exited;
    } catch {
      child.kill();
    } finally {
      this.child = null;
      this.rejectPending(new RelayWorkerError("worker_closed", "Rust relay worker closed"));
    }
  }

  private async relayRequest(
    command: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<RelayStatus> {
    await this.health();
    const reply = await this.request(command, timeoutMs);
    if (reply.type !== "relay_state") {
      throw new RelayWorkerError(
        "protocol_mismatch",
        `Expected relay state, received ${reply.type}`,
      );
    }
    return (reply as RelayStateReply).relay;
  }

  private async request(
    command: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<RelayReply> {
    if (this.closing && command.type !== "shutdown") {
      throw new RelayWorkerError("worker_closed", "Rust relay worker is closing");
    }

    const child = this.ensureStarted();
    const id = this.nextId++;
    const response = new Promise<RelayReply>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new RelayWorkerError("worker_timeout", "Rust relay worker did not respond in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
    });

    try {
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      child.stdin.flush();
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(asWorkerError(error));
      }
    }
    return response;
  }

  private ensureStarted(): Bun.PipedSubprocess {
    if (this.child) return this.child;
    const executable = findWorkerExecutable();
    if (!executable) {
      throw new RelayWorkerError(
        "worker_unavailable",
        "relay-worker.exe was not found; build the Rust worker before starting the UI",
      );
    }

    const child = Bun.spawn([executable], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    this.child = child;
    void this.readResponses(child);
    void this.readErrors(child);
    void child.exited.then((exitCode) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.closing) {
        this.rejectPending(
          new RelayWorkerError("worker_exited", `Rust relay worker exited with code ${exitCode}`),
        );
      }
    });
    return child;
  }

  private async readResponses(child: Bun.PipedSubprocess): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.acceptResponse(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      this.rejectPending(asWorkerError(error));
    } finally {
      reader.releaseLock();
    }
  }

  private async readErrors(child: Bun.PipedSubprocess): Promise<void> {
    const stderr = (await new Response(child.stderr).text()).trim();
    if (stderr && !this.closing) console.error(`[relay-worker] ${stderr}`);
  }

  private acceptResponse(line: string): void {
    let response: RelayResponse;
    try {
      response = JSON.parse(line) as RelayResponse;
    } catch {
      this.rejectPending(new RelayWorkerError("invalid_response", "Rust relay worker returned invalid JSON"));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.status === "ok") {
      pending.resolve(response.result);
    } else {
      pending.reject(new RelayWorkerError(response.error.code, response.error.message));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function findWorkerExecutable(): string | null {
  const configured = process.env.VRC_BILI_RELAY_WORKER;
  const candidates = [
    configured,
    resolve(process.cwd(), "target", "debug", "relay-worker.exe"),
    resolve(process.cwd(), "target", "release", "relay-worker.exe"),
    join(dirname(process.execPath), "relay-worker.exe"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function asWorkerError(error: unknown): RelayWorkerError {
  return error instanceof RelayWorkerError
    ? error
    : new RelayWorkerError("worker_io", error instanceof Error ? error.message : String(error));
}
