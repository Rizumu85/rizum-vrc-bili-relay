import { render } from "@gpuix/react";

import { AppSurface, type Scene } from "./app";
import type { ThemePreference } from "./settings-store";
import type { Appearance } from "./theme";

const initialAppearance: Appearance =
  process.env.VRC_BILI_RELAY_THEME === "dark" ? "dark" : "light";
const initialThemePreference: ThemePreference | undefined =
  process.env.VRC_BILI_RELAY_THEME === "dark" || process.env.VRC_BILI_RELAY_THEME === "light"
    ? process.env.VRC_BILI_RELAY_THEME
    : undefined;
const requestedScene = process.env.VRC_BILI_RELAY_SCENE;
const initialScene: Scene =
  requestedScene === "settings" || requestedScene === "danmaku" ? requestedScene : "ready-vod";

render(
  <AppSurface
    initialAppearance={initialAppearance}
    initialThemePreference={initialThemePreference}
    initialScene={initialScene}
  />,
  {
  title: "VRC Bili Relay — GPUIX",
  width: 428,
  height: 478,
  minWidth: 428,
  minHeight: 478,
  resizable: false,
  windowBackground: "blurred",
  },
);
