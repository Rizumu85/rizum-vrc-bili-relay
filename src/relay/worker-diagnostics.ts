import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcMeasurement } from "./worker-rpc";

const MAX_QUEUE = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const queue: string[] = [];
let writer: Promise<void> | null = null;
let dropped = 0;
let retryAfter = 0;

export const workerDiagnosticsDirectory = process.env.VRC_BILI_RELAY_DIAGNOSTICS_DIR
  || join(process.env.LOCALAPPDATA || process.env.APPDATA || tmpdir(), "VRC Bili Relay", "runtime", "diagnostics");

interface Context { generation: number; worker_pid: number; }

/** Only these metadata fields are persisted. Never pass requests, replies,
 * command arguments, error messages, URLs, cookies, or raw stderr to disk.
 */
export function recordWorkerRpc(context: Context, measurement: RpcMeasurement): void {
  if (queue.length >= MAX_QUEUE || Date.now() < retryAfter) {
    dropped++;
    return;
  }
  const entry: Record<string, string | number> = {
    schema: 1, unix_ms: Date.now(), ui_pid: process.pid,
    worker_pid: context.worker_pid, generation: context.generation,
    event: label(measurement.event), dropped_records: dropped,
  };
  for (const key of ["request_id", "queue_depth", "queue_ms", "elapsed_ms", "bytes", "operation_id", "lease_id", "list_id", "list_revision", "scope_epoch", "settings_revision", "active", "paused", "restored", "accepted_count", "failed_count", "attempt"] as const) {
    const value = measurement[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      entry[key] = Math.round(value * 1000) / 1000;
    }
  }
  if (measurement.command) entry.command = label(measurement.command);
  if (measurement.code) entry.code = label(measurement.code);
  queue.push(`${JSON.stringify(entry)}\n`);
  startWriter();
}

export function recordWorkerStderr(context: Context, line: string): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { /* arbitrary stderr is not persisted */ }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (item.schema === 1 && item.kind === "worker_command"
      && (item.event === "command_started" || item.event === "command_finished")
      && Number.isSafeInteger(item.request_id) && typeof item.command === "string") {
      recordWorkerRpc(context, {
        event: item.event,
        request_id: item.request_id as number,
        command: item.command,
        elapsed_ms: typeof item.elapsed_ms === "number" ? item.elapsed_ms : undefined,
        code: typeof item.code === "string" ? item.code : undefined,
      });
      return;
    }
  }
  recordWorkerRpc(context, { event: "stderr_unstructured", bytes: Buffer.byteLength(line) });
}

// Useful to the measurement runner. Product shutdown never waits for disk I/O.
export async function flushWorkerDiagnostics(): Promise<void> {
  while (writer) await writer;
}

function label(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unclassified";
}

function startWriter(): void {
  if (writer || queue.length === 0) return;
  writer = drain().catch(() => {
    dropped += queue.length;
    queue.length = 0;
    retryAfter = Date.now() + 10_000;
  }).finally(() => {
    writer = null;
    // An entry can arrive between drain's last iteration and this microtask.
    startWriter();
  });
}

async function drain(): Promise<void> {
  await mkdir(workerDiagnosticsDirectory, { recursive: true });
  const path = join(workerDiagnosticsDirectory, "worker-rpc.jsonl");
  const previous = join(workerDiagnosticsDirectory, "worker-rpc.previous.jsonl");
  let size = await stat(path).then((info) => info.size).catch(() => 0);
  while (queue.length) {
    const batch = queue.splice(0, 32);
    const text = batch.join("");
    const bytes = Buffer.byteLength(text);
    try {
      if (size + bytes > MAX_FILE_BYTES) {
        await rm(previous, { force: true });
        await rename(path, previous);
        size = 0;
      }
      await appendFile(path, text, { encoding: "utf8", mode: 0o600 });
      size += bytes;
    } catch (error) {
      dropped += batch.length;
      throw error;
    }
  }
}

/** Local numeric UI evidence shares the bounded writer with transport records.
 * No account IDs, input values, URLs or arbitrary objects are serialized. */
export function recordUiState(event: string, values: Record<string, number> = {}): void {
  recordWorkerRpc({ generation: values.generation ?? 0, worker_pid: 0 }, { ...values, event });
}
