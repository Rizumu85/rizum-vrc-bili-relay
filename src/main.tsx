import { render } from "@gpuix/react";

import { AppSurface } from "./app";
import type { Appearance } from "./theme";

const initialAppearance: Appearance =
  process.env.VRC_BILI_RELAY_THEME === "dark" ? "dark" : "light";

render(<AppSurface initialAppearance={initialAppearance} />, {
  title: "VRC Bili Relay — GPUIX",
  width: 428,
  height: 478,
  minWidth: 428,
  minHeight: 478,
  resizable: false,
  windowBackground: "blurred",
});
