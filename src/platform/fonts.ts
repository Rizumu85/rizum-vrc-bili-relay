import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { FFIType, dlopen, ptr } from "bun:ffi";

const FR_PRIVATE = 0x10;
const UI_FONT_FILE = "MiSansVF.ttf";

const gdi32 = process.platform === "win32"
  ? dlopen("gdi32.dll", {
      AddFontResourceExW: {
        args: [FFIType.ptr, FFIType.uint32_t, FFIType.ptr],
        returns: FFIType.int32_t,
      },
    } as const)
  : null;

let registered = false;

export function registerBundledUiFont(): boolean {
  if (registered) return true;
  if (!gdi32) return false;

  const fontPath = resolveUiFontPath();
  if (!existsSync(fontPath)) return false;

  const widePath = Buffer.from(`${fontPath}\0`, "utf16le");
  registered = gdi32.symbols.AddFontResourceExW(ptr(widePath), FR_PRIVATE, null) > 0;
  return registered;
}

function resolveUiFontPath(): string {
  const executableName = basename(process.execPath).toLowerCase();
  const root = executableName === "bun.exe"
    ? resolve(import.meta.dir, "..", "..")
    : dirname(process.execPath);
  return resolve(root, "assets", "fonts", UI_FONT_FILE);
}
