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
  detectFfmpeg,
  readStoredSettings,
  writeStoredSettings,
  type LoginMode,
  type StoredSettings,
  type ThemePreference,
} from "./settings-store";

export type Scene = "loading" | "error" | "ready-vod" | "settings" | "danmaku";
type DanmakuVisibility = "shown" | "hidden";
type DanmakuSize = "small" | "medium" | "large";
type DanmakuArea = "quarter" | "half" | "full";
type DanmakuSpeed = "slow" | "normal" | "fast";
type DanmakuFont = "microsoft-yahei" | "noto-sans-sc" | "source-han-sans" | "simhei";
type DanmakuWeight = "regular" | "bold";
type DanmakuOutline = "heavy" | "outline" | "shadow";
type DanmakuFilter = "rolling" | "fixed" | "colored" | "advanced";
type MediaComponentState = "external" | "missing" | "downloading" | "managed";

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

const SAMPLE_VIDEO = "https://www.bilibili.com/video/BV1UCVn66Eww?p=2";
const VIDEO_TITLE = "VRChat 播放器入门：从链接到放映";
const VIDEO_OUTPUT = "https://stream.vrcdn.live/play/BV1UCVn66Eww_p{part}.m3u8";
const PARTS = [
  { value: "1", label: "P1 · 开始之前" },
  { value: "2", label: "P2 · 自动中继与播放器" },
  { value: "3", label: "P3 · 常见问题" },
] as const;
const DURATION_BY_PART: Record<string, number> = { "1": 421, "2": 754, "3": 318 };
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
        placeholder="粘贴直播或视频链接"
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
  palette,
}: {
  part: string;
  setPart: (value: string) => void;
  palette: Palette;
}) {
  return (
    <Select.Root value={part} onValueChange={setPart} style={{ flexGrow: 1, minWidth: 0 }}>
      <Select.Trigger
        testId="part-select"
        style={({ open }) => ({
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
          cursor: "pointer",
          userSelect: "none",
          hover: { backgroundColor: palette.surfaceHover },
        })}
      >
        <Select.Value>
          <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
            {PARTS.find((entry) => entry.value === part)?.label ?? PARTS[0].label}
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
        {PARTS.map((entry) => (
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
  part,
  palette,
}: {
  part: string;
  palette: Palette;
}) {
  const duration = DURATION_BY_PART[part] ?? 0;
  const [position, setPosition] = useState(POSITION_BY_PART[part] ?? 0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => setPosition(POSITION_BY_PART[part] ?? 0), [part]);

  const setFromPointer = (event: EventPayload) => {
    const localX = Math.max(0, Math.min(TRACK_WIDTH, (event.x ?? 26) - 26));
    setPosition(Math.round((localX / TRACK_WIDTH) * duration));
  };

  const ratio = duration > 0 ? position / duration : 0;
  const thumbLeft = Math.round((TRACK_WIDTH - 12) * ratio);

  return (
    <div style={{ width: TRACK_WIDTH, paddingTop: 4 }}>
      <div
        testId="seek-control"
        tabIndex={0}
        onMouseDown={(event) => {
          setDragging(true);
          setFromPointer(event);
        }}
        onMouseMove={(event) => {
          if (dragging || event.pressedButton === 0) setFromPointer(event);
        }}
        onMouseUp={() => setDragging(false)}
        onKeyDown={(event) => {
          const step = event.modifiers?.shift ? 10 : 1;
          if (event.key === "left") setPosition((value) => Math.max(0, value - step));
          if (event.key === "right") setPosition((value) => Math.min(duration, value + step));
        }}
        style={{
          width: TRACK_WIDTH,
          height: 28,
          position: "relative",
          cursor: dragging ? "grabbing" : "pointer",
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
          {formatPlaybackTime(position)}
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

function Result({
  palette,
  part,
  setPart,
  danmaku,
  setDanmaku,
  onOpenDanmaku,
}: {
  palette: Palette;
  part: string;
  setPart: (part: string) => void;
  danmaku: DanmakuVisibility;
  setDanmaku: (value: DanmakuVisibility) => void;
  onOpenDanmaku: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const output = VIDEO_OUTPUT.replace("{part}", part);

  const copy = async () => {
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
          VRChat 播放地址
        </text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 9.5 }}>视频</text>
        <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 9.5 }}>
          · 中继运行中 · 请保持开启
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
        {VIDEO_TITLE}
      </text>

      <div style={{ marginTop: 9, display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
        <text style={{ width: 42, color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11 }}>
          分 P
        </text>
        <PartSelect part={part} setPart={setPart} palette={palette} />
      </div>

      <div style={{ marginTop: 5, paddingLeft: 2, paddingRight: 2 }}>
        <SeekControl part={part} palette={palette} />
      </div>

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
          onChange={setDanmaku}
          options={VISIBILITY_OPTIONS}
          width={92}
          height={24}
          palette={palette}
        />
        <Button
          label="样式"
          palette={palette}
          onClick={onOpenDanmaku}
        />
      </div>

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
        <Icon name="link" size={11} color={palette.accentTeal} />
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
        <IconButton
          name={copied ? "check" : "copy"}
          palette={palette}
          color={copied ? palette.accentTeal : palette.inkMuted}
          label="copy-output"
          onClick={() => void copy()}
        />
      </div>
    </div>
  );
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
}: {
  palette: Palette;
  themePreference: ThemePreference;
  setThemePreference: (value: ThemePreference) => void;
}) {
  const initial = useMemo(readStoredSettings, []);
  const [settings, setSettings] = useState<StoredSettings>({ ...initial, theme: themePreference });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mediaState] = useState<MediaComponentState>(() => (detectFfmpeg() ? "external" : "missing"));
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const update = (key: "host" | "key" | "playbackPrefix", value: string) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const updateLogin = (login: LoginMode) => setSettings((current) => ({ ...current, login }));
  const updateTheme = (theme: ThemePreference) => {
    setSettings((current) => ({ ...current, theme }));
    setThemePreference(theme);
  };
  const reset = () => {
    setSettings({ ...DEFAULT_SETTINGS });
    setThemePreference("system");
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await writeStoredSettings(settings);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1200);
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
                <SettingsInput value={settings.key} onChange={(value) => update("key", value)} placeholder="未设置" palette={palette} />
              </Field>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Field label="播放地址前缀" palette={palette}>
              <SettingsInput value={settings.playbackPrefix} onChange={(value) => update("playbackPrefix", value)} mono palette={palette} />
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
            paddingLeft: 14,
            borderLeftWidth: 1,
            borderColor: palette.surfaceLine,
          }}
        >
          <SectionHeading title="B 站账号" subtitle="公开内容可直接使用访客模式" compact palette={palette} />
          <Segmented value={settings.login} onChange={updateLogin} options={LOGIN_OPTIONS} width={126} palette={palette} />
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
            <StatusDot color={mediaState === "external" || mediaState === "managed" ? palette.accentTeal : palette.accentViolet} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 10.5, whiteSpace: "nowrap" }}>
              {mediaState === "external" ? "已找到电脑上的 FFmpeg" : "电脑上没有可用的 FFmpeg"}
            </text>
          </div>
          <text style={{ marginLeft: 12, color: palette.caption, fontFamily: FONT_UI, fontSize: 10 }}>
            {mediaState === "external" ? "可以直接使用，不需要下载" : "下载到软件目录，约 106 MB"}
          </text>
        </div>
        {mediaState === "missing" ? (
          <Button label="下载 FFmpeg" icon="download" palette={palette} disabled />
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
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 10.5 }}>配置只保存在本机</text>
      </div>
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
    () => initialThemePreference ?? readStoredSettings().theme,
  );
  const [source, setSource] = useState(SAMPLE_VIDEO);
  const [part, setPart] = useState("2");
  const [danmaku, setDanmaku] = useState<DanmakuVisibility>("shown");
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(DEFAULT_DANMAKU_SETTINGS);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedAppearance: Appearance =
    themePreference === "system" ? initialAppearance : themePreference;
  const palette = PALETTES[resolvedAppearance];

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const convert = () => {
    if (timer.current) clearTimeout(timer.current);
    if (!source.trim() || !/(bilibili\.com|b23\.tv)/i.test(source)) {
      setScene("error");
      return;
    }
    setScene("loading");
    timer.current = setTimeout(() => setScene("ready-vod"), 650);
  };

  const showSubview = (next: "settings" | "danmaku") => {
    if (timer.current) clearTimeout(timer.current);
    if (scene !== "settings" && scene !== "danmaku") setLastMainScene(scene);
    setScene(next);
  };

  const leaveSubview = () => {
    setScene(lastMainScene === "settings" || lastMainScene === "danmaku" ? "ready-vod" : lastMainScene);
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
            B 站链接
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
              onClick={convert}
              disabled={scene === "loading"}
              testId="convert-source"
            />
            {scene === "loading" ? <Loading palette={palette} /> : null}
            {scene === "loading" ? (
              <div style={{ flexGrow: 1, display: "flex", justifyContent: "flex-end" }}>
                <Button label="取消" palette={palette} quiet onClick={() => setScene("ready-vod")} />
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
                链接无法识别，检查后再试。
              </text>
              <div style={{ flexGrow: 1 }} />
              <Button label="重试" palette={palette} quiet onClick={convert} />
            </div>
          ) : null}

          {scene === "ready-vod" ? (
            <Result
              palette={palette}
              part={part}
              setPart={setPart}
              danmaku={danmaku}
              setDanmaku={setDanmaku}
              onOpenDanmaku={() => showSubview("danmaku")}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
