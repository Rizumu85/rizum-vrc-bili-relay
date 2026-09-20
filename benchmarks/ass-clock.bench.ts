/** Quantitative observations of actual session rollbacks; no assertion suite.
 * Only synthetic loopback media, isolated account storage and bounded captures.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = resolve(root, "artifacts/benchmarks/ass-clock");
mkdirSync(directory, { recursive: true });
const ffmpeg = process.env.VRC_BILI_RELAY_BENCH_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.VRC_BILI_RELAY_BENCH_FFPROBE ?? "ffprobe";
const helper = process.env.VRC_BILI_RELAY_MEDIA_HELPER ?? join(root, "target/release/examples", process.platform === "win32" ? "media-measurements.exe" : "media-measurements");
const isolated = join(directory, "isolated-account-storage");
mkdirSync(isolated, { recursive: true });

async function execute(args: string[], limitMs = 90_000, diagnostics = directory) {
  const started = performance.now();
  const child = Bun.spawn(args, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: isolated, APPDATA: isolated, XDG_DATA_HOME: isolated, VRC_BILI_RELAY_DIAGNOSTICS_DIR: diagnostics } });
  let deadline = false;
  const timer = setTimeout(() => { deadline = true; child.kill(); }, limitMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, deadline, wall_ms: performance.now() - started, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function observe(args: string[], diagnostics: string) {
  const result = await execute([helper, "ass-clock", ...args], 90_000, diagnostics);
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { data = { malformed_report: result.stdout.slice(0, 2_000) }; }
  return { exit: result.exit, deadline: result.deadline, wall_ms: result.wall_ms, stderr: result.stderr, data };
}
function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port; listener.stop(true); return port;
}
function packetSummary(raw: string) {
  try {
    const input = JSON.parse(raw) as { packets?: { stream_index: number; dts_time?: string }[] };
    const rows: Record<string, { count: number; backwards: number; first: number; last: number; largest_gap: number }> = {};
    for (const packet of input.packets ?? []) {
      const time = Number(packet.dts_time);
      if (!Number.isFinite(time)) continue;
      const row = rows[packet.stream_index] ??= { count: 0, backwards: 0, first: time, last: time, largest_gap: 0 };
      if (time < row.last) row.backwards++;
      row.largest_gap = Math.max(row.largest_gap, time - row.last); row.last = time; row.count++;
    }
    return rows;
  } catch { return { malformed_probe: raw.slice(0, 1_000) }; }
}

const report: Record<string, unknown> = { schema: 1, platform: process.platform, arch: process.arch,
  revision: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(),
  started_at: new Date().toISOString(), scope: "Production MediaSessionStore rate/retarget rollback, pixel-encoded source time; not real-service acceptance" };
report.ffmpeg = (await execute([ffmpeg, "-version"])).stdout.split("\n")[0];
const fixture = join(directory, "source-clock.mp4");
// Marker x=floor(T*6) identifies the original source time in the actual output
// frame. It is independent of worker progress, publisher timestamps and logs.
const source = "nullsrc=s=320x180:r=30,geq=lum='if(between(Y,8,23)*between(X,floor(T*6),floor(T*6)+3),235,16)':cb=128:cr=128";
report.fixture = await execute([ffmpeg,"-hide_banner","-loglevel","warning","-y","-f","lavfi","-i",source,
  "-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","45","-c:v","libx264","-preset","ultrafast",
  "-pix_fmt","yuv420p","-g","30","-c:a","aac","-movflags","+faststart",fixture]);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname !== "/source.mp4" || !existsSync(fixture)) return new Response("missing", { status: 404 });
  const file = Bun.file(fixture); const length = file.size;
  const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]),length-1) : length-1;
    if (start > end || start >= length) return new Response(null, { status:416,headers:{"Content-Range":`bytes */${length}`} });
    return new Response(file.slice(start,end+1),{status:206,headers:{"Content-Type":"video/mp4","Accept-Ranges":"bytes","Content-Range":`bytes ${start}-${end}/${length}`,"Content-Length":String(end-start+1)}});
  }
  return new Response(file,{headers:{"Content-Type":"video/mp4","Accept-Ranges":"bytes","Content-Length":String(length)}});
}});
const cases: unknown[] = [];
try {
  for (const rate of ["1","2","0.5"]) {
    const current = join(directory, `rate-${rate}`); const diagnostics = join(current,"diagnostics");
    mkdirSync(diagnostics,{recursive:true});
    const ingest = `rtmp://127.0.0.1:${freePort()}/live/measurement`;
    const capture = join(current,"capture.flv");
    const receiver = Bun.spawn([ffmpeg,"-hide_banner","-loglevel","warning","-y","-listen","1","-i",ingest,"-c","copy","-f","flv",capture],{stdin:"pipe",stdout:"ignore",stderr:"pipe",windowsHide:true});
    const receiverText = new Response(receiver.stderr).text();
    let pipeline;
    try {
      await Bun.sleep(600);
      pipeline = await observe(["session",ffmpeg,`http://127.0.0.1:${server.port}/source.mp4`,ingest,current,rate],diagnostics);
    } finally {
      const timer = setTimeout(() => receiver.kill(), 3_000);
      try { receiver.stdin.write("q\n"); await receiver.stdin.flush(); } catch { /* already exited */ }
      await receiver.exited; clearTimeout(timer);
    }
    const pixels = existsSync(capture) ? await observe(["capture",ffmpeg,capture],diagnostics) : null;
    const probe = existsSync(capture) ? await execute([ffprobe,"-v","error","-show_packets","-show_entries","packet=stream_index,dts_time","-of","json",capture]) : null;
    const events: any[] = [];
    for (const name of ["relay-health.previous.jsonl","relay-health.jsonl"]) {
      const path = join(diagnostics,name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path,"utf8").split("\n")) { if (line) { try { events.push(JSON.parse(line)); } catch {} } }
    }
    cases.push({rate,pipeline,pixels,receiver_exit:receiver.exitCode,receiver_stderr:await receiverText,
      packets:probe ? packetSummary(probe.stdout) : null,probe_exit:probe?.exit,probe_stderr:probe?.stderr,
      ass_bindings:events.filter(e=>e.event==="ass_bound"),
      publisher_pids:[...new Set(events.filter(e=>e.role==="Media timeline").map(e=>e.metrics.publisher_pid))],
      diagnostic_records:events.length,reported_drops:Math.max(0,...events.map(e=>e.dropped_records??0))});
    // Retain numeric evidence and logs, not large transient synthetic captures.
    rmSync(capture,{force:true});
  }
} finally {
  server.stop(true);
  report.cases=cases; report.finished_at=new Date().toISOString();
  writeFileSync(join(root,"artifacts/benchmarks/ass-clock.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
