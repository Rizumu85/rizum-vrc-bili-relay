import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { motion, type EventPayload } from "@gpuix/react";
import * as Select from "@gpuix/react/select";

import { ICONS, type IconName } from "./icons";
import {
  FONT_MONO,
  FONT_SERIF,
  FONT_UI,
  PALETTES,
  RADII,
  type Appearance,
  type Palette,
} from "./theme";
import {
  DEFAULT_SETTINGS,
  type ProductSettings,
  type SettingsUpdate,
  type ThemePreference,
} from "./settings";
import {
  type BilibiliAuthStatus,
  type BilibiliLoginQr,
  type FfmpegStatus,
  type HealthReply,
  type PlaybackOptions,
  type RelayStatus,
  type SourceResolution,
} from "./relay/protocol";
import { RelayWorkerClient, RelayWorkerError } from "./relay/worker-client";

export type Scene = "loading" | "error" | "ready-vod" | "settings" | "danmaku";
type DanmakuVisibility = "shown" | "hidden";
type LoginMode = "guest" | "account";
type DanmakuSize = "small" | "medium" | "large";
type DanmakuArea = "quarter" | "half" | "full";
type DanmakuSpeed = "slow" | "normal" | "fast";
type DanmakuFont = "microsoft-yahei" | "noto-sans-sc" | "source-han-sans" | "simhei";
type DanmakuWeight = "regular" | "bold";
type DanmakuOutline = "heavy" | "outline" | "shadow";
type DanmakuFilter = "rolling" | "fixed" | "colored" | "advanced";
type PlaybackUpdate = "part" | "seek" | "danmaku" | null;
type MediaComponentState =
  | "checking"
  | "external"
  | "missing"
  | "downloading"
  | "managed"
  | "failed"
  | "unavailable";

interface DanmakuSettings {
  size: DanmakuSize;
  area: DanmakuArea;
  speed: DanmakuSpeed;
  opacity: number;
  font: DanmakuFont;
  weight: DanmakuWeight;
  outline: DanmakuOutline;
  hiddenTypes: DanmakuFilter[];
}

interface SettingsDraft {
  host: string;
  key: string;
  playbackUrl: string;
  theme: ThemePreference;
}

const SAMPLE_VIDEO = "https://www.bilibili.com/video/BV1UCVn66Eww?p=2";
const VIDEO_TITLE = "VRChat 播放器入门：从链接到放映";
const VIDEO_OUTPUT = "https://stream.vrcdn.live/play/BV1UCVn66Eww_p{part}.m3u8";
interface PlaybackPart {
  value: string;
  label: string;
  duration: number;
}
const REFERENCE_PARTS: PlaybackPart[] = [
  { value: "1", label: "P1 · 开始之前", duration: 421 },
  { value: "2", label: "P2 · 自动中继与播放器", duration: 754 },
  { value: "3", label: "P3 · 常见问题", duration: 318 },
] as const;
const POSITION_BY_PART: Record<string, number> = { "1": 0, "2": 204, "3": 0 };
const TRACK_WIDTH = 376;
const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
const LOGIN_OPTIONS = [
  { value: "guest", label: "访客" },
  { value: "account", label: "扫码登录" },
] as const;
const VISIBILITY_OPTIONS = [
  { value: "shown", label: "显示" },
  { value: "hidden", label: "隐藏" },
] as const;
const SIZE_OPTIONS = [
  { value: "small", label: "小" },
  { value: "medium", label: "标准" },
  { value: "large", label: "大" },
] as const;
const AREA_OPTIONS = [
  { value: "quarter", label: "1/4 屏" },
  { value: "half", label: "半屏" },
  { value: "full", label: "全屏" },
] as const;
const SPEED_OPTIONS = [
  { value: "slow", label: "慢" },
  { value: "normal", label: "标准" },
  { value: "fast", label: "快" },
] as const;
const FONT_OPTIONS = [
  { value: "microsoft-yahei", label: "微软雅黑" },
  { value: "noto-sans-sc", label: "Noto Sans SC" },
  { value: "source-han-sans", label: "思源黑体" },
  { value: "simhei", label: "黑体" },
] as const;
const WEIGHT_OPTIONS = [
  { value: "regular", label: "常规" },
  { value: "bold", label: "粗体" },
] as const;
const OUTLINE_OPTIONS = [
  { value: "heavy", label: "重墨" },
  { value: "outline", label: "描边" },
  { value: "shadow", label: "45° 投影" },
] as const;
const FILTER_OPTIONS: ReadonlyArray<{ value: DanmakuFilter; label: string }> = [
  { value: "rolling", label: "滚动" },
  { value: "fixed", label: "固定" },
  { value: "colored", label: "彩色" },
  { value: "advanced", label: "高级" },
];
const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  size: "medium",
  area: "half",
  speed: "normal",
  opacity: 80,
  font: "microsoft-yahei",
  weight: "bold",
  outline: "heavy",
  hiddenTypes: ["advanced"],
};

function formatPlaybackTime(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

async function readClipboard(): Promise<string> {
  try {
    const process = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    const output = await new Response(process.stdout).text();
    await process.exited;
    return output.trim();
  } catch {
    return "";
  }
}

async function writeClipboard(value: string): Promise<void> {
  try {
    const process = Bun.spawn(["clip.exe"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    process.stdin.write(value);
    process.stdin.end();
    await process.exited;
  } catch {
    // The output remains selectable even if the Windows clipboard command fails.
  }
}

function relaySettingsReady(settings: ProductSettings): boolean {
  return settings.streamKeyConfigured && Boolean(settings.playbackUrl.trim());
}

function configuredPlaybackOptions(
  visibility: DanmakuVisibility,
  settings: DanmakuSettings,
): PlaybackOptions {
  const font = {
    "microsoft-yahei": "microsoft_yahei",
    "noto-sans-sc": "noto_sans_sc",
    "source-han-sans": "source_han_sans",
    simhei: "simhei",
  } as const;
  return {
    danmaku: {
      enabled: visibility === "shown",
      size: settings.size,
      area: settings.area,
      speed: settings.speed,
      opacity: settings.opacity,
      font: font[settings.font],
      weight: settings.weight,
      outline: settings.outline,
      hidden_types: settings.hiddenTypes,
    },
  };
}

function playbackOptionsSignature(options: PlaybackOptions): string {
  return JSON.stringify(options);
}

function Icon({ name, size, color }: { name: IconName; size: number; color: string }) {
  return (
    <svg
      source={ICONS[name]}
      style={{ width: size, height: size, flexShrink: 0, color }}
    />
  );
}

interface ButtonProps {
  label: string;
  palette: Palette;
  onClick?: () => void;
  icon?: IconName;
  iconColor?: string;
  quiet?: boolean;
  disabled?: boolean;
  width?: number;
  testId?: string;
}

function Button({
  label,
  palette,
  onClick,
  icon,
  iconColor,
  quiet = false,
  disabled = false,
  width,
  testId,
}: ButtonProps) {
  const activate = () => {
    if (!disabled) onClick?.();
  };

  return (
    <div
      testId={testId}
      tabIndex={disabled ? -1 : 0}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "enter" || event.key === "space") activate();
      }}
      style={{
        width,
        height: 30,
        flexShrink: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        paddingLeft: 13,
        paddingRight: 13,
        borderRadius: RADII.control,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.surface,
        boxShadow: {
          offsetX: 0,
          offsetY: 1,
          blurRadius: 2,
          spreadRadius: 0,
          color: palette.panelShadow,
        },
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.48 : 1,
        userSelect: "none",
        hover: disabled
          ? undefined
          : { backgroundColor: palette.surfaceHover, borderColor: palette.surfaceLine },
        active: disabled ? undefined : { backgroundColor: palette.surfaceActive },
      }}
    >
      {icon ? <Icon name={icon} size={11} color={iconColor ?? palette.inkMuted} /> : null}
      <text
        style={{
          color: quiet ? palette.caption : palette.inkSoft,
          fontFamily: FONT_UI,
          fontSize: 12,
          fontWeight: 400,
          lineHeight: 16,
        }}
      >
        {label}
      </text>
    </div>
  );
}

function IconButton({
  name,
  palette,
  color,
  label,
  onClick,
}: {
  name: IconName;
  palette: Palette;
  color?: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <div
      testId={label}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "enter" || event.key === "space") onClick();
      }}
      style={{
        width: 26,
        height: 26,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: RADII.control,
        cursor: "pointer",
        userSelect: "none",
        hover: { backgroundColor: palette.surfaceHover },
        active: { backgroundColor: palette.surfaceActive },
      }}
    >
      <Icon name={name} size={13} color={color ?? palette.inkMuted} />
    </div>
  );
}

function StatusDot({ color }: { color: string }) {
  return (
    <div
      style={{
        width: 5,
        height: 5,
        flexShrink: 0,
        borderRadius: RADII.full,
        backgroundColor: color,
      }}
    />
  );
}

function Header({
  palette,
  scene,
  onSettings,
  onBack,
}: {
  palette: Palette;
  scene: Scene;
  onSettings: () => void;
  onBack: () => void;
}) {
  const isSettings = scene === "settings";
  const isDanmaku = scene === "danmaku";
  const isSubview = isSettings || isDanmaku;
  const title = isSettings ? "设置" : isDanmaku ? "弹幕样式" : "VRC Bili Relay";
  const subtitle = isSettings
    ? "连接、账号与外观"
    : isDanmaku
      ? "调整烧录到画面中的弹幕"
      : "把 B 站链接转换成 VRChat 播放地址";

  return (
    <div
      style={{
        minHeight: isSubview ? 66 : 72,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingTop: isSubview ? 13 : 16,
        paddingRight: 24,
        paddingBottom: isSubview ? 9 : 11,
        paddingLeft: 24,
      }}
    >
      {isSubview ? (
        <IconButton name="back" palette={palette} label="back" onClick={onBack} />
      ) : (
        <div
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="logo" size={18} color={palette.accentRose} />
        </div>
      )}
      <div style={{ minWidth: 0, flexGrow: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <text
          style={{
            color: palette.ink,
            fontFamily: FONT_SERIF,
            fontSize: isSubview ? 19 : 16,
            fontWeight: isSubview ? 700 : 600,
            lineHeight: isSubview ? 24 : 22,
          }}
        >
          {title}
        </text>
        <text
          style={{
            color: palette.caption,
            fontFamily: FONT_UI,
            fontSize: 11,
            fontWeight: 400,
            lineHeight: 16,
          }}
        >
          {subtitle}
        </text>
      </div>
      {!isSubview ? (
        <IconButton name="settings" palette={palette} label="settings" onClick={onSettings} />
      ) : null}
    </div>
  );
}

function SourceField({
  source,
  setSource,
  palette,
}: {
  source: string;
  setSource: (value: string) => void;
  palette: Palette;
}) {
  const paste = async () => {
    const clipboard = await readClipboard();
    setSource(clipboard || SAMPLE_VIDEO);
  };

  return (
    <div
      style={{
        width: "100%",
        height: 32,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingLeft: 10,
        paddingRight: 4,
        borderRadius: RADII.control,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.surface,
        hover: { backgroundColor: palette.surfaceHover },
      }}
    >
      <input
        testId="source-input"
        value={source}
        placeholder="粘贴 B 站或媒体链接"
        onChange={(event) => setSource(event.value ?? "")}
        theme={{ appearance: palette === PALETTES.dark ? "dark" : "light", caret: palette.accentTeal }}
        style={{
          flexGrow: 1,
          minWidth: 0,
          height: 28,
          color: palette.inkSoft,
          fontFamily: FONT_UI,
          fontSize: 12.5,
          lineHeight: 17,
        }}
      />
      <IconButton
        name="clipboard"
        palette={palette}
        label="paste-source"
        onClick={() => void paste()}
      />
    </div>
  );
}

function PartSelect({
  part,
  setPart,
  parts,
  palette,
  disabled,
}: {
  part: string;
  setPart: (value: string) => void;
  parts: PlaybackPart[];
  palette: Palette;
  disabled: boolean;
}) {
  return (
    <Select.Root
      value={part}
      onValueChange={setPart}
      disabled={disabled}
      style={{ flexGrow: 1, minWidth: 0, opacity: disabled ? 0.62 : 1 }}
    >
      <Select.Trigger
        testId="part-select"
        style={({ open, disabled: selectDisabled }) => ({
          width: "100%",
          height: 30,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingLeft: 10,
          paddingRight: 9,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: open ? palette.surfaceLine : palette.panelEdge,
          backgroundColor: open ? palette.surfaceHover : palette.surface,
          cursor: selectDisabled ? "default" : "pointer",
          userSelect: "none",
          hover: { backgroundColor: palette.surfaceHover },
        })}
      >
        <Select.Value>
          <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
            {parts.find((entry) => entry.value === part)?.label ?? parts[0]?.label ?? "P1"}
          </text>
        </Select.Value>
        <Icon name="chevron" size={11} color={palette.caption} />
      </Select.Trigger>
      <Select.Content
        side="bottom"
        sideOffset={6}
        style={{
          width: 328,
          maxHeight: 140,
          padding: 4,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: palette.panelEdge,
          backgroundColor: palette.nestedStrong,
          boxShadow: {
            offsetX: 0,
            offsetY: 12,
            blurRadius: 30,
            spreadRadius: 0,
            color: palette.panelShadow,
          },
        }}
      >
        {parts.map((entry) => (
          <Select.Item
            key={entry.value}
            value={entry.value}
            style={({ selected, highlighted }) => ({
              minHeight: 28,
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 7,
              cursor: "pointer",
              backgroundColor: highlighted ? palette.surfaceHover : "#00000000",
              opacity: selected ? 1 : 0.9,
            })}
          >
            <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
              {entry.label}
            </text>
            {entry.value === part ? <Icon name="check" size={10} color={palette.accentTeal} /> : null}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function SeekControl({
  duration,
  position,
  onPositionChange,
  onPositionCommit,
  onInteractionChange,
  disabled,
  palette,
}: {
  duration: number;
  position: number;
  onPositionChange: (value: number) => void;
  onPositionCommit: (value: number) => void;
  onInteractionChange: (active: boolean) => void;
  disabled: boolean;
  palette: Palette;
}) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const positionRef = useRef(position);
  const maximum = Math.max(0, duration - 1);
  const visiblePosition = Math.max(0, Math.min(maximum, position));
  positionRef.current = visiblePosition;

  const updatePosition = (value: number) => {
    const next = Math.max(0, Math.min(maximum, Math.round(value)));
    positionRef.current = next;
    onPositionChange(next);
    return next;
  };

  const setFromPointer = (event: EventPayload) => {
    const localX = Math.max(0, Math.min(TRACK_WIDTH, (event.x ?? 26) - 26));
    return updatePosition((localX / TRACK_WIDTH) * maximum);
  };

  const finishInteraction = (position = positionRef.current) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    onInteractionChange(false);
    onPositionCommit(position);
  };

  const seekKeys = ["left", "right", "pageup", "pagedown", "home", "end"];
  const ratio = duration > 0 ? visiblePosition / duration : 0;
  const thumbLeft = Math.round((TRACK_WIDTH - 12) * ratio);

  return (
    <div style={{ width: TRACK_WIDTH, paddingTop: 4, opacity: disabled ? 0.58 : 1 }}>
      <div
        testId="seek-control"
        tabIndex={0}
        onMouseDown={(event) => {
          if (disabled || event.button !== 0) return;
          draggingRef.current = true;
          setDragging(true);
          onInteractionChange(true);
          setFromPointer(event);
        }}
        onMouseMove={(event) => {
          if (!disabled && draggingRef.current) setFromPointer(event);
        }}
        onMouseUp={(event) => {
          if (disabled || event.button !== 0 || !draggingRef.current) return;
          finishInteraction(setFromPointer(event));
        }}
        onMouseLeave={() => {
          if (draggingRef.current) finishInteraction();
        }}
        onKeyDown={(event) => {
          if (disabled || !event.key || !seekKeys.includes(event.key)) return;
          const step = event.modifiers?.shift ? 10 : 1;
          if (event.key === "left") updatePosition(positionRef.current - step);
          if (event.key === "right") updatePosition(positionRef.current + step);
          if (event.key === "pageup") updatePosition(positionRef.current + 10);
          if (event.key === "pagedown") updatePosition(positionRef.current - 10);
          if (event.key === "home") updatePosition(0);
          if (event.key === "end") updatePosition(maximum);
        }}
        onKeyUp={(event) => {
          if (!disabled && event.key && seekKeys.includes(event.key)) {
            onPositionCommit(positionRef.current);
          }
        }}
        style={{
          width: TRACK_WIDTH,
          height: 28,
          position: "relative",
          cursor: disabled ? "default" : dragging ? "grabbing" : "pointer",
          userSelect: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 13,
            left: 0,
            width: TRACK_WIDTH,
            height: 2,
            borderRadius: RADII.full,
            backgroundColor: palette.surfaceLine,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 8,
            left: thumbLeft,
            width: 12,
            height: 12,
            borderRadius: RADII.full,
            backgroundColor: palette.caption,
            boxShadow: {
              offsetX: 0,
              offsetY: 0,
              blurRadius: dragging ? 14 : 8,
              spreadRadius: dragging ? 4 : 2,
              color: appearanceShadow(palette),
            },
          }}
        />
      </div>
      <div style={{ width: TRACK_WIDTH, display: "flex", flexDirection: "row", justifyContent: "space-between" }}>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 10 }}>
          {formatPlaybackTime(visiblePosition)}
        </text>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 10 }}>
          {formatPlaybackTime(duration)}
        </text>
      </div>
    </div>
  );
}

function appearanceShadow(palette: Palette): string {
  return palette === PALETTES.dark ? "#00000052" : "#A1A1AA3D";
}

function Segmented<T extends string>({
  value,
  onChange,
  palette,
  options,
  width,
  height = 28,
}: {
  value: T;
  onChange: (value: T) => void;
  palette: Palette;
  options: ReadonlyArray<{ value: T; label: string }>;
  width: number;
  height?: number;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const inset = 2;
  const thumbWidth = (width - inset * 2) / options.length;

  return (
    <div
      style={{
        width,
        height,
        position: "relative",
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        padding: inset,
        borderRadius: RADII.control,
        backgroundColor: palette.surfaceMuted,
      }}
    >
      <motion.div
        animate={{
          left: inset + selectedIndex * thumbWidth,
          width: thumbWidth,
          top: inset,
          height: height - inset * 2,
          borderRadius: 6,
        }}
        transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
        style={{
          position: "absolute",
          backgroundColor: palette.nestedStrong,
          boxShadow: {
            offsetX: 0,
            offsetY: 1,
            blurRadius: 3,
            spreadRadius: 0,
            color: palette.panelShadow,
          },
          pointerEvents: "none",
        }}
      />
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <div
            key={option.value}
            tabIndex={0}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "enter" || event.key === "space") onChange(option.value);
            }}
            style={{
              width: thumbWidth,
              height: height - inset * 2,
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <text
              style={{
                color: selected ? palette.inkSoft : palette.caption,
                fontFamily: FONT_UI,
                fontSize: 10.5,
              }}
            >
              {option.label}
            </text>
          </div>
        );
      })}
    </div>
  );
}

interface QrRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function qrRectangles(qr: BilibiliLoginQr): QrRectangle[] {
  const modules = Array.from({ length: qr.size }, () => Array<boolean>(qr.size).fill(false));
  const pattern = /M(\d+) (\d+)h1v1h-1z/g;
  for (const match of qr.path.matchAll(pattern)) {
    const x = Number.parseInt(match[1] ?? "-1", 10);
    const y = Number.parseInt(match[2] ?? "-1", 10);
    if (x >= 0 && x < qr.size && y >= 0 && y < qr.size) modules[y]![x] = true;
  }

  const rectangles: QrRectangle[] = [];
  let active = new Map<string, QrRectangle>();
  for (let y = 0; y < qr.size; y += 1) {
    const row = modules[y]!;
    const next = new Map<string, QrRectangle>();
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const width = x - start;
      const key = `${start}:${width}`;
      const previous = active.get(key);
      next.set(
        key,
        previous
          ? { ...previous, height: previous.height + 1 }
          : { x: start, y, width, height: 1 },
      );
    }
    for (const [key, rectangle] of active) {
      if (!next.has(key)) rectangles.push(rectangle);
    }
    active = next;
  }
  rectangles.push(...active.values());
  return rectangles;
}

function BilibiliQrCode({ qr }: { qr: BilibiliLoginQr }) {
  const quietZone = 4;
  const moduleSize = Math.max(2, Math.floor(132 / (qr.size + quietZone * 2)));
  const side = (qr.size + quietZone * 2) * moduleSize;
  const rectangles = useMemo(() => qrRectangles(qr), [qr.path, qr.size]);
  return (
    <div
      style={{
        width: side,
        height: side,
        flexShrink: 0,
        position: "relative",
        backgroundColor: "#FFFFFF",
      }}
    >
      {rectangles.map((rectangle, index) => (
        <div
          key={`${rectangle.x}:${rectangle.y}:${index}`}
          style={{
            position: "absolute",
            left: (rectangle.x + quietZone) * moduleSize,
            top: (rectangle.y + quietZone) * moduleSize,
            width: rectangle.width * moduleSize,
            height: rectangle.height * moduleSize,
            backgroundColor: "#18181B",
          }}
        />
      ))}
    </div>
  );
}

function BilibiliLoginPopover({
  auth,
  error,
  busy,
  palette,
  onBegin,
  onDismiss,
}: {
  auth: BilibiliAuthStatus | null;
  error: string | null;
  busy: boolean;
  palette: Palette;
  onBegin: () => void;
  onDismiss: () => void;
}) {
  const statusText = error
    ? error
    : auth?.stage === "scanned"
      ? "已扫码，请在手机上确认"
      : auth?.stage === "expired"
        ? "二维码已失效"
        : auth?.qr
          ? "请使用哔哩哔哩 App 扫码"
          : "正在生成二维码";

  return (
    <motion.div
      initial={{ opacity: 0, top: 96 }}
      animate={{ opacity: 1, top: 100 }}
      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      onMouseDownOutside={onDismiss}
      style={{
        width: 210,
        position: "absolute",
        right: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 9,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.nestedStrong,
        boxShadow: {
          offsetX: 0,
          offsetY: 16,
          blurRadius: 36,
          spreadRadius: 0,
          color: palette.panelShadow,
        },
      }}
    >
      <text
        style={{
          alignSelf: "flex-start",
          color: palette.ink,
          fontFamily: FONT_SERIF,
          fontSize: 11.5,
          fontWeight: 600,
        }}
      >
        用哔哩哔哩 App 扫码
      </text>
      {auth?.qr ? (
        <div
          style={{
            width: 140,
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9,
            backgroundColor: "#FFFFFF",
          }}
        >
          <BilibiliQrCode qr={auth.qr} />
        </div>
      ) : (
        <div
          style={{
            width: 140,
            height: 76,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9,
            backgroundColor: palette.surfaceMuted,
          }}
        >
          <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10.5 }}>
            {busy ? "正在生成" : "二维码不可用"}
          </text>
        </div>
      )}
      <div style={{ minHeight: 17, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
        <StatusDot color={error || auth?.stage === "expired" ? palette.accentRose : palette.accentTeal} />
        <text style={{ color: error ? palette.inkMuted : palette.caption, fontFamily: FONT_UI, fontSize: 10.5 }}>
          {statusText}
        </text>
      </div>
      {error || auth?.stage === "expired" ? (
        <Button label="重新生成" palette={palette} disabled={busy} onClick={onBegin} />
      ) : null}
      <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 9.5 }}>
        登录信息只在本次运行中使用
      </text>
    </motion.div>
  );
}

function Result({
  palette,
  part,
  onPartChange,
  playbackPosition,
  onPlaybackPositionChange,
  onPlaybackPositionCommit,
  onSeekInteractionChange,
  playbackUpdating,
  playbackMessage,
  danmaku,
  onDanmakuChange,
  onOpenDanmaku,
  onOpenSettings,
  onStopRelay,
  sourceResolution,
  relayStatus,
  relayError,
  relayStopping,
}: {
  palette: Palette;
  part: string;
  onPartChange: (part: string) => void;
  playbackPosition: number;
  onPlaybackPositionChange: (position: number) => void;
  onPlaybackPositionCommit: (position: number) => void;
  onSeekInteractionChange: (active: boolean) => void;
  playbackUpdating: PlaybackUpdate;
  playbackMessage: string | null;
  danmaku: DanmakuVisibility;
  onDanmakuChange: (value: DanmakuVisibility) => void;
  onOpenDanmaku: () => void;
  onOpenSettings: () => void;
  onStopRelay: () => void;
  sourceResolution: SourceResolution | null;
  relayStatus: RelayStatus | null;
  relayError: string | null;
  relayStopping: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isReference = sourceResolution === null;
  const output = isReference
    ? VIDEO_OUTPUT.replace("{part}", part)
    : relayOutputDescription(sourceResolution, relayStatus, relayError);
  const relayRunning = relayStatus?.stage === "running" && Boolean(relayStatus.playback_url);
  const directReady = sourceResolution?.routing.kind === "direct" && Boolean(sourceResolution.playback_url);
  const canCopy = isReference || relayRunning || directReady;
  const parts: PlaybackPart[] = sourceResolution?.kind === "video" && sourceResolution.parts?.length
    ? sourceResolution.parts.map((entry) => ({
        value: String(entry.page),
        label: `P${entry.page} · ${entry.title}`,
        duration: entry.duration_seconds,
      }))
    : REFERENCE_PARTS;
  const isLive = sourceResolution?.kind === "live";
  const showPlaybackControls = isReference || sourceResolution?.kind === "video";
  const showDanmakuControls = isReference
    || sourceResolution?.kind === "video"
    || sourceResolution?.kind === "live";
  const playbackDuration = parts.find((entry) => entry.value === part)?.duration ?? 0;
  const sourceKindLabel = sourceResolution?.kind === "media"
    ? "媒体"
    : !isLive
      ? "视频"
      : sourceResolution?.live_status === "live"
        ? "直播"
        : sourceResolution?.live_status === "replay"
          ? "轮播"
          : "未开播";

  const copy = async () => {
    if (!canCopy) return;
    await writeClipboard(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      style={{
        position: "relative",
        marginTop: 18,
        paddingTop: 16,
        borderTopWidth: 1,
        borderColor: palette.surfaceLine,
      }}
    >
      <div style={{ height: 16, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusDot color={palette.accentViolet} />
        <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 11.5, fontWeight: 600 }}>
          {isReference || relayRunning || directReady ? "VRChat 播放地址" : "媒体路由"}
        </text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 9.5 }}>
          {sourceKindLabel}
        </text>
        <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 9.5 }}>
          {resultStatusLabel(
            isReference,
            sourceResolution,
            relayStatus,
            relayError,
            playbackUpdating,
            playbackMessage,
          )}
        </text>
      </div>

      <text
        style={{
          marginTop: 13,
          color: palette.ink,
          fontFamily: FONT_SERIF,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 20,
        }}
      >
        {sourceResolution?.title ?? VIDEO_TITLE}
      </text>

      {showPlaybackControls ? (
        <>
          <div style={{ marginTop: 9, display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
            <text style={{ width: 42, color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11 }}>
              分 P
            </text>
            <PartSelect
              part={part}
              setPart={onPartChange}
              parts={parts}
              palette={palette}
              disabled={playbackUpdating !== null}
            />
          </div>

          <div style={{ marginTop: 5, paddingLeft: 2, paddingRight: 2 }}>
            <SeekControl
              duration={playbackDuration}
              position={playbackPosition}
              onPositionChange={onPlaybackPositionChange}
              onPositionCommit={onPlaybackPositionCommit}
              onInteractionChange={onSeekInteractionChange}
              disabled={playbackUpdating !== null}
              palette={palette}
            />
          </div>
        </>
      ) : null}

      {showDanmakuControls ? (
        <div
          style={{
            position: "relative",
            minHeight: 30,
            marginTop: 15,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
          }}
        >
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusDot color={danmaku === "shown" ? palette.accentTeal : palette.surfaceLine} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11.5 }}>弹幕</text>
          </div>
          <Segmented
            value={danmaku}
            onChange={onDanmakuChange}
            options={VISIBILITY_OPTIONS}
            width={92}
            height={24}
            palette={palette}
          />
          <Button label="样式" palette={palette} onClick={onOpenDanmaku} />
        </div>
      ) : null}

      <div
        style={{
          minHeight: 32,
          marginTop: 13,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingTop: 2,
          paddingRight: 3,
          paddingBottom: 2,
          paddingLeft: 10,
          borderRadius: RADII.nested,
          backgroundColor: palette.nested,
        }}
      >
        <Icon
          name="link"
          size={11}
          color={sourceResolution?.routing.kind === "unavailable" ? palette.accentViolet : palette.accentTeal}
        />
        <text
          style={{
            minWidth: 0,
            flexGrow: 1,
            color: palette.inkSoft,
            fontFamily: FONT_MONO,
            fontSize: 10,
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {output}
        </text>
        {canCopy ? (
          <IconButton
            name={copied ? "check" : "copy"}
            palette={palette}
            color={copied ? palette.accentTeal : palette.inkMuted}
            label="copy-output"
            onClick={() => void copy()}
          />
        ) : null}
        {!isReference && (relayStatus?.stage === "starting" || relayStatus?.stage === "running") ? (
          <Button
            label={relayStopping ? "停止中" : "停止"}
            palette={palette}
            quiet
            disabled={relayStopping || playbackUpdating !== null}
            onClick={onStopRelay}
          />
        ) : null}
        {!isReference && relayError && sourceResolution?.routing.kind !== "unavailable" ? (
          <Button label="设置" palette={palette} quiet onClick={onOpenSettings} />
        ) : null}
      </div>
    </div>
  );
}

function resultStatusLabel(
  isReference: boolean,
  source: SourceResolution | null,
  relay: RelayStatus | null,
  relayError: string | null,
  playbackUpdating: PlaybackUpdate,
  playbackMessage: string | null,
): string {
  if (isReference) return "· 中继运行中 · 请保持开启";
  if (source?.routing.kind === "unavailable") return "· 当前无法生成地址";
  if (source?.routing.kind === "direct" && source.playback_url) return "· 可直接播放 · 软件可关闭";
  if (playbackUpdating === "part") return "· 正在切换分 P";
  if (playbackUpdating === "seek") return "· 正在跳转";
  if (playbackUpdating === "danmaku") return "· 正在更新弹幕";
  if (playbackMessage) return `· ${playbackMessage}`;
  if (relayError && !relay) return "· 需要完成设置";
  switch (relay?.stage) {
    case "starting":
      return "· 正在连接 VRCDN";
    case "running":
      return "· 中继运行中 · 请保持开启";
    case "completed":
      return "· 视频播放完成";
    case "stopped":
      return "· 中继已停止";
    case "failed":
      return "· 中继启动失败";
    default:
      return "· 媒体已探测 · 等待中继";
  }
}

function relayOutputDescription(
  source: SourceResolution,
  relay: RelayStatus | null,
  relayError: string | null,
): string {
  if (source.routing.kind === "direct" && source.playback_url) return source.playback_url;
  if (relay?.stage === "running" && relay.playback_url) return relay.playback_url;
  if (relay?.stage === "starting") return "正在启动 FFmpeg 并连接 VRCDN";
  if (relay?.stage === "completed") return "视频已播放完成";
  if (relay?.stage === "stopped") return "中继已停止，重新生成地址即可再次启动";
  if (relay?.stage === "failed") return relayError ?? "中继启动失败，检查设置后再试";
  return relayError ?? routeDescription(source);
}

function routeDescription(source: SourceResolution): string {
  switch (source.routing.reason) {
    case "source_offline":
      return "直播间未开播，暂时无法生成播放地址";
    case "source_replay":
      return "当前是轮播，暂不支持生成播放地址";
    case "dash_tracks":
      return "已找到 H.264 DASH 视频和音频，需要 FFmpeg 中继";
    case "flv_container":
      return "已找到 H.264 FLV 直播流，需要 FFmpeg 转换";
    case "mpeg_ts_container":
      return "已找到 H.264 MPEG-TS 直播流，需要 FFmpeg 中继";
    case "requires_headers":
      return "已找到媒体流，需要本软件中继";
    case "expiring_url":
      return "媒体地址带有时效签名，需要本软件中继";
    case "direct_compatible":
      return "媒体流可以直接播放";
  }
}

function SectionHeading({
  title,
  subtitle,
  compact = false,
  flush = false,
  palette,
}: {
  title: string;
  subtitle: string;
  compact?: boolean;
  flush?: boolean;
  palette: Palette;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: flush ? 0 : compact ? 9 : 12 }}>
      <text
        style={{
          color: palette.inkMuted,
          fontFamily: FONT_SERIF,
          fontSize: 11.5,
          fontWeight: 600,
          lineHeight: 15,
        }}
      >
        {title}
      </text>
      <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10, lineHeight: 14 }}>
        {subtitle}
      </text>
    </div>
  );
}

function SettingsInput({
  value,
  onChange,
  placeholder,
  palette,
  mono = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  palette: Palette;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.value ?? "")}
      theme={{ appearance: palette === PALETTES.dark ? "dark" : "light", caret: palette.accentTeal }}
      style={{
        width: "100%",
        height: 30,
        paddingLeft: 10,
        paddingRight: 10,
        color: palette.inkSoft,
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        borderRadius: RADII.control,
        fontFamily: mono ? FONT_MONO : FONT_UI,
        fontSize: mono ? 10.5 : 11.5,
        lineHeight: 16,
      }}
    />
  );
}

function Field({
  label,
  palette,
  help,
  children,
}: {
  label: string;
  palette: Palette;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ height: 14, display: "flex", flexDirection: "row", alignItems: "center", gap: 3 }}>
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10, lineHeight: 14 }}>
          {label}
        </text>
        {help}
      </div>
      {children}
    </div>
  );
}

function HelpButton({
  palette,
  kind,
  align = "start",
}: {
  palette: Palette;
  kind: "relay" | "media";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const relay = kind === "relay";

  return (
    <div style={{ width: 16, height: 16, position: "relative" }}>
      <div
        tabIndex={0}
        testId={`help-${kind}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "enter" || event.key === "space") setOpen((value) => !value);
          if (event.key === "escape") setOpen(false);
        }}
        style={{
          width: 16,
          height: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 5,
          cursor: "pointer",
          hover: { backgroundColor: palette.surfaceHover },
          active: { backgroundColor: palette.surfaceActive },
        }}
      >
        <Icon name="help" size={11} color={palette.caption} />
      </div>
      {open ? (
        <motion.div
          initial={{ opacity: 0, top: 18 }}
          animate={{ opacity: 1, top: 22 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          style={{
            width: 238,
            position: "absolute",
            left: align === "start" ? 0 : undefined,
            right: align === "end" ? 0 : undefined,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: palette.panelEdge,
            backgroundColor: palette.nestedStrong,
            boxShadow: {
              offsetX: 0,
              offsetY: 16,
              blurRadius: 36,
              spreadRadius: 0,
              color: palette.panelShadow,
            },
          }}
        >
          <text style={{ color: palette.ink, fontFamily: FONT_SERIF, fontSize: 11.5, fontWeight: 600 }}>
            {relay ? "什么时候需要？" : "为什么需要 FFmpeg？"}
          </text>
          {relay ? (
            <>
              <HelpRow color={palette.accentViolet} palette={palette}>
                需要　FLV、无法直放、转码或开启弹幕
              </HelpRow>
              <HelpRow color={palette.accentTeal} palette={palette}>
                不需要　链接可直接播放，并且弹幕关闭
              </HelpRow>
              <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10, lineHeight: 14 }}>
                自动模式会按内容判断是否使用中继。
              </text>
            </>
          ) : (
            <>
              <HelpRow color={palette.accentViolet} palette={palette}>
                用于转换无法直接播放的视频，或者给视频内置弹幕
              </HelpRow>
              <HelpRow color={palette.accentTeal} palette={palette}>
                电脑已有 FFmpeg？则无需重复下载
              </HelpRow>
            </>
          )}
        </motion.div>
      ) : null}
    </div>
  );
}

function HelpRow({
  color,
  palette,
  children,
}: {
  color: string;
  palette: Palette;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <div style={{ paddingTop: 5 }}>
        <StatusDot color={color} />
      </div>
      <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 10.5, lineHeight: 15 }}>
        {children}
      </text>
    </div>
  );
}

function CompactSelect<T extends string>({
  value,
  onChange,
  options,
  width,
  palette,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  width: number;
  palette: Palette;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as T)} style={{ width }}>
      <Select.Trigger
        style={({ open }) => ({
          width,
          height: 30,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 10,
          paddingRight: 9,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: open ? palette.surfaceLine : palette.panelEdge,
          backgroundColor: open ? palette.surfaceHover : palette.surface,
          cursor: "pointer",
          hover: { backgroundColor: palette.surfaceHover },
        })}
      >
        <Select.Value>
          <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
            {selected?.label ?? ""}
          </text>
        </Select.Value>
        <Icon name="chevron" size={10} color={palette.caption} />
      </Select.Trigger>
      <Select.Content
        side="bottom"
        sideOffset={5}
        style={{
          width,
          maxHeight: 132,
          padding: 4,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: palette.panelEdge,
          backgroundColor: palette.nestedStrong,
          boxShadow: {
            offsetX: 0,
            offsetY: 12,
            blurRadius: 30,
            spreadRadius: 0,
            color: palette.panelShadow,
          },
        }}
      >
        {options.map((option) => (
          <Select.Item
            key={option.value}
            value={option.value}
            style={({ highlighted }) => ({
              minHeight: 28,
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 7,
              cursor: "pointer",
              backgroundColor: highlighted ? palette.surfaceHover : "#00000000",
            })}
          >
            <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
              {option.label}
            </text>
            {option.value === value ? <Icon name="check" size={10} color={palette.accentTeal} /> : null}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function OpacitySlider({
  value,
  onChange,
  palette,
}: {
  value: number;
  onChange: (value: number) => void;
  palette: Palette;
}) {
  const width = 228;
  const [dragging, setDragging] = useState(false);
  const update = (event: EventPayload) => {
    const localX = Math.max(0, Math.min(width, (event.x ?? 108) - 108));
    const raw = 20 + (localX / width) * 80;
    onChange(Math.max(20, Math.min(100, Math.round(raw / 5) * 5)));
  };
  const ratio = (value - 20) / 80;

  return (
    <div style={{ width: 276, height: 28, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
      <div
        tabIndex={0}
        onMouseDown={(event) => {
          setDragging(true);
          update(event);
        }}
        onMouseMove={(event) => {
          if (dragging || event.pressedButton === 0) update(event);
        }}
        onMouseUp={() => setDragging(false)}
        onKeyDown={(event) => {
          if (event.key === "left") onChange(Math.max(20, value - 5));
          if (event.key === "right") onChange(Math.min(100, value + 5));
        }}
        style={{ width, height: 24, position: "relative", cursor: dragging ? "grabbing" : "pointer" }}
      >
        <div
          style={{
            width,
            height: 2,
            position: "absolute",
            top: 11,
            left: 0,
            borderRadius: RADII.full,
            backgroundColor: palette.surfaceLine,
          }}
        />
        <motion.div
          animate={{ left: Math.round((width - 12) * ratio), top: 6, width: 12, height: 12, borderRadius: 999 }}
          transition={{ duration: dragging ? 0 : 0.14, ease: "easeOut" }}
          style={{
            position: "absolute",
            backgroundColor: palette.caption,
            boxShadow: {
              offsetX: 0,
              offsetY: 0,
              blurRadius: dragging ? 14 : 8,
              spreadRadius: dragging ? 4 : 2,
              color: appearanceShadow(palette),
            },
          }}
        />
      </div>
      <div style={{ width: 40, display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 1 }}>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 8.5 }}>{value}</text>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 8.5 }}>%</text>
      </div>
    </div>
  );
}

function DanmakuView({
  palette,
  visibility,
  setVisibility,
  settings,
  setSettings,
}: {
  palette: Palette;
  visibility: DanmakuVisibility;
  setVisibility: (value: DanmakuVisibility) => void;
  settings: DanmakuSettings;
  setSettings: React.Dispatch<React.SetStateAction<DanmakuSettings>>;
}) {
  const fontFamily =
    settings.font === "microsoft-yahei"
      ? "Microsoft YaHei"
      : settings.font === "noto-sans-sc"
        ? "Noto Sans SC"
        : settings.font === "source-han-sans"
          ? "Source Han Sans SC"
          : "SimHei";
  const previewSize = settings.size === "small" ? 11 : settings.size === "large" ? 15 : 13;
  const update = <K extends keyof DanmakuSettings>(key: K, value: DanmakuSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const toggleFilter = (filter: DanmakuFilter) =>
    setSettings((current) => ({
      ...current,
      hiddenTypes: current.hiddenTypes.includes(filter)
        ? current.hiddenTypes.filter((value) => value !== filter)
        : [...current.hiddenTypes, filter],
    }));

  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        overflowY: "scroll",
        paddingTop: 10,
        paddingRight: 24,
        paddingBottom: 16,
        paddingLeft: 24,
      }}
    >
      <div style={{ minHeight: 42, display: "flex", flexDirection: "row", alignItems: "center", gap: 16 }}>
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <SectionHeading title="显示弹幕" subtitle="弹幕会直接烧录到中继画面中" compact flush palette={palette} />
        </div>
        <Segmented
          value={visibility}
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
          width={112}
          height={28}
          palette={palette}
        />
      </div>

      {visibility === "hidden" ? (
        <motion.div
          initial={{ opacity: 0, top: 5 }}
          animate={{ opacity: 1, top: 0 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          style={{
            marginTop: 14,
            padding: 11,
            borderRadius: RADII.nested,
            backgroundColor: palette.nested,
          }}
        >
          <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11 }}>
            当前地址不会包含弹幕。
          </text>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0, top: 5 }}
          animate={{ opacity: 1, top: 0 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          style={{ marginTop: 12 }}
        >
          <div
            style={{
              height: 66,
              position: "relative",
              overflow: "hidden",
              borderRadius: 10,
              backgroundColor: "#202024",
              boxShadow: {
                offsetX: 0,
                offsetY: 8,
                blurRadius: 20,
                spreadRadius: 0,
                color: "#00000018",
              },
            }}
          >
            <text
              style={{
                position: "absolute",
                top: 14,
                right: 18,
                color: "#FFFFFFF4",
                fontFamily,
                fontSize: previewSize,
                fontWeight: settings.weight === "bold" ? 700 : 400,
                opacity: settings.opacity / 100,
              }}
            >
              这条弹幕会显示在画面上
            </text>
            <text
              style={{
                position: "absolute",
                top: 39,
                right: 77,
                color: "#FFFFFFDD",
                fontFamily,
                fontSize: Math.max(10, previewSize - 1),
                fontWeight: settings.weight === "bold" ? 700 : 400,
                opacity: Math.max(0.3, settings.opacity / 130),
              }}
            >
              VRChat 一起看
            </text>
          </div>

          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <DanmakuRow label="字体大小" palette={palette}>
              <Segmented value={settings.size} onChange={(value) => update("size", value)} options={SIZE_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="显示区域" palette={palette}>
              <Segmented value={settings.area} onChange={(value) => update("area", value)} options={AREA_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="滚动速度" palette={palette}>
              <Segmented value={settings.speed} onChange={(value) => update("speed", value)} options={SPEED_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="不透明度" palette={palette}>
              <OpacitySlider value={settings.opacity} onChange={(value) => update("opacity", value)} palette={palette} />
            </DanmakuRow>

            <div style={{ height: 1, marginTop: 3, marginRight: 8, marginBottom: 3, marginLeft: 8, backgroundColor: palette.surfaceLine, opacity: 0.5 }} />

            <DanmakuRow label="弹幕字体" palette={palette}>
              <CompactSelect value={settings.font} onChange={(value) => update("font", value)} options={FONT_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="字重" palette={palette}>
              <Segmented value={settings.weight} onChange={(value) => update("weight", value)} options={WEIGHT_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="描边类型" palette={palette}>
              <Segmented value={settings.outline} onChange={(value) => update("outline", value)} options={OUTLINE_OPTIONS} width={296} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="隐藏类型" palette={palette}>
              <div style={{ width: 296, display: "flex", flexDirection: "row", gap: 5 }}>
                {FILTER_OPTIONS.map((option) => {
                  const selected = settings.hiddenTypes.includes(option.value);
                  return (
                    <div
                      key={option.value}
                      tabIndex={0}
                      onClick={() => toggleFilter(option.value)}
                      onKeyDown={(event) => {
                        if (event.key === "enter" || event.key === "space") toggleFilter(option.value);
                      }}
                      style={{
                        width: 70,
                        height: 28,
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        color: selected ? palette.inkSoft : palette.caption,
                        backgroundColor: selected ? palette.surfaceMuted : "#00000000",
                        borderWidth: 1,
                        borderColor: selected ? palette.surfaceLine : "#00000000",
                        borderRadius: RADII.control,
                        cursor: "pointer",
                        hover: { backgroundColor: palette.surfaceHover },
                      }}
                    >
                      <StatusDot color={selected ? palette.accentRose : palette.surfaceLine} />
                      <text style={{ color: selected ? palette.inkSoft : palette.caption, fontFamily: FONT_UI, fontSize: 10.5 }}>
                        {option.label}
                      </text>
                    </div>
                  );
                })}
              </div>
            </DanmakuRow>
          </div>
        </motion.div>
      )}
    </div>
  );
}

function DanmakuRow({
  label,
  palette,
  children,
}: {
  label: string;
  palette: Palette;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: 28, display: "flex", flexDirection: "row", alignItems: "center", gap: 12 }}>
      <text style={{ width: 72, color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11 }}>
        {label}
      </text>
      {children}
    </div>
  );
}

function SettingsView({
  palette,
  themePreference,
  setThemePreference,
  bilibiliAuth,
  bilibiliAuthError,
  bilibiliAuthBusy,
  onBeginBilibiliLogin,
  onLogoutBilibili,
  storedSettings,
  settingsError,
  onSaveSettings,
  mediaState,
  mediaStatus,
  onInstallFfmpeg,
}: {
  palette: Palette;
  themePreference: ThemePreference;
  setThemePreference: (value: ThemePreference) => void;
  bilibiliAuth: BilibiliAuthStatus | null;
  bilibiliAuthError: string | null;
  bilibiliAuthBusy: boolean;
  onBeginBilibiliLogin: () => void;
  onLogoutBilibili: () => void;
  storedSettings: ProductSettings;
  settingsError: string | null;
  onSaveSettings: (settings: SettingsUpdate) => Promise<ProductSettings>;
  mediaState: MediaComponentState;
  mediaStatus: FfmpegStatus | null;
  onInstallFfmpeg: () => void;
}) {
  const [settings, setSettings] = useState<SettingsDraft>({
    host: storedSettings.host,
    key: "",
    playbackUrl: storedSettings.playbackUrl,
    theme: themePreference,
  });
  const [keyDirty, setKeyDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountAuthenticated = bilibiliAuth?.stage === "authenticated";
  const accountPending = bilibiliAuth?.stage === "waiting" || bilibiliAuth?.stage === "scanned";
  const loginMode: LoginMode = accountAuthenticated || accountPending ? "account" : "guest";

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (accountAuthenticated) setAccountPopoverOpen(false);
  }, [accountAuthenticated]);

  useEffect(() => {
    setSettings({
      host: storedSettings.host,
      key: "",
      playbackUrl: storedSettings.playbackUrl,
      theme: storedSettings.theme,
    });
    setKeyDirty(false);
    setSaveError(null);
  }, [
    storedSettings.host,
    storedSettings.playbackUrl,
    storedSettings.theme,
  ]);

  const update = (key: "host" | "key" | "playbackUrl", value: string) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const updateTheme = (theme: ThemePreference) => {
    setSettings((current) => ({ ...current, theme }));
    setThemePreference(theme);
  };
  const updateLogin = (next: LoginMode) => {
    if (next === "guest") {
      setAccountPopoverOpen(false);
      if (bilibiliAuth && bilibiliAuth.stage !== "guest") onLogoutBilibili();
      return;
    }
    if (accountAuthenticated) return;
    setAccountPopoverOpen(true);
    if (!accountPending) onBeginBilibiliLogin();
  };
  const reset = () => {
    setSettings({
      host: DEFAULT_SETTINGS.host,
      key: "",
      playbackUrl: DEFAULT_SETTINGS.playbackUrl,
      theme: DEFAULT_SETTINGS.theme,
    });
    setKeyDirty(true);
    setSaveError(null);
    setThemePreference("system");
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const persisted = await onSaveSettings({
        host: settings.host,
        playbackUrl: settings.playbackUrl,
        theme: settings.theme,
        ...(keyDirty ? { streamKey: settings.key } : {}),
      });
      setSettings({
        host: persisted.host,
        key: "",
        playbackUrl: persisted.playbackUrl,
        theme: persisted.theme,
      });
      setKeyDirty(false);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1200);
    } catch (error) {
      setSaveError(relayErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        position: "relative",
        overflowY: "scroll",
        paddingTop: 16,
        paddingRight: 24,
        paddingBottom: 20,
        paddingLeft: 24,
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", gap: 16 }}>
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <SectionHeading title="VRCDN" subtitle="自动模式只在需要中继时使用" palette={palette} />
          <div style={{ display: "flex", flexDirection: "row", gap: 8 }}>
            <div style={{ width: 88 }}>
              <Field label="服务器" palette={palette}>
                <SettingsInput value={settings.host} onChange={(value) => update("host", value)} palette={palette} />
              </Field>
            </div>
            <div style={{ minWidth: 0, flexGrow: 1 }}>
              <Field
                label="推流密钥"
                palette={palette}
                help={<HelpButton kind="relay" align="end" palette={palette} />}
              >
                <SettingsInput
                  value={settings.key}
                  onChange={(value) => {
                    update("key", value);
                    setKeyDirty(true);
                  }}
                  placeholder={storedSettings.streamKeyConfigured && !keyDirty ? "已保存" : "未设置"}
                  palette={palette}
                />
              </Field>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Field label="播放地址" palette={palette}>
              <SettingsInput
                value={settings.playbackUrl}
                onChange={(value) => update("playbackUrl", value)}
                placeholder="从 VRCDN Live 页面复制"
                mono
                palette={palette}
              />
            </Field>
          </div>
          <div style={{ height: 18, marginTop: 7, display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}>
            <StatusDot color={palette.accentTeal} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 10.5 }}>服务可用</text>
            <div style={{ flexGrow: 1 }} />
            <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10.5 }}>本机保存</text>
          </div>
        </div>

        <div
          style={{
            width: 140,
            flexShrink: 0,
            position: "relative",
            paddingLeft: 14,
            borderLeftWidth: 1,
            borderColor: palette.surfaceLine,
          }}
        >
          <SectionHeading
            title="B 站账号"
            subtitle={
              bilibiliAuth?.stage === "authenticated"
                ? `已登录 · ${bilibiliAuth.display_name ?? "Bilibili 用户"}`
                : "公开内容可直接使用访客模式"
            }
            compact
            palette={palette}
          />
          <Segmented
            value={loginMode}
            onChange={updateLogin}
            options={LOGIN_OPTIONS}
            width={126}
            palette={palette}
          />
          <div style={{ height: 1, marginTop: 16, marginRight: 8, marginBottom: 16, marginLeft: 8, backgroundColor: palette.surfaceLine, opacity: 0.5 }} />
          <SectionHeading title="外观" subtitle="跟随系统会自动切换明暗" compact palette={palette} />
          <Segmented value={themePreference} onChange={updateTheme} options={THEME_OPTIONS} width={126} palette={palette} />
        </div>
      </div>

      <div
        style={{
          minHeight: 62,
          marginTop: 17,
          paddingTop: 13,
          paddingLeft: 8,
          paddingRight: 8,
          borderTopWidth: 1,
          borderColor: palette.surfaceLine,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ width: 72, display: "flex", flexDirection: "row", alignItems: "center", gap: 3 }}>
          <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 11.5, fontWeight: 600 }}>
            视频处理
          </text>
          <HelpButton kind="media" palette={palette} />
        </div>
        <div style={{ minWidth: 0, flexGrow: 1, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}>
            <StatusDot color={mediaStateDotColor(mediaState, palette)} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 10.5, whiteSpace: "nowrap" }}>
              {mediaStateLabel(mediaState)}
            </text>
          </div>
          <text style={{ marginLeft: 12, color: palette.caption, fontFamily: FONT_UI, fontSize: 10 }}>
            {mediaStateCaption(mediaState, mediaStatus)}
          </text>
        </div>
        {mediaState === "missing" || mediaState === "failed" ? (
          <Button
            label={mediaState === "failed" ? "重试下载" : "下载 FFmpeg"}
            icon="download"
            palette={palette}
            onClick={onInstallFfmpeg}
          />
        ) : mediaState === "downloading" ? (
          <Button label="下载中" icon="download" palette={palette} disabled />
        ) : null}
      </div>

      <div
        style={{
          minHeight: 46,
          marginTop: 15,
          paddingTop: 13,
          borderTopWidth: 1,
          borderColor: palette.surfaceLine,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Button label="恢复默认" icon="reset" palette={palette} quiet onClick={reset} />
        <Button
          label={saving ? "保存中" : saved ? "已保存" : "保存"}
          icon={saved ? "check" : "save"}
          iconColor={saved ? palette.accentTeal : palette.accentRose}
          palette={palette}
          disabled={saving}
          onClick={() => void save()}
        />
        <div style={{ flexGrow: 1 }} />
        <text
          style={{
            maxWidth: 190,
            color: saveError || settingsError ? palette.accentRose : palette.caption,
            fontFamily: FONT_UI,
            fontSize: 10.5,
            lineClamp: 1,
          }}
        >
          {saveError ?? settingsError ?? "配置只保存在本机"}
        </text>
      </div>
      {accountPopoverOpen ? (
        <BilibiliLoginPopover
          auth={bilibiliAuth}
          error={bilibiliAuthError}
          busy={bilibiliAuthBusy}
          palette={palette}
          onBegin={onBeginBilibiliLogin}
          onDismiss={() => setAccountPopoverOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Loading({ palette }: { palette: Palette }) {
  return (
    <div style={{ marginTop: 18, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 2 }}>
        {[0.45, 0.65, 0.85].map((opacity, index) => (
          <div
            key={index}
            style={{
              width: 3,
              height: 3,
              borderRadius: RADII.full,
              backgroundColor: palette.inkMuted,
              opacity,
            }}
          />
        ))}
      </div>
      <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11 }}>正在读取链接</text>
    </div>
  );
}

export interface AppSurfaceProps {
  initialScene?: Scene;
  initialAppearance?: Appearance;
  initialThemePreference?: ThemePreference;
}

export function AppSurface({
  initialScene = "ready-vod",
  initialAppearance = "light",
  initialThemePreference,
}: AppSurfaceProps) {
  const [scene, setScene] = useState<Scene>(initialScene);
  const [lastMainScene, setLastMainScene] = useState<Scene>(
    initialScene === "settings" || initialScene === "danmaku" ? "ready-vod" : initialScene,
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    () => initialThemePreference ?? DEFAULT_SETTINGS.theme,
  );
  const [productSettings, setProductSettings] = useState<ProductSettings>(() => ({
    ...DEFAULT_SETTINGS,
    theme: initialThemePreference ?? DEFAULT_SETTINGS.theme,
  }));
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [source, setSource] = useState(SAMPLE_VIDEO);
  const [part, setPart] = useState("2");
  const [playbackPosition, setPlaybackPosition] = useState(POSITION_BY_PART["2"] ?? 0);
  const [playbackUpdating, setPlaybackUpdating] = useState<PlaybackUpdate>(null);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
  const [seekInteractionActive, setSeekInteractionActive] = useState(false);
  const [danmaku, setDanmaku] = useState<DanmakuVisibility>("shown");
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(DEFAULT_DANMAKU_SETTINGS);
  const [sourceResolution, setSourceResolution] = useState<SourceResolution | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [relayStopping, setRelayStopping] = useState(false);
  const [conversionError, setConversionError] = useState("链接无法识别，检查后再试。");
  const [mediaStatus, setMediaStatus] = useState<FfmpegStatus | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [bilibiliAuth, setBilibiliAuth] = useState<BilibiliAuthStatus | null>(null);
  const [bilibiliAuthError, setBilibiliAuthError] = useState<string | null>(null);
  const [bilibiliAuthBusy, setBilibiliAuthBusy] = useState(false);
  const relayWorker = useRef<RelayWorkerClient | null>(null);
  const conversionEpoch = useRef(0);
  const playbackEpoch = useRef(0);
  const appliedPlaybackOptions = useRef<string | null>(null);
  const sceneBeforeConversion = useRef<Scene>(initialScene);
  const resolvedAppearance: Appearance =
    themePreference === "system" ? initialAppearance : themePreference;
  const palette = PALETTES[resolvedAppearance];
  const mediaState = mediaComponentState(mediaStatus, mediaError);

  const getRelayWorker = () => {
    relayWorker.current ??= new RelayWorkerClient();
    return relayWorker.current;
  };

  const applyProductSettings = (next: ProductSettings): ProductSettings => {
    const visible = initialThemePreference
      ? { ...next, theme: initialThemePreference }
      : next;
    setProductSettings(visible);
    setSettingsReady(true);
    if (!initialThemePreference) setThemePreference(visible.theme);
    return visible;
  };

  const refreshProductSettings = async (): Promise<ProductSettings> => {
    setSettingsError(null);
    try {
      return applyProductSettings(await getRelayWorker().getSettings());
    } catch (error) {
      setSettingsReady(true);
      setSettingsError(relayErrorMessage(error));
      return productSettings;
    }
  };

  const saveProductSettings = async (
    next: SettingsUpdate,
  ): Promise<ProductSettings> => {
    setSettingsError(null);
    try {
      const saved = applyProductSettings(await getRelayWorker().saveSettings(next));
      setThemePreference(saved.theme);
      return saved;
    } catch (error) {
      setSettingsError(relayErrorMessage(error));
      throw error;
    }
  };

  const refreshMediaState = async () => {
    setMediaStatus(null);
    setMediaError(null);
    try {
      const health: HealthReply = await getRelayWorker().health();
      setMediaStatus(health.ffmpeg);
    } catch (error) {
      setMediaError(relayErrorMessage(error));
    }
  };

  const applyBilibiliAuth = (next: BilibiliAuthStatus) => {
    setBilibiliAuth((current) => {
      if (next.qr || current?.login_id !== next.login_id) return next;
      const qr = current?.qr;
      return qr ? { ...next, qr } : next;
    });
  };

  const refreshBilibiliAuth = async () => {
    setBilibiliAuthError(null);
    try {
      applyBilibiliAuth(await getRelayWorker().bilibiliAuthStatus());
    } catch (error) {
      setBilibiliAuthError(relayErrorMessage(error));
    }
  };

  const beginBilibiliLogin = async () => {
    if (bilibiliAuthBusy) return;
    setBilibiliAuthBusy(true);
    setBilibiliAuthError(null);
    try {
      applyBilibiliAuth(await getRelayWorker().beginBilibiliLogin());
    } catch (error) {
      setBilibiliAuthError(relayErrorMessage(error));
    } finally {
      setBilibiliAuthBusy(false);
    }
  };

  const logoutBilibili = async () => {
    if (bilibiliAuthBusy) return;
    setBilibiliAuthBusy(true);
    setBilibiliAuthError(null);
    try {
      applyBilibiliAuth(await getRelayWorker().logoutBilibili());
    } catch (error) {
      setBilibiliAuthError(relayErrorMessage(error));
    } finally {
      setBilibiliAuthBusy(false);
    }
  };

  const installFfmpeg = async () => {
    setMediaError(null);
    try {
      const status = await getRelayWorker().ensureFfmpeg();
      setMediaStatus(status);
    } catch (error) {
      setMediaError(relayErrorMessage(error));
    }
  };

  useEffect(() => {
    const startup = setTimeout(() => {
      void refreshProductSettings();
      if (initialScene === "settings") {
        void refreshMediaState();
        void refreshBilibiliAuth();
      }
    }, 0);
    return () => {
      clearTimeout(startup);
      conversionEpoch.current += 1;
      playbackEpoch.current += 1;
      if (relayWorker.current) void relayWorker.current.close();
    };
  }, []);

  useEffect(() => {
    if (
      !bilibiliAuth?.login_id ||
      (bilibiliAuth.stage !== "waiting" && bilibiliAuth.stage !== "scanned")
    ) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loginId = bilibiliAuth.login_id;
    const poll = async () => {
      try {
        const next = await getRelayWorker().pollBilibiliLogin(loginId);
        if (cancelled) return;
        setBilibiliAuthError(null);
        applyBilibiliAuth(next);
        if (next.stage === "waiting" || next.stage === "scanned") {
          timer = setTimeout(poll, 1400);
        }
      } catch (error) {
        if (cancelled) return;
        setBilibiliAuthError(relayErrorMessage(error));
        if (
          error instanceof RelayWorkerError &&
          error.code === "bilibili_login_session_not_found"
        ) {
          applyBilibiliAuth({ stage: "expired" });
          return;
        }
        timer = setTimeout(poll, 2500);
      }
    };
    timer = setTimeout(poll, 1200);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bilibiliAuth?.login_id, bilibiliAuth?.stage]);

  useEffect(() => {
    if (mediaStatus?.availability !== "installing") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const health = await getRelayWorker().health();
        if (!cancelled) {
          setMediaStatus(health.ffmpeg);
          if (health.ffmpeg.availability === "installing") {
            timer = setTimeout(poll, 500);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMediaStatus(null);
          setMediaError(relayErrorMessage(error));
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mediaStatus?.availability]);

  useEffect(() => {
    if (!relayStatus || (relayStatus.stage !== "starting" && relayStatus.stage !== "running")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const latest = await getRelayWorker().relayStatus(relayStatus.session_id);
        if (!cancelled) {
          setRelayStatus(latest);
          if (latest.position_seconds !== undefined && !seekInteractionActive && playbackUpdating === null) {
            setPlaybackPosition(latest.position_seconds);
          }
          if (latest.stage === "failed") setRelayError("中继启动失败，检查设置后再试。");
          if (latest.stage === "starting" || latest.stage === "running") {
            timer = setTimeout(poll, latest.stage === "starting" ? 700 : 2000);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setRelayError(relayErrorMessage(error));
          timer = setTimeout(poll, 2000);
        }
      }
    };
    timer = setTimeout(poll, relayStatus.stage === "starting" ? 700 : 2000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [relayStatus?.session_id, relayStatus?.stage, seekInteractionActive, playbackUpdating]);

  const convert = async () => {
    const epoch = ++conversionEpoch.current;
    playbackEpoch.current += 1;
    sceneBeforeConversion.current = scene;
    setConversionError("链接无法识别，检查后再试。");
    setRelayError(null);
    setPlaybackUpdating(null);
    setPlaybackMessage(null);
    setSeekInteractionActive(false);
    appliedPlaybackOptions.current = null;
    setScene("loading");
    try {
      if (relayStatus && (relayStatus.stage === "starting" || relayStatus.stage === "running")) {
        await getRelayWorker().stopRelay(relayStatus.session_id);
      }
      setRelayStatus(null);
      const resolution = await getRelayWorker().resolveSource(source);
      if (conversionEpoch.current !== epoch) return;
      setSourceResolution(resolution);
      if (resolution.selected_part) setPart(String(resolution.selected_part));
      setPlaybackPosition(0);
      setScene("ready-vod");
      if (resolution.routing.kind !== "unavailable" && resolution.session_id) {
        const runtimeSettings = settingsReady
          ? productSettings
          : await refreshProductSettings();
        if (conversionEpoch.current !== epoch) return;
        if (!relaySettingsReady(runtimeSettings)) {
          setRelayError("先在设置中填写推流密钥和 VRCDN 播放地址。");
          return;
        }
        try {
          const options = configuredPlaybackOptions(danmaku, danmakuSettings);
          const started = await getRelayWorker().startRelay(resolution.session_id, options);
          if (conversionEpoch.current === epoch) {
            appliedPlaybackOptions.current = playbackOptionsSignature(options);
            setRelayStatus(started);
            if (started.position_seconds !== undefined) setPlaybackPosition(started.position_seconds);
          }
        } catch (error) {
          if (conversionEpoch.current === epoch) setRelayError(relayErrorMessage(error));
        }
      }
    } catch (error) {
      if (conversionEpoch.current !== epoch) return;
      setConversionError(relayErrorMessage(error));
      setScene("error");
    }
  };

  const retargetPlayback = async (
    requestedPart: number,
    startSeconds: number,
    update: Exclude<PlaybackUpdate, null>,
    options = configuredPlaybackOptions(danmaku, danmakuSettings),
  ) => {
    const previousResolution = sourceResolution;
    const canRetarget = previousResolution?.kind === "video"
      || (previousResolution?.kind === "live" && update === "danmaku");
    if (!previousResolution || !canRetarget || playbackUpdating !== null) return;

    const isLiveDanmakuUpdate = previousResolution.kind === "live";
    const effectivePart = isLiveDanmakuUpdate ? 1 : requestedPart;
    const effectiveStart = isLiveDanmakuUpdate ? 0 : startSeconds;

    const epoch = ++playbackEpoch.current;
    const previousPart = part;
    const previousPosition = playbackPosition;
    const previousRelay = relayStatus;
    const previousWasActive = previousRelay?.stage === "starting" || previousRelay?.stage === "running";

    setPlaybackUpdating(update);
    setPlaybackMessage(null);
    setRelayError(null);
    setPart(String(effectivePart));
    setPlaybackPosition(effectiveStart);

    try {
      const runtimeSettings = settingsReady
        ? productSettings
        : await refreshProductSettings();
      if (playbackEpoch.current !== epoch) return;
      if (!relaySettingsReady(runtimeSettings)) {
        if (previousWasActive) {
          setPart(previousPart);
          setPlaybackPosition(previousPosition);
          setPlaybackMessage("需要先完成 VRCDN 设置");
          return;
        }
        const resolution = await getRelayWorker().resolveSource(
          previousResolution.canonical_url,
          effectivePart,
        );
        if (playbackEpoch.current !== epoch) return;
        setSourceResolution(resolution);
        setPart(String(resolution.selected_part ?? effectivePart));
        setRelayStatus(null);
        setRelayError("先在设置中填写推流密钥和 VRCDN 播放地址。");
        return;
      }

      const playback = await getRelayWorker().retargetRelay(
        previousWasActive ? previousRelay?.session_id : undefined,
        previousResolution.canonical_url,
        effectivePart,
        options,
        effectiveStart,
      );
      if (playbackEpoch.current !== epoch) {
        await getRelayWorker().stopRelay(playback.relay.session_id).catch(() => undefined);
        return;
      }

      setSourceResolution(playback.resolution);
      setPart(String(playback.resolution.selected_part ?? effectivePart));
      setPlaybackPosition(playback.relay.position_seconds ?? effectiveStart);
      setRelayStatus(playback.relay);
      setRelayError(null);
      setPlaybackMessage(null);
      appliedPlaybackOptions.current = playbackOptionsSignature(options);
    } catch (error) {
      if (playbackEpoch.current !== epoch) return;
      setPart(previousPart);
      setPlaybackPosition(previousPosition);
      const originalRestored = previousWasActive
        && !(error instanceof RelayWorkerError && error.code === "retarget_restore_failed");
      if (originalRestored) {
        setRelayStatus(previousRelay);
        setRelayError(null);
        setPlaybackMessage(
          update === "part"
            ? "切换失败 · 原内容仍在播放"
            : update === "seek"
              ? "跳转失败 · 原内容仍在播放"
              : "弹幕更新失败 · 原内容仍在播放",
        );
      } else {
        setRelayStatus(null);
        setRelayError(relayErrorMessage(error));
        setPlaybackMessage(
          update === "part"
            ? "切换失败 · 请重试"
            : update === "seek"
              ? "跳转失败 · 请重试"
              : "弹幕更新失败 · 请重试",
        );
      }
    } finally {
      if (playbackEpoch.current === epoch) setPlaybackUpdating(null);
    }
  };

  const changePart = (nextPart: string) => {
    if (sourceResolution === null) {
      setPart(nextPart);
      setPlaybackPosition(POSITION_BY_PART[nextPart] ?? 0);
      return;
    }
    const requestedPart = Number.parseInt(nextPart, 10);
    if (
      sourceResolution.kind !== "video"
      || !Number.isFinite(requestedPart)
      || nextPart === part
    ) return;
    void retargetPlayback(requestedPart, 0, "part");
  };

  const commitPlaybackPosition = (position: number) => {
    setPlaybackPosition(position);
    if (sourceResolution?.kind !== "video") return;
    const requestedPart = sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
    void retargetPlayback(requestedPart, position, "seek");
  };

  const changeDanmakuVisibility = (next: DanmakuVisibility) => {
    if (next === danmaku || playbackUpdating !== null) return;
    setDanmaku(next);
    const active = relayStatus?.stage === "starting" || relayStatus?.stage === "running";
    const supportsDanmaku = sourceResolution?.kind === "video" || sourceResolution?.kind === "live";
    if (!active || !supportsDanmaku || !sourceResolution) return;
    const isLive = sourceResolution.kind === "live";
    const requestedPart = isLive
      ? 1
      : sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
    void retargetPlayback(
      requestedPart,
      isLive ? 0 : playbackPosition,
      "danmaku",
      configuredPlaybackOptions(next, danmakuSettings),
    );
  };

  const stopRelay = async () => {
    if (!relayStatus || relayStopping) return;
    setRelayStopping(true);
    setPlaybackMessage(null);
    try {
      const stopped = await getRelayWorker().stopRelay(relayStatus.session_id);
      setRelayStatus(stopped);
      setRelayError(null);
    } catch (error) {
      setRelayError(relayErrorMessage(error));
    } finally {
      setRelayStopping(false);
    }
  };

  const cancelConversion = () => {
    conversionEpoch.current += 1;
    const previous = sceneBeforeConversion.current;
    setScene(previous === "loading" || previous === "settings" || previous === "danmaku" ? "ready-vod" : previous);
  };

  const showSubview = (next: "settings" | "danmaku") => {
    conversionEpoch.current += 1;
    if (scene !== "settings" && scene !== "danmaku") setLastMainScene(scene);
    setScene(next);
    if (next === "settings") {
      if (!settingsReady || settingsError) void refreshProductSettings();
      void refreshMediaState();
      void refreshBilibiliAuth();
    }
  };

  const leaveSubview = () => {
    const returnScene = lastMainScene === "settings" || lastMainScene === "danmaku"
      ? "ready-vod"
      : lastMainScene;
    const active = relayStatus?.stage === "starting" || relayStatus?.stage === "running";
    const options = configuredPlaybackOptions(danmaku, danmakuSettings);
    const shouldApplyDanmaku = scene === "danmaku"
      && active
      && (sourceResolution?.kind === "video" || sourceResolution?.kind === "live")
      && appliedPlaybackOptions.current !== playbackOptionsSignature(options);
    setScene(returnScene);
    if (shouldApplyDanmaku && sourceResolution) {
      const isLive = sourceResolution.kind === "live";
      const requestedPart = isLive
        ? 1
        : sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
      void retargetPlayback(requestedPart, isLive ? 0 : playbackPosition, "danmaku", options);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: RADII.panel,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.panel,
        boxShadow: {
          offsetX: 0,
          offsetY: 20,
          blurRadius: 60,
          spreadRadius: 0,
          color: palette.panelShadow,
        },
      }}
    >
      <Header
        palette={palette}
        scene={scene}
        onSettings={() => showSubview("settings")}
        onBack={leaveSubview}
      />
      <div
        style={{
          height: 1,
          marginLeft: 24,
          marginRight: 24,
          backgroundColor: palette.surfaceLine,
          opacity: 0.5,
        }}
      />
      {scene === "settings" ? (
        <SettingsView
          palette={palette}
          themePreference={themePreference}
          setThemePreference={setThemePreference}
          bilibiliAuth={bilibiliAuth}
          bilibiliAuthError={bilibiliAuthError}
          bilibiliAuthBusy={bilibiliAuthBusy}
          onBeginBilibiliLogin={() => void beginBilibiliLogin()}
          onLogoutBilibili={() => void logoutBilibili()}
          storedSettings={productSettings}
          settingsError={settingsError}
          onSaveSettings={saveProductSettings}
          mediaState={mediaState}
          mediaStatus={mediaStatus}
          onInstallFfmpeg={() => void installFfmpeg()}
        />
      ) : scene === "danmaku" ? (
        <DanmakuView
          palette={palette}
          visibility={danmaku}
          setVisibility={setDanmaku}
          settings={danmakuSettings}
          setSettings={setDanmakuSettings}
        />
      ) : (
        <div style={{ flexGrow: 1, minHeight: 0, paddingTop: 16, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 }}>
          <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 11.5, fontWeight: 600 }}>
            视频链接
          </text>
          <div style={{ marginTop: 7 }}>
            <SourceField source={source} setSource={setSource} palette={palette} />
          </div>
          <div style={{ minHeight: 30, marginTop: 9, display: "flex", flexDirection: "row", alignItems: "center", gap: 9 }}>
            <Button
              label="生成地址"
              palette={palette}
              icon="play"
              iconColor={palette.accentTeal}
              onClick={() => void convert()}
              disabled={scene === "loading" || playbackUpdating !== null}
              testId="convert-source"
            />
            {scene === "loading" ? <Loading palette={palette} /> : null}
            {scene === "loading" ? (
              <div style={{ flexGrow: 1, display: "flex", justifyContent: "flex-end" }}>
                <Button label="取消" palette={palette} quiet onClick={cancelConversion} />
              </div>
            ) : null}
          </div>

          {scene === "error" ? (
            <div
              style={{
                minHeight: 34,
                marginTop: 14,
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingLeft: 10,
                paddingRight: 5,
                borderRadius: RADII.compactPanel,
                backgroundColor: palette.nested,
              }}
            >
              <StatusDot color={palette.accentRose} />
              <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11 }}>
                {conversionError}
              </text>
              <div style={{ flexGrow: 1 }} />
              <Button label="重试" palette={palette} quiet onClick={() => void convert()} />
            </div>
          ) : null}

          {scene === "ready-vod" ? (
            <Result
              palette={palette}
              part={part}
              onPartChange={changePart}
              playbackPosition={playbackPosition}
              onPlaybackPositionChange={setPlaybackPosition}
              onPlaybackPositionCommit={commitPlaybackPosition}
              onSeekInteractionChange={setSeekInteractionActive}
              playbackUpdating={playbackUpdating}
              playbackMessage={playbackMessage}
              danmaku={danmaku}
              onDanmakuChange={changeDanmakuVisibility}
              onOpenDanmaku={() => showSubview("danmaku")}
              onOpenSettings={() => showSubview("settings")}
              onStopRelay={() => void stopRelay()}
              sourceResolution={sourceResolution}
              relayStatus={relayStatus}
              relayError={relayError}
              relayStopping={relayStopping}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function relayErrorMessage(error: unknown): string {
  if (!(error instanceof RelayWorkerError)) return "暂时无法读取链接，请稍后再试。";
  switch (error.code) {
    case "empty_source":
    case "invalid_source":
    case "invalid_live_room":
    case "unsupported_source":
    case "short_link_not_resolved":
      return "链接无法识别，检查后再试。";
    case "video_not_found":
    case "live_room_not_found":
      return "这个内容不存在，或暂时无法访问。";
    case "video_stream_not_found":
    case "live_stream_not_found":
    case "h264_stream_not_found":
    case "unsupported_video_format":
      return "没有找到可以转换的 H.264 媒体流。";
    case "unsupported_media_source":
    case "invalid_media_source":
      return "只支持 MP4、HLS、MPEG-TS 和 FLV 媒体链接。";
    case "ffprobe_start_failed":
    case "ffprobe_status_failed":
      return "FFprobe 无法启动，请在设置中重新下载视频处理组件。";
    case "media_probe_timeout":
      return "读取媒体信息超时，请检查链接后重试。";
    case "media_probe_failed":
      return "媒体链接暂时无法读取，或服务器拒绝了连接。";
    case "login_required":
      return "这个内容需要登录后才能读取。";
    case "bilibili_login_unavailable":
      return "暂时无法连接 B 站登录服务，请稍后重试。";
    case "bilibili_login_failed":
      return "登录没有完成，请重新生成二维码。";
    case "bilibili_login_session_not_found":
      return "二维码已经失效，请重新生成。";
    case "settings_read_failed":
      return "本机设置暂时无法读取。";
    case "settings_write_failed":
      return "设置没有保存，请检查磁盘空间后重试。";
    case "settings_invalid_data":
      return "本机设置内容有误，请恢复默认后保存。";
    case "settings_too_large":
      return "设置内容过长，检查后再保存。";
    case "ffmpeg_missing":
      return "电脑上没有可用的 FFmpeg，请先在设置中下载。";
    case "invalid_ingest_server":
      return "VRCDN 服务器地址不正确。";
    case "invalid_stream_key":
      return "VRCDN 推流密钥为空或包含空格。";
    case "invalid_playback_url":
      return "请从 VRCDN Live 页面复制完整播放地址。";
    case "invalid_start_position":
    case "seek_not_supported":
      return "这个内容不能跳转到所选位置。";
    case "media_session_not_found":
      return "媒体信息已经过期，请重新生成地址。";
    case "media_session_not_available":
      return "这个分 P 暂时无法中继。";
    case "retarget_restore_failed":
      return "切换失败，原来的中继也没有恢复，请重新生成地址。";
    case "danmaku_fetch_failed":
      return "弹幕暂时无法读取，请稍后再试。";
    case "danmaku_invalid_data":
      return "弹幕数据格式异常，请稍后再试。";
    case "danmaku_too_large":
      return "这段视频的弹幕太多，暂时无法处理。";
    case "danmaku_storage_failed":
      return "弹幕临时文件无法保存，请检查磁盘空间。";
    case "live_danmaku_unavailable":
      return "直播弹幕暂时无法连接，请稍后再试。";
    case "live_danmaku_start_failed":
      return "直播弹幕处理没有启动，请重新生成地址。";
    case "ffmpeg_live_danmaku_unsupported":
      return "当前 FFmpeg 缺少直播弹幕所需滤镜，请更换完整版本。";
    case "ffmpeg_start_failed":
    case "ffmpeg_status_failed":
      return "FFmpeg 无法启动，请检查视频处理设置。";
    case "ffmpeg_install_failed":
      return "FFmpeg 下载服务暂时不可用，请稍后重试。";
    case "worker_unavailable":
    case "worker_exited":
      return "视频处理服务没有启动，请重新打开软件。";
    case "protocol_mismatch":
      return "软件组件版本不一致，请重新安装。";
    default:
      return "暂时无法读取链接，请稍后再试。";
  }
}

function mediaComponentState(
  status: FfmpegStatus | null,
  error: string | null,
): MediaComponentState {
  if (!status) return error ? "unavailable" : "checking";
  switch (status.availability) {
    case "system":
      return "external";
    case "managed":
      return "managed";
    case "missing":
      return "missing";
    case "installing":
      return "downloading";
    case "failed":
      return "failed";
  }
}

function mediaStateLabel(state: MediaComponentState): string {
  switch (state) {
    case "checking":
      return "正在检查 FFmpeg";
    case "external":
      return "已找到电脑上的 FFmpeg";
    case "managed":
      return "正在使用软件管理的 FFmpeg";
    case "downloading":
      return "正在下载 FFmpeg";
    case "failed":
      return "FFmpeg 下载失败";
    case "unavailable":
      return "视频处理服务暂时不可用";
    case "missing":
      return "电脑上没有可用的 FFmpeg";
  }
}

function mediaStateCaption(state: MediaComponentState, status: FfmpegStatus | null): string {
  switch (state) {
    case "checking":
      return "由 Rust 视频处理服务检测";
    case "external":
      return "可以直接使用，不需要下载";
    case "managed":
      return status?.version ? `软件管理 · FFmpeg ${status.version}` : "由软件统一管理";
    case "downloading":
      return downloadProgressCaption(status);
    case "failed":
      return managedFfmpegErrorCaption(status?.diagnostic);
    case "unavailable":
      return "重新打开软件后再试";
    case "missing":
      return "下载到软件目录，约 100 MB";
  }
}

function managedFfmpegErrorCaption(diagnostic?: string): string {
  if (diagnostic?.includes("SHA-256")) return "文件校验失败，已丢弃下载内容";
  if (diagnostic?.includes("safety limit")) return "下载文件大小异常，未安装";
  if (diagnostic?.includes("cancelled")) return "下载已取消，可以重新下载";
  return "下载没有完成，可以重新下载";
}

function downloadProgressCaption(status: FfmpegStatus | null): string {
  const downloaded = status?.downloaded_bytes ?? 0;
  const total = status?.total_bytes;
  if (total && total > 0) {
    const percent = Math.min(100, Math.round((downloaded / total) * 100));
    return `${formatMegabytes(downloaded)} / ${formatMegabytes(total)} MB · ${percent}%`;
  }
  if (downloaded > 0) return `已下载 ${formatMegabytes(downloaded)} MB`;
  return "正在读取发行信息";
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

function mediaStateDotColor(state: MediaComponentState, palette: Palette): string {
  if (state === "external" || state === "managed") return palette.accentTeal;
  if (state === "failed" || state === "unavailable") return palette.accentRose;
  return palette.accentViolet;
}
