import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { FFIType, dlopen, ptr } from "bun:ffi";

const FR_PRIVATE = 0x10;
const BUNDLED_FONT_FILES = [
  "MiSansVF.ttf",
  "NotoSerifSC-VF.ttf",
  "CascadiaMono.ttf",
] as const;

const gdi32 = process.platform === "win32"
  ? dlopen("gdi32.dll", {
      AddFontResourceExW: {
        args: [FFIType.ptr, FFIType.uint32_t, FFIType.ptr],
        returns: FFIType.int32_t,
      },
    } as const)
  : null;

let registered = false;

export function registerBundledFonts(): boolean {
  if (registered) return true;
  if (!gdi32) return false;

  let allRegistered = true;
  for (const fontFile of BUNDLED_FONT_FILES) {
    const fontPath = resolveBundledFontPath(fontFile);
    if (!existsSync(fontPath)) {
      allRegistered = false;
      continue;
    }

    const widePath = Buffer.from(`${fontPath}\0`, "utf16le");
    if (gdi32.symbols.AddFontResourceExW(ptr(widePath), FR_PRIVATE, null) <= 0) {
      allRegistered = false;
    }
  }
  registered = allRegistered;
  return allRegistered;
}

function resolveBundledFontPath(fontFile: string): string {
  const executableName = basename(process.execPath).toLowerCase();
  const root = executableName === "bun.exe"
    ? resolve(import.meta.dir, "..", "..")
    : dirname(process.execPath);
  return resolve(root, "assets", "fonts", fontFile);
}
