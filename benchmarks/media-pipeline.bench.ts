/** Real local media measurements, not a functional assertion suite.
 * No accounts, Internet media, user settings, or public stream endpoints.
 * The feature-gated helper calls production Rust builders/process ownership.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = resolve(root, "artifacts/benchmarks/media");
mkdirSync(directory, { recursive: true });
const ffmpeg = process.env.VRC_BILI_RELAY_BENCH_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.VRC_BILI_RELAY_BENCH_FFPROBE ?? "ffprobe";
const helper = process.env.VRC_BILI_RELAY_MEDIA_HELPER ?? join(root, "target/release/examples", process.platform === "win32" ? "media-measurements.exe" : "media-measurements");

async function execute(args: string[], limitMs = 60_000) {
  const started = performance.now();
  const child = Bun.spawn(args, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let deadline = false;
  const timer = setTimeout(() => { deadline = true; child.kill(); }, limitMs);
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { exit, deadline, wall_ms: performance.now() - started, stdout, stderr };
}
async function observe(args: string[]) {
  const result = await execute([helper, ...args], 75_000);
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { data = { malformed_report: result.stdout.slice(0, 2_000) }; }
  return { exit: result.exit, deadline: result.deadline, wall_ms: result.wall_ms, stderr: result.stderr, data };
}
function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port; listener.stop(true); return port;
}
function packetsSummary(raw: string) {
  try {
    const payload = JSON.parse(raw) as { streams?: unknown[]; packets?: { stream_index: number; dts_time?: string; pts_time?: string }[] };
    const byStream = new Map<number, { packets: number; first: number; last: number; backwards: number; largest_gap: number }>();
    for (const packet of payload.packets ?? []) {
      const time = Number(packet.dts_time ?? packet.pts_time);
      if (!Number.isFinite(time)) continue;
      let row = byStream.get(packet.stream_index);
      if (!row) { row = { packets: 0, first: time, last: time, backwards: 0, largest_gap: 0 }; byStream.set(packet.stream_index, row); }
      if (time < row.last) row.backwards++;
      row.largest_gap = Math.max(row.largest_gap, time - row.last); row.last = time; row.packets++;
    }
    return { streams: payload.streams, timeline: Object.fromEntries(byStream) };
  } catch { return { malformed_probe: raw.slice(0, 1_000) }; }
}

const report: Record<string, unknown> = { schema: 1, platform: process.platform, arch: process.arch, revision: process.env.GITHUB_SHA ?? "local", started_at: new Date().toISOString(), scope: "Synthetic loopback HTTP/RTMP plus actual raster observations; not live-service or player acceptance" };
report.ffmpeg = (await execute([ffmpeg, "-version"])).stdout.split("\n")[0];
const av = join(directory, "av.mp4"); const silent = join(directory, "silent.mp4");
const fixtures = [];
fixtures.push(await execute([ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-movflags", "+faststart", av]));
fixtures.push(await execute([ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-i", av, "-an", "-c:v", "copy", "-movflags", "+faststart", silent]));
report.fixture_generation = fixtures;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const file = path === "/av.mp4" ? av : path === "/silent.mp4" ? silent : null;
  if (!file || !existsSync(file)) return new Response("missing", { status: 404 });
  const body = Bun.file(file); const length = body.size;
  const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), length-1) : length-1;
    if (start > end || start >= length) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${length}` } });
    return new Response(body.slice(start,end+1), { status: 206, headers: { "Content-Type":"video/mp4", "Accept-Ranges":"bytes", "Content-Range":`bytes ${start}-${end}/${length}`, "Content-Length":String(end-start+1) } });
  }
  return new Response(body, { headers: { "Content-Type":"video/mp4", "Accept-Ranges":"bytes", "Content-Length":String(length) } });
}});
const port = freePort(); const ingest = `rtmp://127.0.0.1:${port}/live/measurement`;
const capture = join(directory, "publisher.flv");
const receiver = Bun.spawn([ffmpeg,"-hide_banner","-loglevel","warning","-y","-listen","1","-i",ingest,"-c","copy","-f","flv",capture], { stdin:"pipe", stdout:"ignore", stderr:"pipe", windowsHide:true });
const receiverStderr = new Response(receiver.stderr).text();
try {
  await Bun.sleep(600);
  report.pipeline = await observe(["pipeline",ffmpeg,`http://127.0.0.1:${server.port}/av.mp4`,`http://127.0.0.1:${server.port}/silent.mp4`,ingest]);
} finally {
  server.stop(true);
  const timer=setTimeout(()=>receiver.kill(),3_000);
  await receiver.exited; clearTimeout(timer);
  report.receiver_stderr=await receiverStderr;
}
const probe=await execute([ffprobe,"-v","error","-show_streams","-show_packets","-show_entries","packet=stream_index,pts_time,dts_time:stream=index,codec_name,codec_type,width,height,sample_aspect_ratio,sample_rate,channels","-of","json",capture]);
writeFileSync(join(directory,"publisher-packets.json"),probe.stdout);
report.publisher_capture={exit:probe.exit,stderr:probe.stderr,...packetsSummary(probe.stdout)};
const raster=[];
for (const mode of ["vod","live"]) {
  for (const height of ["720","1080"]) raster.push(await observe(["render",ffmpeg,directory,mode,height]));
}
report.raster=raster;
report.finished_at=new Date().toISOString();
writeFileSync(join(root,"artifacts/benchmarks/media-pipeline.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
