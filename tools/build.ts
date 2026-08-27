import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

run(["cargo", "build", "--release", "--bin", "relay-worker"]);
mkdirSync(dist, { recursive: true });
copyFileSync(
  resolve(root, "target", "release", "relay-worker.exe"),
  resolve(dist, "relay-worker.exe"),
);
run([
  "bun",
  "build",
  "--compile",
  "src/main.tsx",
  "--outfile",
  "dist/vrc-bili-relay-gpuix.exe",
]);

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
