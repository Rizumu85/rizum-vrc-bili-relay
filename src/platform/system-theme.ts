import type { Appearance } from "../theme";

// Windows exposes the app (not taskbar) light/dark choice as a DWORD under the
// current user's Personalize key: 0 = dark, 1 = light. A missing value, a
// non-Windows host or a slow/failed query all resolve to null so callers keep
// their current appearance instead of guessing.
const PERSONALIZE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const REG_QUERY = ["reg.exe", "query", PERSONALIZE_KEY, "/v", "AppsUseLightTheme"];
const REG_QUERY_TIMEOUT_MS = 1_500;

export const SYSTEM_APPEARANCE_SUPPORTED = process.platform === "win32";

function parseAppearance(output: string): Appearance | null {
  const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
  if (!match) return null;
  return Number.parseInt(match[1]!, 16) === 0 ? "dark" : "light";
}

/** Startup read: blocks briefly so the first frame already uses the right palette. */
export function readSystemAppearanceSync(): Appearance | null {
  if (!SYSTEM_APPEARANCE_SUPPORTED) return null;
  try {
    const result = Bun.spawnSync(REG_QUERY, {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      timeout: REG_QUERY_TIMEOUT_MS,
    });
    return result.success ? parseAppearance(result.stdout.toString()) : null;
  } catch {
    return null;
  }
}

export async function readSystemAppearance(): Promise<Appearance | null> {
  if (!SYSTEM_APPEARANCE_SUPPORTED) return null;
  try {
    const child = Bun.spawn(REG_QUERY, {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      timeout: REG_QUERY_TIMEOUT_MS,
    });
    const output = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? parseAppearance(output) : null;
  } catch {
    return null;
  }
}
