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
  danmaku: {
    enabled: true,
    size: "medium",
    area: "half",
    speed: "normal",
    opacity: 80,
    font: "microsoft_yahei",
    weight: "bold",
    outline: "heavy",
    hidden_types: ["advanced"],
  },
  playbackEndBehavior: "pause",
};
