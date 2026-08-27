import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const build = Bun.spawnSync(["cargo", "build", "--bin", "relay-worker"], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
});
if (build.exitCode !== 0) process.exit(build.exitCode);

const app = Bun.spawn(["bun", "--hot", "src/main.tsx"], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await app.exited);
