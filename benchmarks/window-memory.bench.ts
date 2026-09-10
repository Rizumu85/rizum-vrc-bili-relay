// Live-window memory measurements only; no test renderer, actions or assertions.
export {};
process.env.VRC_BILI_RELAY_BACKGROUND = "1";
process.env.VRC_BILI_RELAY_SCENE = "ready-vod";
await import("../src/main");
const started = performance.now();
const sample = () => console.log(JSON.stringify({
  pid: process.pid,
  elapsedSeconds: (performance.now() - started) / 1000,
  rssMB: process.memoryUsage().rss / 1048576,
  heapMB: process.memoryUsage().heapUsed / 1048576,
}));
sample();
const timer = setInterval(sample, 15000);
setTimeout(() => {
  clearInterval(timer);
  sample();
  process.exit(0);
}, Number(process.argv[2] ?? 120) * 1000);
