import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};
const releaseRoot = resolve(root, "release");
const packageName = `VRC-Bili-Relay-${manifest.version}-windows-x64`;
const stage = resolve(releaseRoot, packageName);
const archive = resolve(releaseRoot, `${packageName}.zip`);

run(["bun", "run", "build"]);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(resolve(stage, "assets"), { recursive: true });

for (const source of [
  resolve(root, "dist", "VRC-Bili-Relay.exe"),
  resolve(root, "dist", "relay-worker.exe"),
  resolve(root, "LICENSE"),
]) {
  copyFileSync(source, resolve(stage, basename(source)));
}
for (const assetName of ["danmaku-preview-backdrop.png", "VRCBiliRelay.ico"]) {
  copyFileSync(
    resolve(root, "dist", "assets", assetName),
    resolve(stage, "assets", assetName),
  );
}

run(["tar", "-a", "-c", "-f", archive, "-C", releaseRoot, packageName]);

console.log(`Created ${archive}`);

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
