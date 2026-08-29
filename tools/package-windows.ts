import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};
// Build beside the canonical local Release. `release/` may be the executable
// the user is actively running, so packaging must never clear or rewrite it.
// Only the post-upload synchronization step replaces that directory.
const packageRoot = resolve(root, "artifacts", "package");
const packageName = `VRC-Bili-Relay-${manifest.version}-windows-x64`;
const stage = resolve(packageRoot, packageName);
const archive = resolve(packageRoot, `${packageName}.zip`);

run(["bun", "run", "build"]);
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(resolve(stage, "assets"), { recursive: true });
mkdirSync(resolve(stage, "assets", "fonts"), { recursive: true });

for (const source of [
  resolve(root, "dist", "VRC-Bili-Relay.exe"),
  resolve(root, "dist", "relay-worker.exe"),
  resolve(root, "LICENSE"),
  resolve(root, "THIRD_PARTY_NOTICES.md"),
]) {
  copyFileSync(source, resolve(stage, basename(source)));
}
for (const fontAssetName of [
  "MiSansVF.ttf",
  "MiSans-License.pdf",
  "NotoSerifSC-VF.ttf",
  "Noto-OFL.txt",
  "CascadiaMono.ttf",
  "Cascadia-OFL.txt",
]) {
  copyFileSync(
    resolve(root, "dist", "assets", "fonts", fontAssetName),
    resolve(stage, "assets", "fonts", fontAssetName),
  );
}
for (const assetName of ["danmaku-preview-backdrop.png", "VRCBiliRelay.ico"]) {
  copyFileSync(
    resolve(root, "dist", "assets", assetName),
    resolve(stage, "assets", assetName),
  );
}

run(["tar", "-a", "-c", "-f", archive, "-C", packageRoot, packageName]);

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
