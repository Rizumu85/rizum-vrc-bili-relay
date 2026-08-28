import { closeSync, copyFileSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const executable = resolve(dist, "VRC-Bili-Relay.exe");

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
copyFileSync(
  resolve(root, "assets", "VRCBiliRelay.ico"),
  resolve(dist, "assets", "VRCBiliRelay.ico"),
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
// Bun 1.3.14 accepts --windows-hide-console but still emits subsystem 3.
// Verify and repair the PE header so packaged builds behave like GUI apps.
patchWindowsGuiSubsystem(executable);

function patchWindowsGuiSubsystem(path: string): void {
  const handle = openSync(path, "r+");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(handle, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error("Compiled executable has a truncated DOS header");
    }
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("Compiled executable is not a Windows PE file");
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(96);
    if (readSync(handle, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error("Compiled executable has a truncated PE header");
    }
    if (peHeader.readUInt32LE(0) !== 0x0000_4550) {
      throw new Error("Compiled executable has an invalid PE signature");
    }

    const optionalHeaderMagic = peHeader.readUInt16LE(24);
    if (optionalHeaderMagic !== 0x010b && optionalHeaderMagic !== 0x020b) {
      throw new Error(`Unsupported PE optional header: 0x${optionalHeaderMagic.toString(16)}`);
    }

    const subsystemOffset = peOffset + 24 + 68;
    const subsystem = peHeader.readUInt16LE(24 + 68);
    if (subsystem !== 2 && subsystem !== 3) {
      throw new Error(`Refusing to patch unexpected PE subsystem ${subsystem}`);
    }
    if (subsystem === 3) {
      const windowsGui = Buffer.from([2, 0]);
      if (writeSync(handle, windowsGui, 0, windowsGui.length, subsystemOffset) !== windowsGui.length) {
        throw new Error("Could not update the PE subsystem");
      }
    }

    const verification = Buffer.alloc(2);
    readSync(handle, verification, 0, verification.length, subsystemOffset);
    if (verification.readUInt16LE(0) !== 2) {
      throw new Error("Compiled executable is still marked as a console application");
    }
    console.log("Marked dist/VRC-Bili-Relay.exe as a Windows GUI application");
  } finally {
    closeSync(handle);
  }
}

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
