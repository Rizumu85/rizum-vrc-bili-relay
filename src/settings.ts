import type { ProductSettings } from "./relay/protocol";

export type {
  ProductSettings,
  SettingsUpdate,
  StreamKeyStatus,
  ThemePreference,
} from "./relay/protocol";

export const DEFAULT_SETTINGS: ProductSettings = {
  host: "vrcdn.live",
  playbackUrl: "",
  theme: "system",
  streamKeyStatus: "missing",
};
