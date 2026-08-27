import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ThemePreference = "system" | "light" | "dark";
export type LoginMode = "guest" | "account";

export interface StoredSettings {
  host: string;
  key: string;
  playbackUrl: string;
  login: LoginMode;
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  host: "vrcdn.live",
  key: "",
  playbackUrl: "",
  login: "guest",
  theme: "system",
};

function settingsPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? process.cwd();
  return join(localAppData, "VRC Bili Relay", "settings.json");
}

export function readStoredSettings(): StoredSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<StoredSettings> & {
      playbackPrefix?: unknown;
    };
    const legacyPlayback =
      typeof parsed.playbackPrefix === "string" &&
      parsed.playbackPrefix !== "https://stream.vrcdn.live/play/"
        ? parsed.playbackPrefix
        : "";
    return {
      host: typeof parsed.host === "string" ? parsed.host : DEFAULT_SETTINGS.host,
      key: typeof parsed.key === "string" ? parsed.key : DEFAULT_SETTINGS.key,
      playbackUrl:
        typeof parsed.playbackUrl === "string" ? parsed.playbackUrl : legacyPlayback,
      login: parsed.login === "account" ? "account" : "guest",
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : DEFAULT_SETTINGS.theme,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeStoredSettings(settings: StoredSettings): Promise<void> {
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(settings, null, 2)}\n`);
}
