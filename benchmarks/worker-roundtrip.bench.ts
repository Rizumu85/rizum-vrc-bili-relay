import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RelayWorkerClient } from "../src/relay/worker-client";
import { flushWorkerDiagnostics, workerDiagnosticsDirectory } from "../src/relay/worker-diagnostics";

// Measurement workload only: no network, login, stream target, state writes,
// test runner, or functional assertions. Capture actual worker round trips.
const output = resolve("artifacts", "benchmarks");
await mkdir(output, { recursive: true });
const client = new RelayWorkerClient();
const rows: Record<string, unknown>[] = [];
const started = performance.now();
try {
  const health = await client.health();
  rows.push({ workload: "startup", elapsed_ms: performance.now() - started,
    protocol_version: health.protocol_version, backend_version: health.backend_version });
  for (const concurrency of [1, 8, 32]) {
    const count = 256;
    const latencies: number[] = [];
    const failures: Record<string, number> = {};
    const begin = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const before = performance.now();
        try {
          await client.inspectSource("https://www.bilibili.com/video/BV1UCVn66Eww?p=2");
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
          failures[code] = (failures[code] ?? 0) + 1;
        }
        latencies.push(performance.now() - before);
      }
    }));
    latencies.sort((a, b) => a - b);
    const elapsed = performance.now() - begin;
    const percentile = (fraction: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))];
    rows.push({ workload: "inspect_source", concurrency, requests: count, elapsed_ms: elapsed,
      requests_per_second: count * 1000 / elapsed, p50_ms: percentile(0.5), p95_ms: percentile(0.95),
      p99_ms: percentile(0.99), max_ms: latencies.at(-1), error_counts: failures,
      rss_bytes: process.memoryUsage().rss });
  }
} finally {
  const before = performance.now();
  await client.close();
  rows.push({ workload: "shutdown", elapsed_ms: performance.now() - before });
  await flushWorkerDiagnostics();
}

// Summarize measured spans as well as retaining raw, payload-free JSONL.
const trace = await readFile(resolve(workerDiagnosticsDirectory, "worker-rpc.jsonl"), "utf8").catch(() => "");
const events = trace.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const dispatchCounts: Record<string, number> = {};
for (const entry of events) {
  if (entry.event === "dispatched" && typeof entry.command === "string") {
    dispatchCounts[entry.command] = (dispatchCounts[entry.command] ?? 0) + 1;
  }
}
rows.push({ workload: "recorded_transport", dispatch_counts: dispatchCounts,
  record_count: events.length,
  dropped_records: Math.max(0, ...events.map((entry) => Number(entry.dropped_records) || 0)) });
const report = { schema: 1, platform: process.platform, arch: process.arch,
  bun_version: Bun.version, rows };
await writeFile(resolve(output, "worker-roundtrip.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(output, "worker-rpc.jsonl"), trace);
console.log(JSON.stringify(report, null, 2));
