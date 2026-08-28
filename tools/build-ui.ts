import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

run([
  "powershell",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "tools/generate-app-icon.ps1",
]);
run(["bun", "run", "tools/generate-danmaku-backdrop.ts"]);
mkdirSync(resolve(dist, "assets"), { recursive: true });
copyFileSync(
  resolve(root, "assets", "danmaku-preview-backdrop.png"),
  resolve(dist, "assets", "danmaku-preview-backdrop.png"),
);
run([
  "bun",
  "build",
  "--compile",
  "--windows-hide-console",
  "--no-compile-autoload-dotenv",
  "--windows-icon=assets/VRCBiliRelay.ico",
  "--windows-title=VRC Bili Relay",
  "--windows-publisher=Rizum",
  "--windows-version=0.1.0.0",
  "--windows-description=Convert Bilibili media into VRChat-compatible playback routes",
  "--windows-copyright=Copyright © 2026 Rizum",
  "src/main.tsx",
  "--outfile",
  "dist/VRC-Bili-Relay.exe",
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
