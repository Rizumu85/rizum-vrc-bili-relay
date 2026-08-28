export type Appearance = "light" | "dark";

export interface Palette {
  canvas: string;
  panel: string;
  panelEdge: string;
  panelShadow: string;
  floatingShadow: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  caption: string;
  surface: string;
  surfaceHover: string;
  surfaceActive: string;
  surfaceMuted: string;
  buttonSurface: string;
  buttonHover: string;
  segmentedTrack: string;
  segmentedThumb: string;
  segmentedShadow: string;
  controlShadow: string;
  surfaceLine: string;
  surfaceDivider: string;
  columnDivider: string;
  nested: string;
  nestedStrong: string;
  accentTeal: string;
  accentViolet: string;
  accentRose: string;
  accentDanmaku: string;
  focus: string;
}

export const FONT_UI = "Noto Sans SC";
export const FONT_SERIF = "Noto Serif SC";
export const FONT_MONO = "Cascadia Mono";

export const MOTION = {
  easeOut: [0.23, 1, 0.32, 1] as [number, number, number, number],
  surfaceEnterSeconds: 0.22,
  selectEnterSeconds: 0.22,
  popoverEnterSeconds: 0.18,
  stateCrossfadeSeconds: 0.14,
  segmentedSeconds: 0.24,
} as const;

export const PALETTES: Record<Appearance, Palette> = {
  light: {
    canvas: "#F0F0F0",
    panel: "#FFFFFFF8",
    panelEdge: "#FFFFFF6B",
    panelShadow: "#00000012",
    floatingShadow: "#0000001F",
    ink: "#18181B",
    inkSoft: "#3F3F46",
    inkMuted: "#71717A",
    caption: "#A1A1AA",
    surface: "#FFFFFF85",
    surfaceHover: "#FFFFFFAD",
    surfaceActive: "#F4F4F5E8",
    surfaceMuted: "#F4F4F5",
    buttonSurface: "#FFFFFFD6",
    buttonHover: "#FFFFFFE8",
    segmentedTrack: "#18181B0A",
    segmentedThumb: "#FFFFFFD0",
    segmentedShadow: "#0000000F",
    controlShadow: "#00000005",
    surfaceLine: "#E4E4E7",
    surfaceDivider: "#E4E4E780",
    columnDivider: "#E4E4E78C",
    nested: "#FFFFFF58",
    nestedStrong: "#FFFFFFE8",
    accentTeal: "#2DD4BF",
    accentViolet: "#A78BFA",
    accentRose: "#FB7185",
    accentDanmaku: "#F59E0B",
    focus: "#2DD4BF38",
  },
  dark: {
    canvas: "#111113",
    panel: "#27272AF5",
    panelEdge: "#FFFFFF12",
    panelShadow: "#00000057",
    floatingShadow: "#00000057",
    ink: "#F4F4F5",
    inkSoft: "#D4D4D8",
    inkMuted: "#A1A1AA",
    caption: "#9898A2",
    surface: "#FFFFFF09",
    surfaceHover: "#FFFFFF0E",
    surfaceActive: "#FFFFFF16",
    surfaceMuted: "#3F3F46",
    buttonSurface: "#FFFFFF09",
    buttonHover: "#FFFFFF0E",
    segmentedTrack: "#F4F4F50A",
    segmentedThumb: "#FFFFFF0E",
    segmentedShadow: "#0000000F",
    controlShadow: "#0000000F",
    surfaceLine: "#3F3F46",
    surfaceDivider: "#3F3F4680",
    columnDivider: "#3F3F468C",
    nested: "#FFFFFF07",
    nestedStrong: "#343437FA",
    accentTeal: "#2DD4BF",
    accentViolet: "#A78BFA",
    accentRose: "#FB7185",
    accentDanmaku: "#FBBF24",
    focus: "#2DD4BF2E",
  },
};

export const RADII = {
  control: 8,
  nested: 9,
  compactPanel: 10,
  full: 999,
} as const;
