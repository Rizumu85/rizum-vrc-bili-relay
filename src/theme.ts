export type Appearance = "light" | "dark";

export interface Palette {
  canvas: string;
  panel: string;
  panelEdge: string;
  panelShadow: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  caption: string;
  surface: string;
  surfaceHover: string;
  surfaceActive: string;
  surfaceMuted: string;
  surfaceLine: string;
  nested: string;
  nestedStrong: string;
  accentTeal: string;
  accentViolet: string;
  accentRose: string;
  focus: string;
}

export const FONT_UI = "Noto Sans SC";
export const FONT_SERIF = "Noto Serif SC";
export const FONT_MONO = "Cascadia Mono";

export const PALETTES: Record<Appearance, Palette> = {
  light: {
    canvas: "#F0F0F0",
    panel: "#FAFAFAF5",
    panelEdge: "#FFFFFFD6",
    panelShadow: "#00000012",
    ink: "#18181B",
    inkSoft: "#3F3F46",
    inkMuted: "#71717A",
    caption: "#A1A1AA",
    surface: "#FFFFFF92",
    surfaceHover: "#FFFFFFC2",
    surfaceActive: "#F4F4F5E8",
    surfaceMuted: "#F4F4F5",
    surfaceLine: "#E4E4E7",
    nested: "#FFFFFF58",
    nestedStrong: "#FFFFFFE8",
    accentTeal: "#2DD4BF",
    accentViolet: "#A78BFA",
    accentRose: "#FB7185",
    focus: "#2DD4BF38",
  },
  dark: {
    canvas: "#111113",
    panel: "#27272AF5",
    panelEdge: "#FFFFFF1B",
    panelShadow: "#00000057",
    ink: "#F4F4F5",
    inkSoft: "#D4D4D8",
    inkMuted: "#A1A1AA",
    caption: "#9898A2",
    surface: "#FFFFFF09",
    surfaceHover: "#FFFFFF0E",
    surfaceActive: "#FFFFFF16",
    surfaceMuted: "#3F3F46",
    surfaceLine: "#3F3F46",
    nested: "#FFFFFF07",
    nestedStrong: "#343437FA",
    accentTeal: "#2DD4BF",
    accentViolet: "#A78BFA",
    accentRose: "#FB7185",
    focus: "#2DD4BF2E",
  },
};

export const RADII = {
  control: 8,
  nested: 9,
  compactPanel: 10,
  panel: 20,
  full: 999,
} as const;

