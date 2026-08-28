import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { motion, useGpuixRequired, type EventPayload, type StyleDesc } from "@gpuix/react";
import * as Select from "@gpuix/react/select";
import { basename, dirname, resolve } from "node:path";

import { ICONS, type IconName } from "./icons";
import {
  FONT_MONO,
  FONT_SERIF,
  FONT_UI,
  MOTION,
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
import {
  beginProductWindowDrag,
  closeProductWindow,
  minimizeProductWindow,
  prefersReducedMotion,
  releaseProductWindowPointer,
  registerProductWindowTextInput,
  setProductWindowClientSize,
  unregisterProductWindowTextInput,
} from "./platform/window";
import {
  disposeNativePartPopup,
  hideNativePartPopup,
  showNativePartPopup,
  supportsNativePartPopup,
} from "./platform/native-part-popup";

export type Scene = "idle" | "loading" | "error" | "ready-vod" | "settings" | "danmaku";
type DanmakuVisibility = "shown" | "hidden";
type LoginMode = "guest" | "account";

export function sceneWindowHeight(
  scene: Scene,
  settingsExpanded = false,
  singlePartVideo = false,
): number {
  if (scene === "idle" || scene === "loading") return 178;
  if (scene === "error") return 230;
  if (scene === "ready-vod") return singlePartVideo ? 443 : 478;
  if (scene === "settings") return settingsExpanded ? 400 : 364;
  return 572;
}

export function sceneWindowWidth(scene: Scene): number {
  if (scene === "settings") return 528;
  if (scene === "danmaku") return 484;
  return 472;
}
type DanmakuSize = "small" | "medium" | "large";
type DanmakuArea = "quarter" | "half" | "full";
type DanmakuSpeed = "slow" | "normal" | "fast";
type DanmakuFont = "microsoft-yahei" | "noto-sans-sc" | "source-han-sans" | "simhei";
type DanmakuWeight = "regular" | "bold";
type DanmakuOutline = "heavy" | "outline" | "shadow";
type DanmakuFilter = "rolling" | "fixed" | "colored" | "advanced";
type PlaybackEndBehavior = "pause" | "repeat" | "next";
type PlaybackUpdate = "part" | "seek" | "danmaku" | "completion" | null;
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
const LONG_REFERENCE_PARTS: PlaybackPart[] = [
  { value: "1", label: "P1 · 至冬 Snezhnaya", duration: 421 },
  { value: "2", label: "P2 · 战斗曲1 冰湖的凯旋礼 Triumph on the Ice", duration: 754 },
  { value: "3", label: "P3 · 战斗曲2", duration: 318 },
  { value: "4", label: "P4 · 战斗曲3", duration: 296 },
  { value: "5", label: "P5 · 战斗曲4 不灭衍生造物、火鸟「扎拉」战斗曲", duration: 382 },
  { value: "6", label: "P6 · 战斗曲5 帕芙琳娜战斗曲", duration: 344 },
  { value: "7", label: "P7 · 影城 靶场1", duration: 274 },
  { value: "8", label: "P8 · 至冬堡 白天1 旋曜玉帛189", duration: 312 },
  { value: "9", label: "P9 · 至冬堡 白天2", duration: 298 },
  { value: "10", label: "P10 · 至冬堡 夜晚1", duration: 305 },
  { value: "11", label: "P11 · 至冬堡 夜晚2", duration: 315 },
  { value: "12", label: "P12 · 至冬堡 夜晚3", duration: 288 },
  { value: "13", label: "P13 · 至冬堡 夜晚4", duration: 326 },
] as const;
const CAPTURE_REFERENCE_PARTS = process.env.VRC_BILI_RELAY_CAPTURE_LONG_PARTS === "1"
  ? LONG_REFERENCE_PARTS
  : REFERENCE_PARTS;
const POSITION_BY_PART: Record<string, number> = { "1": 0, "2": 204, "3": 0 };
const PLAYBACK_END_SEQUENCE: readonly PlaybackEndBehavior[] = ["pause", "next", "repeat"];
const TRACK_WIDTH = 416;
const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
const THEME_OPTION_WEIGHTS = [64, 42, 42] as const;
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

const REDUCED_MOTION = prefersReducedMotion();

function motionTransition(duration: number) {
  return {
    duration: REDUCED_MOTION ? 0 : duration,
    ease: MOTION.easeOut,
  };
}

function MotionFade({
  children,
  style,
  duration = MOTION.surfaceEnterSeconds,
}: {
  children: React.ReactNode;
  style?: StyleDesc;
  duration?: number;
}) {
  return (
    <motion.div
      initial={REDUCED_MOTION ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={motionTransition(duration)}
      style={style}
    >
      {children}
    </motion.div>
  );
}

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
  return settings.streamKeyStatus === "available" && Boolean(settings.playbackUrl.trim());
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
  contentKey?: string;
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
  contentKey,
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
        height: 33,
        flexShrink: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingLeft: 15,
        paddingRight: 15,
        borderRadius: RADII.control,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.buttonSurface,
        boxShadow: {
          offsetX: 0,
          offsetY: 1,
          blurRadius: 2,
          spreadRadius: 0,
          color: palette.controlShadow,
        },
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.48 : 1,
        userSelect: "none",
        hover: disabled
          ? undefined
          : { backgroundColor: palette.buttonHover, borderColor: palette.surfaceLine },
        active: disabled ? undefined : { backgroundColor: palette.surfaceActive },
      }}
    >
      {contentKey ? (
        <MotionFade
          key={contentKey}
          duration={MOTION.stateCrossfadeSeconds}
          style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}
        >
          {icon ? <Icon name={icon} size={12.5} color={iconColor ?? palette.inkMuted} /> : null}
          <text
            style={{
              color: quiet ? palette.caption : palette.inkSoft,
              fontFamily: FONT_UI,
              fontSize: 13,
              fontWeight: 400,
              lineHeight: 17,
            }}
          >
            {label}
          </text>
        </MotionFade>
      ) : (
        <>
          {icon ? <Icon name={icon} size={12.5} color={iconColor ?? palette.inkMuted} /> : null}
          <text
            style={{
              color: quiet ? palette.caption : palette.inkSoft,
              fontFamily: FONT_UI,
              fontSize: 13,
              fontWeight: 400,
              lineHeight: 17,
            }}
          >
            {label}
          </text>
        </>
      )}
    </div>
  );
}

function IconButton({
  name,
  palette,
  color,
  label,
  onClick,
  contentKey,
}: {
  name: IconName;
  palette: Palette;
  color?: string;
  label: string;
  onClick: () => void;
  contentKey?: string;
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
        width: 29,
        height: 29,
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
      {contentKey ? (
        <MotionFade
          key={contentKey}
          duration={MOTION.stateCrossfadeSeconds}
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <Icon name={name} size={14.5} color={color ?? palette.inkMuted} />
        </MotionFade>
      ) : (
        <Icon name={name} size={14.5} color={color ?? palette.inkMuted} />
      )}
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

function CaptionButton({
  kind,
  palette,
  disabled = false,
  onClick,
}: {
  kind: "minimize" | "maximize" | "close";
  palette: Palette;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const closeHovered = kind === "close" && hovered && !disabled;
  return (
    <div
      testId={`caption-${kind}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (!disabled) onClick?.();
      }}
      style={{
        width: 47,
        height: 43,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: closeHovered ? "#FFFFFF" : palette.inkMuted,
        backgroundColor: closeHovered
          ? "#C42B1C"
          : hovered && !disabled
            ? palette.surfaceHover
            : "#00000000",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.34 : 1,
        userSelect: "none",
        active: disabled
          ? undefined
          : { backgroundColor: kind === "close" ? "#B32017" : palette.surfaceActive },
      }}
    >
      <Icon name={kind} size={10} color={closeHovered ? "#FFFFFF" : palette.inkMuted} />
    </div>
  );
}

function Header({
  palette,
  scene,
  onSettings,
  onBack,
  onClose,
}: {
  palette: Palette;
  scene: Scene;
  onSettings: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const isSettings = scene === "settings";
  const isDanmaku = scene === "danmaku";
  const isSubview = isSettings || isDanmaku;
  const title = isSettings
    ? "设置"
    : isDanmaku
      ? "弹幕样式"
      : "VRC Bili Relay";
  const beginDrag = (event: EventPayload) => {
    if (event.button === 0 && (event.clickCount ?? 1) === 1) {
      beginProductWindowDrag();
    }
  };

  return (
    <div
      style={{
        height: 43,
        flexShrink: 0,
        position: "relative",
        userSelect: "none",
      }}
    >
      <div
        testId="window-drag-area"
        onMouseDown={beginDrag}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: isSubview ? 141 : 188,
          height: 43,
          backgroundColor: "#FFFFFF01",
        }}
      />
      {isSubview ? (
        <div style={{ position: "absolute", top: 7, left: 8 }}>
          <IconButton name="back" palette={palette} label="back" onClick={onBack} />
        </div>
      ) : null}
      <text
        onMouseDown={beginDrag}
        style={{
          position: "absolute",
          top: 10,
          left: isSubview ? 47 : 16,
          right: isSubview ? 149 : 188,
          color: palette.ink,
          fontFamily: FONT_SERIF,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 22,
        }}
      >
        {title}
      </text>
      {!isSubview ? (
        <div style={{ position: "absolute", top: 7, right: 149 }}>
          <IconButton name="settings" palette={palette} label="settings" onClick={onSettings} />
        </div>
      ) : null}
      <div
        style={{
          width: 141,
          height: 43,
          position: "absolute",
          top: 0,
          right: 0,
          display: "flex",
          flexDirection: "row",
        }}
      >
        <CaptionButton kind="minimize" palette={palette} onClick={minimizeProductWindow} />
        <CaptionButton kind="maximize" palette={palette} disabled />
        <CaptionButton kind="close" palette={palette} onClick={onClose} />
      </div>
    </div>
  );
}

function ProductTextInput({
  value,
  placeholder,
  onChange,
  palette,
  style,
  testId,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  palette: Palette;
  style: StyleDesc;
  testId?: string;
}) {
  const registeredElementId = useRef<number | null>(null);
  useEffect(() => () => {
    if (registeredElementId.current !== null) {
      unregisterProductWindowTextInput(registeredElementId.current);
    }
    releaseProductWindowPointer();
  }, []);
  return (
    <input
      ref={(instance) => {
        const nextElementId = instance?.id ?? null;
        if (registeredElementId.current === nextElementId) return;
        if (registeredElementId.current !== null) {
          unregisterProductWindowTextInput(registeredElementId.current);
        }
        registeredElementId.current = nextElementId;
        if (nextElementId !== null) registerProductWindowTextInput(nextElementId);
      }}
      value={value}
      testId={testId}
      placeholder={placeholder}
      onChange={(event) => onChange(event.value ?? "")}
      onMouseUp={releaseProductWindowPointer}
      onBlur={releaseProductWindowPointer}
      theme={{ appearance: palette === PALETTES.dark ? "dark" : "light", caret: palette.accentTeal }}
      style={{ ...style, userSelect: "text" }}
    />
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
    if (clipboard) setSource(clipboard);
  };

  return (
    <div
      style={{
        width: "100%",
        height: 35,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingLeft: 11,
        paddingRight: 3,
        borderRadius: RADII.control,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.surface,
        hover: { backgroundColor: palette.surfaceHover },
      }}
    >
      <ProductTextInput
        testId="source-input"
        value={source}
        placeholder="粘贴 B 站或媒体链接"
        onChange={setSource}
        palette={palette}
        style={{
          flexGrow: 1,
          minWidth: 0,
          height: 19,
          position: "relative",
          top: -4,
          color: palette.inkSoft,
          fontFamily: FONT_UI,
          fontSize: 13.5,
          lineHeight: 19,
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
  const [open, setOpen] = useState(false);
  const renderer = useGpuixRequired() as ReturnType<typeof useGpuixRequired> & {
    getElementBounds(elementId: number): number[] | null;
    getWindowSize(): { width: number; height: number };
  };
  const triggerId = useRef<number | null>(null);
  const nativePopup = supportsNativePartPopup();
  const selected = parts.find((entry) => entry.value === part) ?? parts[0];
  const menuHeight = Math.min(132, Math.max(1, Math.min(4, parts.length)) * 31 + 8);

  useEffect(() => () => {
    if (nativePopup) hideNativePartPopup();
  }, [nativePopup]);

  useEffect(() => {
    if (disabled && open && nativePopup) {
      hideNativePartPopup();
      setOpen(false);
    }
  }, [disabled, nativePopup, open]);

  const closePopup = () => {
    if (nativePopup) hideNativePartPopup();
    setOpen(false);
  };

  const openPopup = () => {
    if (disabled) return;
    if (open) {
      closePopup();
      return;
    }
    if (!nativePopup) {
      setOpen(true);
      return;
    }
    const elementId = triggerId.current;
    const bounds = elementId === null ? null : renderer.getElementBounds(elementId);
    if (!bounds || bounds.length < 4) return;
    setOpen(true);
    const shown = showNativePartPopup({
      items: parts.map(({ value, label }) => ({ value, label })),
      selectedValue: part,
      palette,
      anchorBounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
      mainWindowSize: renderer.getWindowSize(),
      onSelect: (value) => {
        setPart(value);
        setOpen(false);
      },
      onDismiss: () => setOpen(false),
    });
    if (!shown) setOpen(false);
  };

  if (nativePopup) {
    return (
      <div style={{ flexGrow: 1, minWidth: 0, opacity: disabled ? 0.62 : 1 }}>
        <div
          ref={(instance) => {
            triggerId.current = instance?.id ?? null;
          }}
          testId="part-select"
          tabIndex={disabled ? -1 : 0}
          onClick={openPopup}
          onKeyDown={(event) => {
            if (event.key === "escape") closePopup();
            if (event.key === "enter" || event.key === "space" || event.key === "down" || event.key === "up") {
              openPopup();
            }
          }}
          style={{
            width: "100%",
            height: 33,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingLeft: 11,
            paddingRight: 10,
            borderRadius: RADII.control,
            borderWidth: 1,
            borderColor: open ? palette.surfaceLine : palette.panelEdge,
            backgroundColor: open ? palette.surfaceHover : palette.surface,
            cursor: disabled ? "default" : "pointer",
            userSelect: "none",
            hover: disabled ? undefined : { backgroundColor: palette.surfaceHover },
            active: disabled ? undefined : { backgroundColor: palette.surfaceActive },
          }}
        >
          <text
            style={{
              minWidth: 0,
              flexGrow: 1,
              overflow: "hidden",
              paddingRight: 4,
              color: palette.inkSoft,
              fontFamily: FONT_UI,
              fontSize: 13,
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            {selected?.label ?? "P1"}
          </text>
          <Icon name={open ? "chevronUp" : "chevron"} size={10} color={open ? palette.inkMuted : palette.caption} />
        </div>
      </div>
    );
  }

  return (
    <Select.Root
      value={part}
      open={open}
      onOpenChange={setOpen}
      onValueChange={setPart}
      disabled={disabled}
      style={{ flexGrow: 1, minWidth: 0, opacity: disabled ? 0.62 : 1 }}
    >
      <Select.Trigger
        testId="part-select"
        style={({ open, disabled: selectDisabled }) => ({
          width: "100%",
          height: 33,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingLeft: 11,
          paddingRight: 10,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: open ? palette.surfaceLine : palette.panelEdge,
          backgroundColor: open ? palette.surfaceHover : palette.surface,
          cursor: selectDisabled ? "default" : "pointer",
          userSelect: "none",
          hover: { backgroundColor: palette.surfaceHover },
        })}
      >
        <div style={{ minWidth: 0, flexGrow: 1, overflow: "hidden", paddingRight: 4 }}>
          <Select.Value>
            <text
              style={{
                width: "100%",
                overflow: "hidden",
                color: palette.inkSoft,
                fontFamily: FONT_UI,
                fontSize: 13,
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {selected?.label ?? "P1"}
            </text>
          </Select.Value>
        </div>
        <Icon name={open ? "chevronUp" : "chevron"} size={10} color={open ? palette.inkMuted : palette.caption} />
      </Select.Trigger>
      <Select.Content
        side="bottom"
        sideOffset={6}
        style={{
          width: 368,
          height: menuHeight,
          maxHeight: 152,
          backgroundColor: palette.floatingSurface,
        }}
      >
        <motion.div
          initial={REDUCED_MOTION ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransition(MOTION.selectEnterSeconds)}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            padding: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: palette.floatingEdge,
            backgroundColor: palette.floatingSurface,
            overflow: "scroll",
            boxShadow: {
              offsetX: 0,
              offsetY: 16,
              blurRadius: 36,
              spreadRadius: 0,
              color: palette.floatingShadow,
            },
          }}
        >
          {parts.map((entry) => (
            <Select.Item
              key={entry.value}
              value={entry.value}
              style={({ highlighted }) => ({
                minHeight: 31,
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 7,
                cursor: "pointer",
                backgroundColor: highlighted ? palette.segmentedTrack : "#00000000",
              })}
            >
              <div style={{ minWidth: 0, flexGrow: 1, overflow: "hidden" }}>
                <text
                  style={{
                    width: "100%",
                    overflow: "hidden",
                    color: palette.inkSoft,
                    fontFamily: FONT_UI,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {entry.label}
                </text>
              </div>
              {entry.value === part ? <Icon name="check" size={10} color={palette.accentTeal} /> : null}
            </Select.Item>
          ))}
        </motion.div>
      </Select.Content>
    </Select.Root>
  );
}

function PlaybackEndButton({
  value,
  onChange,
  disabled,
  palette,
}: {
  value: PlaybackEndBehavior;
  onChange: (value: PlaybackEndBehavior) => void;
  disabled: boolean;
  palette: Palette;
}) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentIndex = PLAYBACK_END_SEQUENCE.indexOf(value);
  const nextValue = PLAYBACK_END_SEQUENCE[(currentIndex + 1) % PLAYBACK_END_SEQUENCE.length]
    ?? "pause";
  const active = value !== "pause";
  const icon: IconName = value === "pause"
    ? "pause"
    : value === "next"
      ? "skipNext"
      : "repeatOne";
  const label = value === "pause"
    ? "播完暂停 · 点击切换"
    : value === "next"
      ? "自动下一 P · 点击切换"
      : "单集循环 · 点击切换";

  const clearTooltipTimer = () => {
    if (tooltipTimer.current !== null) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
  };
  const showTooltipAfterDelay = () => {
    if (disabled) return;
    clearTooltipTimer();
    tooltipTimer.current = setTimeout(() => {
      tooltipTimer.current = null;
      setTooltipVisible(true);
    }, 520);
  };
  const hideTooltip = () => {
    clearTooltipTimer();
    setTooltipVisible(false);
  };

  useEffect(() => () => clearTooltipTimer(), []);
  useEffect(() => {
    if (disabled) hideTooltip();
  }, [disabled]);

  return (
    <div
      style={{
        width: 22,
        height: 22,
        marginRight: 7,
        flexShrink: 0,
        position: "relative",
      }}
    >
      <div
        testId="playback-end-toggle"
        tabIndex={disabled ? -1 : 0}
        onMouseEnter={showTooltipAfterDelay}
        onMouseLeave={hideTooltip}
        onFocus={() => {
          if (!disabled) setTooltipVisible(true);
        }}
        onBlur={hideTooltip}
        onClick={() => {
          hideTooltip();
          if (!disabled) onChange(nextValue);
        }}
        onKeyDown={(event) => {
          if (!disabled && (event.key === "enter" || event.key === "space")) {
            hideTooltip();
            onChange(nextValue);
          }
        }}
        style={{
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.48 : 1,
          userSelect: "none",
          hover: disabled ? undefined : { backgroundColor: palette.surfaceHover },
          active: disabled ? undefined : { backgroundColor: palette.surfaceActive },
        }}
      >
        <MotionFade
          key={value}
          duration={MOTION.stateCrossfadeSeconds}
          style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <Icon
            name={icon}
            size={13}
            color={active ? palette.accentDanmaku : palette.caption}
          />
        </MotionFade>
      </div>
      {tooltipVisible && !disabled ? (
        <div
          testId="playback-end-tooltip"
          style={{
            width: 126,
            position: "absolute",
            right: -4,
            bottom: 29,
            paddingTop: 6,
            paddingRight: 9,
            paddingBottom: 6,
            paddingLeft: 9,
            borderRadius: 7,
            borderWidth: 1,
            borderColor: palette.panelEdge,
            backgroundColor: palette.nestedStrong,
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          <text
            style={{
              color: palette.inkSoft,
              fontFamily: FONT_UI,
              fontSize: 11.5,
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </text>
        </div>
      ) : null}
    </div>
  );
}

function SeekControl({
  duration,
  position,
  onPositionChange,
  onPositionCommit,
  onInteractionChange,
  disabled,
  showTransport,
  playing,
  transportBusy,
  onTogglePlayback,
  endBehavior,
  onEndBehaviorChange,
  palette,
}: {
  duration: number;
  position: number;
  onPositionChange: (value: number) => void;
  onPositionCommit: (value: number) => void;
  onInteractionChange: (active: boolean) => void;
  disabled: boolean;
  showTransport: boolean;
  playing: boolean;
  transportBusy: boolean;
  onTogglePlayback: () => void;
  endBehavior: PlaybackEndBehavior;
  onEndBehaviorChange: (value: PlaybackEndBehavior) => void;
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
            pointerEvents: "none",
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
            pointerEvents: "none",
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
      <div
        style={{
          width: TRACK_WIDTH,
          height: 22,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        {showTransport ? (
          <div
            testId="playback-toggle"
            tabIndex={transportBusy ? -1 : 0}
            onClick={() => {
              if (!transportBusy) onTogglePlayback();
            }}
            onKeyDown={(event) => {
              if (!transportBusy && (event.key === "enter" || event.key === "space")) onTogglePlayback();
            }}
            style={{
              width: 22,
              height: 22,
              marginRight: 7,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              color: palette.inkMuted,
              backgroundColor: palette.buttonSurface,
              borderWidth: 1,
              borderColor: palette.panelEdge,
              cursor: transportBusy ? "default" : "pointer",
              opacity: transportBusy ? 0.48 : 1,
              userSelect: "none",
              hover: transportBusy ? undefined : { backgroundColor: palette.buttonHover },
              active: transportBusy ? undefined : { backgroundColor: palette.surfaceActive },
            }}
          >
            <Icon name={playing ? "pause" : "play"} size={10} color={palette.inkMuted} />
          </div>
        ) : null}
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 11.5 }}>
          {formatPlaybackTime(visiblePosition)}
        </text>
        <div style={{ flexGrow: 1 }} />
        {showTransport ? (
          <PlaybackEndButton
            value={endBehavior}
            onChange={onEndBehaviorChange}
            disabled={transportBusy}
            palette={palette}
          />
        ) : null}
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 11.5 }}>
          {formatPlaybackTime(duration)}
        </text>
      </div>
    </div>
  );
}

function appearanceShadow(palette: Palette): string {
  return palette === PALETTES.dark ? "#00000052" : "#A1A1AA3D";
}

const DANMAKU_LABEL_WIDTH = 80;
const DANMAKU_ROW_GAP = 12;
const DANMAKU_CONTROL_WIDTH = 340;

function Segmented<T extends string>({
  value,
  onChange,
  palette,
  options,
  optionWeights,
  width,
  height = 33,
}: {
  value: T;
  onChange: (value: T) => void;
  palette: Palette;
  options: ReadonlyArray<{ value: T; label: string }>;
  optionWeights?: ReadonlyArray<number>;
  width: number;
  height?: number;
}) {
  const [instantThumb, setInstantThumb] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const inset = 2;
  const innerWidth = width - inset * 2;
  const weights = optionWeights?.length === options.length && optionWeights.every((weight) => weight > 0)
    ? optionWeights
    : options.map(() => 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const optionWidths = weights.map((weight) => innerWidth * weight / totalWeight);
  const selectedWidth = optionWidths[selectedIndex] ?? innerWidth / options.length;
  const selectedLeft = inset + optionWidths
    .slice(0, selectedIndex)
    .reduce((sum, optionWidth) => sum + optionWidth, 0);

  useEffect(() => {
    if (instantThumb) setInstantThumb(false);
  }, [instantThumb, value]);

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
        backgroundColor: palette.segmentedTrack,
      }}
    >
      <motion.div
        animate={{
          left: selectedLeft,
          width: selectedWidth,
          top: inset,
          height: height - inset * 2,
          borderRadius: 6,
        }}
        transition={{
          duration: REDUCED_MOTION || instantThumb ? 0 : MOTION.segmentedSeconds,
          ease: MOTION.easeOut,
        }}
        style={{
          position: "absolute",
          backgroundColor: palette.segmentedThumb,
          boxShadow: {
            offsetX: 0,
            offsetY: 1,
            blurRadius: 3,
            spreadRadius: 0,
            color: palette.segmentedShadow,
          },
          pointerEvents: "none",
        }}
      />
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <div
            key={option.value}
            tabIndex={0}
            onClick={() => {
              setInstantThumb(false);
              onChange(option.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "enter" || event.key === "space") {
                setInstantThumb(true);
                onChange(option.value);
              }
            }}
            style={{
              width: optionWidths[index] ?? innerWidth / options.length,
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
                width: "100%",
                color: selected ? palette.inkSoft : palette.caption,
                fontFamily: FONT_UI,
                fontSize: 12,
                fontWeight: 400,
                lineHeight: 15,
                textAlign: "center",
                whiteSpace: "nowrap",
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
  const moduleSize = Math.max(2, Math.floor(108 / (qr.size + quietZone * 2)));
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
          ? "等待扫码"
          : "正在生成二维码";

  return (
    <motion.div
      initial={REDUCED_MOTION ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={motionTransition(MOTION.popoverEnterSeconds)}
      onMouseDownOutside={onDismiss}
      style={{
        width: 164,
        position: "absolute",
        top: 100,
        right: 24,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: 10,
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
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        用哔哩哔哩 App 扫码
      </text>
      <div
        style={{
          width: 116,
          height: 116,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderRadius: 9,
          backgroundColor: auth?.qr ? "#FFFFFF" : palette.surfaceMuted,
        }}
      >
        {auth?.qr ? (
          <MotionFade key="login-qr" duration={MOTION.stateCrossfadeSeconds}>
            <BilibiliQrCode qr={auth.qr} />
          </MotionFade>
        ) : (
          <MotionFade key="login-qr-placeholder" duration={MOTION.stateCrossfadeSeconds}>
            <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11 }}>
              {busy ? "正在生成" : "二维码不可用"}
            </text>
          </MotionFade>
        )}
      </div>
      <MotionFade
        key={statusText}
        duration={MOTION.stateCrossfadeSeconds}
        style={{ minHeight: 17, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <StatusDot color={error || auth?.stage === "expired" ? palette.accentRose : palette.accentTeal} />
        <text style={{ color: error ? palette.inkMuted : palette.caption, fontFamily: FONT_UI, fontSize: 11 }}>
          {statusText}
        </text>
      </MotionFade>
      {error || auth?.stage === "expired" ? (
        <Button label="重新生成" palette={palette} disabled={busy} onClick={onBegin} />
      ) : null}
      <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 9.5 }}>
        登录信息会加密保存在本机
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
  playbackPaused,
  playbackToggling,
  onTogglePlayback,
  playbackEndBehavior,
  onPlaybackEndBehaviorChange,
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
  playbackPaused: boolean;
  playbackToggling: boolean;
  onTogglePlayback: () => void;
  playbackEndBehavior: PlaybackEndBehavior;
  onPlaybackEndBehaviorChange: (value: PlaybackEndBehavior) => void;
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
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReference = sourceResolution === null;
  const output = isReference
    ? VIDEO_OUTPUT.replace("{part}", part)
    : relayOutputDescription(sourceResolution, relayStatus, relayError, playbackPaused);
  const relayRunning = (
    relayStatus?.stage === "running" || relayStatus?.stage === "draining"
  ) && Boolean(relayStatus.playback_url);
  const relayActive = hasActivePublisher(relayStatus);
  const directReady = sourceResolution?.routing.kind === "direct" && Boolean(sourceResolution.playback_url);
  const canCopy = isReference || relayRunning || playbackPaused || directReady;
  const parts: PlaybackPart[] = sourceResolution?.kind === "video"
    ? sourceResolution.parts?.length
      ? sourceResolution.parts.map((entry) => ({
          value: String(entry.page),
          label: `P${entry.page} · ${entry.title}`,
          duration: entry.duration_seconds,
        }))
      : [{
          value: String(sourceResolution.selected_part ?? 1),
          label: "P1",
          duration: sourceResolution.duration_seconds ?? 0,
        }]
    : CAPTURE_REFERENCE_PARTS;
  const isLive = sourceResolution?.kind === "live";
  const showPlaybackControls = isReference || sourceResolution?.kind === "video";
  const showPartControl = isReference || parts.length > 1;
  const showTransport = isReference || (
    sourceResolution?.kind === "video"
    && sourceResolution.routing.kind !== "direct"
    && (relayActive || playbackPaused)
  );
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
  const statusLabel = resultStatusLabel(
    isReference,
    sourceResolution,
    relayStatus,
    relayError,
    playbackUpdating,
    playbackMessage,
    playbackPaused,
    danmaku,
  );

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (!canCopy) return;
    await writeClipboard(output);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      style={{
        position: "relative",
        marginTop: 18,
        paddingTop: 16,
        borderTopWidth: 1,
        borderColor: palette.surfaceDivider,
      }}
    >
      <div style={{ height: 17, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusDot color={palette.accentDanmaku} />
        <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 13, fontWeight: 600 }}>
          {isReference || relayRunning || directReady ? "VRChat 播放地址" : "媒体路由"}
        </text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11 }}>
          {sourceKindLabel}
        </text>
        <MotionFade key={statusLabel} duration={MOTION.stateCrossfadeSeconds}>
          <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11 }}>
            {statusLabel}
          </text>
        </MotionFade>
      </div>

      <text
        style={{
          width: "100%",
          marginTop: 13,
          overflow: "hidden",
          color: palette.ink,
          fontFamily: FONT_SERIF,
          fontSize: 14.5,
          fontWeight: 600,
          lineHeight: 20,
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        }}
      >
        {sourceResolution?.title ?? VIDEO_TITLE}
      </text>

      {showPlaybackControls ? (
        <>
          {showPartControl ? (
            <div style={{ marginTop: 9, display: "flex", flexDirection: "row", alignItems: "center", gap: 10 }}>
              <text style={{ width: 46, color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 12.5 }}>
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
          ) : null}

          <div style={{ marginTop: showPartControl ? 5 : 12, paddingLeft: 2, paddingRight: 2 }}>
            <SeekControl
              duration={playbackDuration}
              position={playbackPosition}
              onPositionChange={onPlaybackPositionChange}
              onPositionCommit={onPlaybackPositionCommit}
              onInteractionChange={onSeekInteractionChange}
              disabled={playbackUpdating !== null}
              showTransport={showTransport}
              playing={
                isReference
                  ? !playbackPaused
                  : relayStatus?.stage === "running" && !playbackPaused
              }
              transportBusy={
                playbackToggling
                || playbackUpdating !== null
                || relayStatus?.stage === "starting"
              }
              onTogglePlayback={onTogglePlayback}
              endBehavior={playbackEndBehavior}
              onEndBehaviorChange={onPlaybackEndBehaviorChange}
              palette={palette}
            />
          </div>
        </>
      ) : null}

      {showDanmakuControls ? (
        <div
          style={{
            position: "relative",
            minHeight: 32,
            marginTop: 15,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
          }}
        >
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusDot color={danmaku === "shown" ? palette.accentViolet : palette.surfaceLine} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 13 }}>弹幕</text>
          </div>
          <Segmented
            value={danmaku}
            onChange={onDanmakuChange}
            options={VISIBILITY_OPTIONS}
            width={96}
            height={28}
            palette={palette}
          />
          <Button label="样式" palette={palette} onClick={onOpenDanmaku} />
        </div>
      ) : null}

      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTopWidth: 1,
          borderColor: palette.surfaceDivider,
        }}
      >
        <div
          style={{
            minHeight: 32,
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
            color={palette.accentRose}
          />
          <MotionFade
            key={output}
            duration={MOTION.stateCrossfadeSeconds}
            style={{ minWidth: 0, flexGrow: 1, overflow: "hidden" }}
          >
            <text
              style={{
                width: "100%",
                overflow: "hidden",
                color: palette.inkSoft,
                fontFamily: canCopy ? FONT_MONO : FONT_UI,
                fontSize: 11.5,
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {output}
            </text>
          </MotionFade>
          {canCopy ? (
            <IconButton
              name={copied ? "check" : "copy"}
              palette={palette}
              color={copied ? palette.accentTeal : palette.inkMuted}
              label="copy-output"
              contentKey={copied ? "copied" : "copy"}
              onClick={() => void copy()}
            />
          ) : null}
          {!isReference && hasActivePublisher(relayStatus) ? (
            <Button
              label={relayStopping ? "停止中" : "停止"}
              palette={palette}
              quiet
              disabled={relayStopping || playbackUpdating !== null}
              contentKey={relayStopping ? "stopping" : "stop"}
              onClick={onStopRelay}
            />
          ) : null}
          {!isReference && relayError && sourceResolution?.routing.kind !== "unavailable" ? (
            <Button label="设置" palette={palette} quiet onClick={onOpenSettings} />
          ) : null}
        </div>
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
  playbackPaused: boolean,
  danmaku: DanmakuVisibility,
): string {
  if (playbackPaused && relay?.stage === "starting") return "· 正在准备播放地址";
  if (playbackPaused && (relay?.position_seconds ?? 0) <= 0.05) {
    return "· 已准备 · 打开地址后播放";
  }
  if (playbackPaused) return "· 已暂停 · 可以继续播放";
  if (isReference) return "· 中继运行中 · 请保持软件运行";
  if (source?.routing.kind === "unavailable") return "· 当前无法生成地址";
  if (source?.routing.kind === "direct" && source.playback_url) return "· 可直接播放 · 软件可关闭";
  if (playbackUpdating === "part") return "· 正在切换分 P";
  if (playbackUpdating === "seek") return "· 正在跳转";
  if (playbackUpdating === "danmaku") return "· 正在更新弹幕";
  if (playbackUpdating === "completion") return "· 正在继续播放";
  if (playbackMessage) return `· ${playbackMessage}`;
  if (relayError && !relay) return "· 需要完成设置";
  if (
    source?.kind === "video"
    && danmaku === "shown"
    && relay?.stage === "running"
    && relay.danmaku_events === undefined
  ) return "· 中继运行中 · 暂无弹幕";
  switch (relay?.stage) {
    case "starting":
      return "· 正在连接 VRCDN";
    case "running":
      return "· 中继运行中 · 请保持软件运行";
    case "draining":
      return "· 视频已结束 · 等待播放器播完";
    case "completed":
      return "· 视频播放完成";
    case "stopped":
      return "· 中继已停止";
    case "failed":
      return "· 中继启动失败";
    default:
      return "· 正在准备播放地址";
  }
}

function relayOutputDescription(
  source: SourceResolution,
  relay: RelayStatus | null,
  relayError: string | null,
  playbackPaused = false,
): string {
  if (source.routing.kind === "direct" && source.playback_url) return source.playback_url;
  if (
    relay?.playback_url
    && (relay.stage === "running" || relay.stage === "draining" || playbackPaused)
  ) return relay.playback_url;
  if (relay?.stage === "starting") return "正在准备播放地址";
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
      return "需要中继后播放";
    case "flv_container":
      return "需要中继后播放";
    case "mpeg_ts_container":
      return "需要中继后播放";
    case "requires_headers":
      return "需要中继后播放";
    case "expiring_url":
      return "需要中继后播放";
    case "direct_compatible":
      return "媒体流可以直接播放";
  }
}

function hasActivePublisher(relay: RelayStatus | null | undefined): boolean {
  return relay?.stage === "starting"
    || relay?.stage === "running"
    || relay?.stage === "draining";
}

function SectionHeading({
  title,
  subtitle,
  compact = false,
  flush = false,
  palette,
}: {
  title: string;
  subtitle?: string;
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
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 17,
        }}
      >
        {title}
      </text>
      {subtitle ? (
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11.5, lineHeight: 15 }}>
          {subtitle}
        </text>
      ) : null}
    </div>
  );
}

function SettingsInput({
  value,
  onChange,
  placeholder,
  palette,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  palette: Palette;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: 33,
        display: "flex",
        alignItems: "center",
        paddingLeft: 11,
        paddingRight: 11,
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        borderRadius: RADII.control,
      }}
    >
      <ProductTextInput
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        palette={palette}
        style={{
          width: "100%",
          height: 19,
          position: "relative",
          top: -4,
          color: palette.inkSoft,
          fontFamily: FONT_UI,
          fontSize: 13,
          lineHeight: 19,
        }}
      />
    </div>
  );
}

function SettingsSecretInput({
  value,
  onChange,
  placeholder,
  palette,
  storedAvailable,
  resetVersion,
  onRevealStored,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  palette: Palette;
  storedAvailable: boolean;
  resetVersion: number;
  onRevealStored: () => Promise<string>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [revealedStored, setRevealedStored] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const hasDraft = value.length > 0;
  const hasSecret = hasDraft || storedAvailable;
  const inputValue = hasDraft ? value : revealedStored ?? "";

  useEffect(() => {
    setRevealed(false);
    setRevealedStored(null);
  }, [resetVersion]);

  useEffect(() => {
    if (!hasSecret) {
      setRevealed(false);
      setRevealedStored(null);
    }
  }, [hasSecret]);

  const toggleReveal = async () => {
    if (revealing) return;
    if (revealed) {
      setRevealed(false);
      setRevealedStored(null);
      return;
    }
    if (hasDraft) {
      setRevealed(true);
      return;
    }
    if (!storedAvailable) return;
    setRevealing(true);
    try {
      const stored = await onRevealStored();
      setRevealedStored(stored);
      setRevealed(true);
    } catch {
      setRevealedStored(null);
      setRevealed(false);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: 33,
        position: "relative",
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        borderRadius: RADII.control,
      }}
    >
      <ProductTextInput
        value={inputValue}
        placeholder={hasSecret ? undefined : placeholder}
        onChange={(next) => {
          setRevealedStored(null);
          onChange(next);
        }}
        palette={palette}
        style={{
          width: "100%",
          height: 19,
          position: "absolute",
          top: 3,
          left: 0,
          paddingLeft: 11,
          paddingRight: hasSecret ? 36 : 11,
          color: revealed ? palette.inkSoft : "#00000000",
          fontFamily: FONT_UI,
          fontSize: 13,
          lineHeight: 19,
        }}
      />
      {hasSecret && !revealed ? (
        <text
          style={{
            height: 19,
            position: "absolute",
            top: 7,
            left: 11,
            right: 36,
            overflow: "hidden",
            color: palette.inkSoft,
            fontFamily: FONT_UI,
            fontSize: 9,
            lineHeight: 19,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {"●".repeat(hasDraft ? value.length : 18)}
        </text>
      ) : null}
      {hasSecret ? (
        <div style={{ position: "absolute", top: 2, right: 2 }}>
          <IconButton
            name={revealed ? "eyeOff" : "eye"}
            palette={palette}
            label={revealed ? "hide-stream-key" : "show-stream-key"}
            onClick={() => void toggleReveal()}
          />
        </div>
      ) : null}
    </div>
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
    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ height: 16, display: "flex", flexDirection: "row", alignItems: "center", gap: 3 }}>
        <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11.5, lineHeight: 16 }}>
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
          initial={REDUCED_MOTION ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransition(MOTION.popoverEnterSeconds)}
          onMouseDownOutside={() => setOpen(false)}
          style={{
            width: 238,
            position: "absolute",
            top: 22,
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
          <text style={{ color: palette.ink, fontFamily: FONT_SERIF, fontSize: 12, fontWeight: 600 }}>
            {relay ? "什么时候需要推流密钥？" : "为什么需要 FFmpeg？"}
          </text>
          {relay ? (
            <>
              <HelpRow color={palette.accentViolet} palette={palette}>
                开启弹幕，或链接无法直接播放时需要
              </HelpRow>
              <HelpRow color={palette.accentTeal} palette={palette}>
                链接可以直接播放且弹幕关闭时不需要
              </HelpRow>
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
      <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 11, lineHeight: 15 }}>
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
  const [open, setOpen] = useState(false);
  return (
    <Select.Root
      value={value}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(next) => onChange(next as T)}
      style={{ width }}
    >
      <Select.Trigger
        style={({ open }) => ({
          width,
          height: 33,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 11,
          paddingRight: 10,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: open ? palette.surfaceLine : palette.panelEdge,
          backgroundColor: open ? palette.surfaceHover : palette.surface,
          cursor: "pointer",
          hover: { backgroundColor: palette.surfaceHover },
        })}
      >
        <Select.Value>
          <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 13 }}>
            {selected?.label ?? ""}
          </text>
        </Select.Value>
        <Icon name={open ? "chevronUp" : "chevron"} size={10} color={open ? palette.inkMuted : palette.caption} />
      </Select.Trigger>
      <Select.Content
        side="bottom"
        sideOffset={6}
        style={{
          width,
          height: 132,
          maxHeight: 144,
          backgroundColor: palette.floatingSurface,
        }}
      >
        <motion.div
          initial={REDUCED_MOTION ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransition(MOTION.selectEnterSeconds)}
          style={{
            position: "relative",
            width: "100%",
            padding: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: palette.floatingEdge,
            backgroundColor: palette.floatingSurface,
            boxShadow: {
              offsetX: 0,
              offsetY: 16,
              blurRadius: 36,
              spreadRadius: 0,
              color: palette.floatingShadow,
            },
          }}
        >
          {options.map((option) => (
            <Select.Item
              key={option.value}
              value={option.value}
              style={({ highlighted }) => ({
                minHeight: 31,
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 7,
                cursor: "pointer",
                backgroundColor: highlighted ? palette.segmentedTrack : "#00000000",
              })}
            >
              <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 13 }}>
                {option.label}
              </text>
              {option.value === value ? <Icon name="check" size={10} color={palette.accentTeal} /> : null}
            </Select.Item>
          ))}
        </motion.div>
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
  const valueWidth = 40;
  const gap = 8;
  const width = DANMAKU_CONTROL_WIDTH - valueWidth - gap;
  const [dragging, setDragging] = useState(false);
  const update = (event: EventPayload) => {
    const localX = Math.max(0, Math.min(width, (event.x ?? 108) - 108));
    const raw = 20 + (localX / width) * 80;
    onChange(Math.max(20, Math.min(100, Math.round(raw / 5) * 5)));
  };
  const ratio = (value - 20) / 80;

  return (
    <div style={{ width: DANMAKU_CONTROL_WIDTH, height: 32, display: "flex", flexDirection: "row", alignItems: "center", gap }}>
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
        style={{ width, height: 25, position: "relative", cursor: dragging ? "grabbing" : "pointer" }}
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
        <div
          style={{
            position: "absolute",
            left: Math.round((width - 12) * ratio),
            top: 6,
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
      <div style={{ width: valueWidth, display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 1 }}>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 10 }}>{value}</text>
        <text style={{ color: palette.caption, fontFamily: FONT_MONO, fontSize: 10 }}>%</text>
      </div>
    </div>
  );
}

const DANMAKU_PREVIEW_BACKDROP = resolve(
  basename(process.execPath).toLowerCase().startsWith("bun")
    ? resolve(import.meta.dir, "..")
    : dirname(process.execPath),
  "assets",
  "danmaku-preview-backdrop.png",
);

function DanmakuPreviewBackdrop() {
  return (
    <img
      src={DANMAKU_PREVIEW_BACKDROP}
      objectFit="cover"
      style={{
        width: "100%",
        height: "100%",
        position: "absolute",
        top: 0,
        left: 0,
        borderRadius: 10,
        pointerEvents: "none",
      }}
    />
  );
}

function danmakuPreviewOutlineOffsets(outline: DanmakuOutline): ReadonlyArray<readonly [number, number]> {
  if (outline === "shadow") return [[2, 2]];
  if (outline === "heavy") return [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  return [[-1, 0], [1, 0], [0, -1], [0, 1]];
}

function DanmakuPreviewText({
  text,
  width,
  fontFamily,
  fontSize,
  fontWeight,
  outline,
  color,
}: {
  text: string;
  width: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  outline: DanmakuOutline;
  color: string;
}) {
  const offsets = danmakuPreviewOutlineOffsets(outline);
  return (
    <div style={{ width, height: 20, position: "relative", flexShrink: 0 }}>
      {offsets.map(([left, top]) => (
        <text
          key={`${left}:${top}`}
          style={{
            position: "absolute",
            top,
            left,
            color: outline === "shadow" ? "#101014D6" : "#101014F2",
            fontFamily,
            fontSize,
            fontWeight,
            lineHeight: 20,
            whiteSpace: "nowrap",
          }}
        >
          {text}
        </text>
      ))}
      <text
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          color,
          fontFamily,
          fontSize,
          fontWeight,
          lineHeight: 20,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </text>
    </div>
  );
}

function DanmakuPreviewLine({
  text,
  top,
  width,
  staticRight,
  fontFamily,
  fontSize,
  fontWeight,
  outline,
  opacity,
}: {
  text: string;
  top: number;
  width: number;
  staticRight: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  outline: DanmakuOutline;
  opacity: number;
}) {
  const content = (
    <DanmakuPreviewText
      text={text}
      width={width}
      fontFamily={fontFamily}
      fontSize={fontSize}
      fontWeight={fontWeight}
      outline={outline}
      color="#FFFFFF"
    />
  );
  const style = {
    width,
    height: 20,
    position: "absolute" as const,
    top,
    opacity,
  };
  return <div style={{ ...style, right: staticRight }}>{content}</div>;
}

function DanmakuPreview({
  fontFamily,
  fontSize,
  fontWeight,
  outline,
  opacity,
}: {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  outline: DanmakuOutline;
  opacity: number;
}) {
  return (
    <>
      <DanmakuPreviewBackdrop />
      <DanmakuPreviewLine
        text="这条弹幕会显示在画面上"
        top={13}
        width={220}
        staticRight={18}
        fontFamily={fontFamily}
        fontSize={fontSize}
        fontWeight={fontWeight}
        outline={outline}
        opacity={opacity}
      />
      <DanmakuPreviewLine
        text="VRChat 一起看"
        top={42}
        width={150}
        staticRight={78}
        fontFamily={fontFamily}
        fontSize={Math.max(10, fontSize - 1)}
        fontWeight={fontWeight}
        outline={outline}
        opacity={opacity}
      />
    </>
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
  const previewSize = settings.size === "small" ? 11.5 : settings.size === "large" ? 15.5 : 13.5;
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
        overflow: "hidden",
        paddingTop: 17,
        paddingRight: 26,
        paddingBottom: 24,
        paddingLeft: 26,
      }}
    >
      <div style={{ minHeight: 33, display: "flex", flexDirection: "row", alignItems: "center", gap: 16 }}>
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <SectionHeading title="弹幕" subtitle="开启后，弹幕会合成到画面中" compact flush palette={palette} />
        </div>
        <Segmented
          value={visibility}
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
          width={116}
          height={31}
          palette={palette}
        />
      </div>

      {visibility === "hidden" ? (
        <motion.div
          initial={REDUCED_MOTION ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransition(MOTION.surfaceEnterSeconds)}
          style={{
            marginTop: 14,
            padding: 11,
            borderRadius: RADII.nested,
            backgroundColor: palette.nested,
          }}
        >
          <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 11.5 }}>
            当前地址不会包含弹幕。
          </text>
        </motion.div>
      ) : (
        <motion.div
          initial={REDUCED_MOTION ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionTransition(MOTION.surfaceEnterSeconds)}
          style={{ marginTop: 16 }}
        >
          <div
            style={{
              height: 76,
              position: "relative",
              overflow: "hidden",
              borderRadius: 10,
              backgroundColor: palette.panel,
              boxShadow: {
                offsetX: 0,
                offsetY: 8,
                blurRadius: 20,
                spreadRadius: 0,
                color: "#00000018",
              },
            }}
          >
            <DanmakuPreview
              fontFamily={fontFamily}
              fontSize={previewSize}
              fontWeight={settings.weight === "bold" ? 700 : 400}
              outline={settings.outline}
              opacity={settings.opacity / 100}
            />
          </div>

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
            <DanmakuRow label="字体大小" palette={palette}>
              <Segmented value={settings.size} onChange={(value) => update("size", value)} options={SIZE_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="显示区域" palette={palette}>
              <Segmented value={settings.area} onChange={(value) => update("area", value)} options={AREA_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="滚动速度" palette={palette}>
              <Segmented value={settings.speed} onChange={(value) => update("speed", value)} options={SPEED_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="不透明度" palette={palette}>
              <OpacitySlider value={settings.opacity} onChange={(value) => update("opacity", value)} palette={palette} />
            </DanmakuRow>

            <div style={{ height: 1, marginTop: 4, marginRight: 8, marginBottom: 4, marginLeft: 8, backgroundColor: palette.surfaceDivider }} />

            <DanmakuRow label="弹幕字体" palette={palette}>
              <CompactSelect value={settings.font} onChange={(value) => update("font", value)} options={FONT_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="字重" palette={palette}>
              <Segmented value={settings.weight} onChange={(value) => update("weight", value)} options={WEIGHT_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="描边类型" palette={palette}>
              <Segmented value={settings.outline} onChange={(value) => update("outline", value)} options={OUTLINE_OPTIONS} width={DANMAKU_CONTROL_WIDTH} palette={palette} />
            </DanmakuRow>
            <DanmakuRow label="隐藏类型" palette={palette}>
              <div style={{ width: DANMAKU_CONTROL_WIDTH, display: "flex", flexDirection: "row", gap: 5 }}>
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
                        minWidth: 0,
                        flexGrow: 1,
                        height: 32,
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
                      <text style={{ color: selected ? palette.inkSoft : palette.caption, fontFamily: FONT_UI, fontSize: 12 }}>
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
    <div style={{ minHeight: 33, display: "flex", flexDirection: "row", alignItems: "center", gap: DANMAKU_ROW_GAP }}>
      <text style={{ width: DANMAKU_LABEL_WIDTH, color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 12.5 }}>
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
  onRevealStreamKey,
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
  onRevealStreamKey: () => Promise<string>;
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
  const [secretInputVersion, setSecretInputVersion] = useState(0);
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountAuthenticated = bilibiliAuth?.stage === "authenticated";
  const accountPending = bilibiliAuth?.stage === "waiting" || bilibiliAuth?.stage === "scanned";
  const loginMode: LoginMode = accountAuthenticated || accountPending ? "account" : "guest";
  const streamKeyUnavailable = storedSettings.streamKeyStatus === "unavailable" && !keyDirty;
  const mediaCaption = mediaStateCaption(mediaState, mediaStatus);
  const mediaActionVisible =
    mediaState === "missing" || mediaState === "failed" || mediaState === "downloading";
  const compactMediaRow = !mediaActionVisible && !mediaCaption;
  const serviceUnavailable = mediaState === "unavailable" || Boolean(settingsError);
  const serviceChecking = mediaState === "checking";
  const serviceStatusLabel = serviceUnavailable
    ? "服务暂不可用"
    : serviceChecking
      ? "正在检查服务"
      : "服务可用";
  const saveStatusText = saveError ?? settingsError ?? "配置只保存在本机";

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
    storedSettings.streamKeyStatus,
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
    setSecretInputVersion((current) => current + 1);
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
      setSecretInputVersion((current) => current + 1);
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
        overflow: "hidden",
        paddingTop: 17,
        paddingRight: 26,
        paddingBottom: 16,
        paddingLeft: 26,
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", gap: 20 }}>
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <SectionHeading title="VRCDN" palette={palette} />
          <div style={{ display: "flex", flexDirection: "row", gap: 9 }}>
            <div style={{ width: 108 }}>
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
                <SettingsSecretInput
                  value={settings.key}
                  onChange={(value) => {
                    update("key", value);
                    setKeyDirty(true);
                  }}
                  placeholder={
                    !keyDirty && storedSettings.streamKeyStatus === "available"
                      ? "已保存"
                      : streamKeyUnavailable
                        ? "无法读取，请重新填写"
                        : "未设置"
                  }
                  palette={palette}
                  storedAvailable={!keyDirty && storedSettings.streamKeyStatus === "available"}
                  resetVersion={secretInputVersion}
                  onRevealStored={async () => {
                    setSaveError(null);
                    try {
                      return await onRevealStreamKey();
                    } catch (error) {
                      setSaveError(relayErrorMessage(error));
                      throw error;
                    }
                  }}
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
                palette={palette}
              />
            </Field>
          </div>
          <div
            style={{
              height: 18,
              marginTop: 12,
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
            }}
          >
            <MotionFade
              key={serviceStatusLabel}
              duration={MOTION.stateCrossfadeSeconds}
              style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}
            >
              <StatusDot
                color={
                  serviceUnavailable
                    ? palette.accentRose
                    : serviceChecking
                      ? palette.surfaceLine
                      : palette.accentTeal
                }
              />
              <text
                style={{
                  color: serviceUnavailable ? palette.accentRose : palette.caption,
                  fontFamily: FONT_UI,
                  fontSize: 12,
                  fontWeight: 400,
                  lineHeight: 16,
                }}
              >
                {serviceStatusLabel}
              </text>
            </MotionFade>
          </div>
          {streamKeyUnavailable ? (
            <div style={{ height: 18, marginTop: 7, display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}>
              <StatusDot color={palette.accentRose} />
              <text style={{ color: palette.accentRose, fontFamily: FONT_UI, fontSize: 12 }}>
                密钥无法读取，请重新填写
              </text>
            </div>
          ) : null}
        </div>

        <div
          style={{
            width: 188,
            flexShrink: 0,
            position: "relative",
            paddingLeft: 19,
            borderLeftWidth: 1,
            borderColor: palette.columnDivider,
          }}
        >
          <SectionHeading
            title="B 站账号"
            subtitle={
              bilibiliAuth?.stage === "authenticated"
                ? bilibiliAuth.persistence === "session"
                  ? `已登录 · ${bilibiliAuth.display_name ?? "Bilibili 用户"} · 仅本次`
                  : `已登录 · ${bilibiliAuth.display_name ?? "Bilibili 用户"}`
                : bilibiliAuth?.persistence === "unavailable"
                  ? "本机登录信息无法读取，请重新扫码"
                  : "未登录时最高 480P"
            }
            compact
            palette={palette}
          />
          <Segmented
            value={loginMode}
            onChange={updateLogin}
            options={LOGIN_OPTIONS}
            width={170}
            palette={palette}
          />
          <div style={{ height: 1, marginTop: 10, marginRight: 8, marginBottom: 10, marginLeft: 8, backgroundColor: palette.surfaceDivider }} />
          <SectionHeading title="外观" compact palette={palette} />
          <Segmented
            value={themePreference}
            onChange={updateTheme}
            options={THEME_OPTIONS}
            optionWeights={THEME_OPTION_WEIGHTS}
            width={170}
            palette={palette}
          />
        </div>
      </div>

      <div
        style={{
          minHeight: compactMediaRow ? 30 : 44,
          marginTop: 18,
          paddingTop: 14,
          paddingLeft: 8,
          paddingRight: 8,
          borderTopWidth: 1,
          borderColor: palette.surfaceDivider,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ width: 80, display: "flex", flexDirection: "row", alignItems: "center", gap: 3 }}>
          <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 13, fontWeight: 600 }}>
            视频处理
          </text>
          <HelpButton kind="media" palette={palette} />
        </div>
        <MotionFade
          key={mediaState}
          duration={MOTION.stateCrossfadeSeconds}
          style={{ minWidth: 0, flexGrow: 1, display: "flex", flexDirection: "column", gap: 3 }}
        >
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 7 }}>
            <StatusDot color={mediaStateDotColor(mediaState, palette)} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_UI, fontSize: 12, whiteSpace: "nowrap" }}>
              {mediaStateLabel(mediaState)}
            </text>
          </div>
          {mediaCaption ? (
            <text style={{ marginLeft: 12, color: palette.caption, fontFamily: FONT_UI, fontSize: 11.5 }}>
              {mediaCaption}
            </text>
          ) : null}
        </MotionFade>
        {mediaState === "missing" || mediaState === "failed" ? (
          <MotionFade key={`media-action-${mediaState}`} duration={MOTION.stateCrossfadeSeconds}>
            <Button
              label={mediaState === "failed" ? "重试下载" : "下载 FFmpeg"}
              icon="download"
              palette={palette}
              onClick={onInstallFfmpeg}
            />
          </MotionFade>
        ) : mediaState === "downloading" ? (
          <MotionFade key="media-action-downloading" duration={MOTION.stateCrossfadeSeconds}>
            <Button label="下载中" icon="download" palette={palette} disabled />
          </MotionFade>
        ) : null}
      </div>

      <div
        style={{
          minHeight: 33,
          marginTop: 16,
          paddingTop: 12,
          borderTopWidth: 1,
          borderColor: palette.surfaceDivider,
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
          contentKey={saving ? "saving" : saved ? "saved" : "save"}
          onClick={() => void save()}
        />
        <div style={{ flexGrow: 1 }} />
        <MotionFade key={saveStatusText} duration={MOTION.stateCrossfadeSeconds} style={{ maxWidth: 190 }}>
          <text
            style={{
              maxWidth: 190,
              color: saveError || settingsError ? palette.accentRose : palette.caption,
              fontFamily: FONT_UI,
              fontSize: 12,
              lineClamp: 1,
            }}
          >
            {saveStatusText}
          </text>
        </MotionFade>
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
    <div style={{ height: 32, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 2 }}>
        {[0.45, 0.65, 0.85].map((opacity, index) => (
          <motion.div
            key={index}
            initial={REDUCED_MOTION ? false : { opacity: 0.2 }}
            animate={{ opacity }}
            transition={{
              duration: REDUCED_MOTION ? 0 : MOTION.stateCrossfadeSeconds,
              delay: REDUCED_MOTION ? 0 : index * 0.04,
              ease: MOTION.easeOut,
            }}
            style={{
              width: 3,
              height: 3,
              borderRadius: RADII.full,
              backgroundColor: palette.inkMuted,
            }}
          />
        ))}
      </div>
      <text style={{ color: palette.caption, fontFamily: FONT_UI, fontSize: 12.5 }}>正在读取链接</text>
    </div>
  );
}

export interface AppSurfaceProps {
  initialScene?: Scene;
  initialAppearance?: Appearance;
  initialThemePreference?: ThemePreference;
  initialSource?: string;
}

export function AppSurface({
  initialScene = "idle",
  initialAppearance = "light",
  initialThemePreference,
  initialSource,
}: AppSurfaceProps) {
  const [scene, setScene] = useState<Scene>(initialScene);
  const [lastMainScene, setLastMainScene] = useState<Scene>(
    initialScene === "settings" || initialScene === "danmaku" ? "idle" : initialScene,
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
  const [source, setSource] = useState(
    initialSource ?? (initialScene === "ready-vod" ? SAMPLE_VIDEO : ""),
  );
  const [part, setPart] = useState("2");
  const [playbackPosition, setPlaybackPosition] = useState(POSITION_BY_PART["2"] ?? 0);
  const [playbackUpdating, setPlaybackUpdating] = useState<PlaybackUpdate>(null);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
  const [playbackPaused, setPlaybackPaused] = useState(false);
  const [playbackToggling, setPlaybackToggling] = useState(false);
  const [playbackEndBehavior, setPlaybackEndBehavior] = useState<PlaybackEndBehavior>("pause");
  const [seekInteractionActive, setSeekInteractionActive] = useState(false);
  const [danmaku, setDanmaku] = useState<DanmakuVisibility>("shown");
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(DEFAULT_DANMAKU_SETTINGS);
  const [sourceResolution, setSourceResolution] = useState<SourceResolution | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [resumeRelayAfterSettings, setResumeRelayAfterSettings] = useState(false);
  const [relayStopping, setRelayStopping] = useState(false);
  const [conversionError, setConversionError] = useState("链接无法识别，检查后再试。");
  const [mediaStatus, setMediaStatus] = useState<FfmpegStatus | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [bilibiliAuth, setBilibiliAuth] = useState<BilibiliAuthStatus | null>(null);
  const [bilibiliAuthError, setBilibiliAuthError] = useState<string | null>(null);
  const [bilibiliAuthBusy, setBilibiliAuthBusy] = useState(false);
  const relayWorker = useRef<RelayWorkerClient | null>(null);
  const windowClosing = useRef(false);
  const conversionEpoch = useRef(0);
  const playbackEpoch = useRef(0);
  const completionActionSession = useRef<string | null>(null);
  const appliedPlaybackOptions = useRef<string | null>(null);
  const sceneBeforeConversion = useRef<Scene>(initialScene);
  const resolvedAppearance: Appearance =
    themePreference === "system" ? initialAppearance : themePreference;
  const palette = PALETTES[resolvedAppearance];
  const mediaState = mediaComponentState(mediaStatus, mediaError);
  const settingsExpanded =
    mediaState === "missing" ||
    mediaState === "failed" ||
    mediaState === "downloading" ||
    Boolean(mediaStateCaption(mediaState, mediaStatus));
  const singlePartVideo =
    sourceResolution?.kind === "video" && (sourceResolution.parts?.length ?? 0) <= 1;

  const closeApplication = () => {
    if (windowClosing.current) return;
    windowClosing.current = true;
    const finish = () => {
      disposeNativePartPopup();
      closeProductWindow();
      setTimeout(() => process.exit(0), 0);
    };
    const worker = relayWorker.current;
    if (worker) {
      void worker.close().finally(finish);
    } else {
      finish();
    }
  };

  useEffect(() => {
    const resize = setTimeout(
      () => setProductWindowClientSize(
        sceneWindowWidth(scene),
        sceneWindowHeight(scene, settingsExpanded, singlePartVideo),
      ),
      0,
    );
    return () => clearTimeout(resize);
  }, [scene, settingsExpanded, singlePartVideo]);

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
          applyBilibiliAuth({ stage: "expired", persistence: "none" });
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
    if (!relayStatus || !hasActivePublisher(relayStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const latest = await getRelayWorker().relayStatus(relayStatus.session_id);
        if (!cancelled) {
          setRelayStatus(latest);
          setPlaybackPaused(latest.paused);
          if (latest.position_seconds !== undefined && !seekInteractionActive && playbackUpdating === null) {
            setPlaybackPosition(latest.position_seconds);
          }
          if (latest.stage === "failed") setRelayError("中继启动失败，检查设置后再试。");
          if (hasActivePublisher(latest)) {
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
    const normalizedSource = source.trim();
    if (!normalizedSource) {
      setScene("idle");
      return;
    }
    const epoch = ++conversionEpoch.current;
    playbackEpoch.current += 1;
    sceneBeforeConversion.current = scene;
    setConversionError("链接无法识别，检查后再试。");
    setRelayError(null);
    setResumeRelayAfterSettings(false);
    setPlaybackUpdating(null);
    setPlaybackMessage(null);
    setPlaybackPaused(false);
    setSeekInteractionActive(false);
    completionActionSession.current = null;
    appliedPlaybackOptions.current = null;
    setSource(normalizedSource);
    setScene("loading");
    try {
      if (relayStatus && hasActivePublisher(relayStatus)) {
        await getRelayWorker().stopRelay(relayStatus.session_id);
      }
      setRelayStatus(null);
      const resolution = await getRelayWorker().resolveSource(normalizedSource);
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
          const started = await getRelayWorker().startRelay(
            resolution.session_id,
            options,
            0,
            resolution.kind === "video",
          );
          if (conversionEpoch.current === epoch) {
            appliedPlaybackOptions.current = started.paused
              ? null
              : playbackOptionsSignature(options);
            setRelayStatus(started);
            setPlaybackPaused(started.paused);
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
    remainPaused = playbackPaused,
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
    const previousWasActive = hasActivePublisher(previousRelay);

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
        remainPaused,
      );
      if (playbackEpoch.current !== epoch) {
        await getRelayWorker().stopRelay(playback.relay.session_id).catch(() => undefined);
        return;
      }

      setSourceResolution(playback.resolution);
      setPart(String(playback.resolution.selected_part ?? effectivePart));
      setPlaybackPosition(playback.relay.position_seconds ?? effectiveStart);
      setRelayStatus(playback.relay);
      setPlaybackPaused(playback.relay.paused);
      setRelayError(null);
      setPlaybackMessage(null);
      appliedPlaybackOptions.current = playback.relay.paused
        ? null
        : playbackOptionsSignature(options);
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
              : update === "danmaku"
                ? "弹幕更新失败 · 原内容仍在播放"
                : "播完处理失败 · 结束画面仍会保持",
        );
      } else {
        setRelayStatus(null);
        setRelayError(relayErrorMessage(error));
        setPlaybackMessage(
          update === "part"
            ? "切换失败 · 请重试"
            : update === "seek"
              ? "跳转失败 · 请重试"
              : update === "danmaku"
                ? "弹幕更新失败 · 请重试"
                : "播完处理失败 · 请重试",
        );
      }
    } finally {
      if (playbackEpoch.current === epoch) setPlaybackUpdating(null);
    }
  };

  useEffect(() => {
    if (relayStatus?.stage !== "draining") {
      completionActionSession.current = null;
      return;
    }
    if (
      completionActionSession.current === relayStatus.session_id
      || sourceResolution?.kind !== "video"
      || sourceResolution.routing.kind === "direct"
      || playbackUpdating !== null
      || playbackToggling
    ) return;

    const completionSession = relayStatus.session_id;
    completionActionSession.current = completionSession;
    const options = configuredPlaybackOptions(danmaku, danmakuSettings);
    const currentPart = sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
    const orderedParts = [...(sourceResolution.parts ?? [])]
      .sort((left, right) => left.page - right.page);
    const currentIndex = orderedParts.findIndex((entry) => entry.page === currentPart);
    const nextPart = currentIndex >= 0 ? orderedParts[currentIndex + 1] : undefined;
    const shouldAdvance = playbackEndBehavior === "next" && nextPart !== undefined;

    if (playbackEndBehavior === "repeat" || shouldAdvance) {
      void retargetPlayback(
        shouldAdvance ? nextPart.page : currentPart,
        0,
        "completion",
        options,
        false,
      );
      return;
    }

    const pauseAtCompletion = async () => {
      setPlaybackToggling(true);
      setPlaybackMessage(null);
      setRelayError(null);
      try {
        const completionPosition = relayStatus.position_seconds
          ?? sourceResolution.duration_seconds
          ?? playbackPosition;
        const updated = await getRelayWorker().setRelayPaused(
          completionSession,
          true,
          options,
          completionPosition,
        );
        setRelayStatus(updated);
        setPlaybackPosition(updated.position_seconds ?? completionPosition);
        setPlaybackPaused(updated.paused);
        appliedPlaybackOptions.current = null;
      } catch (error) {
        setRelayError(relayErrorMessage(error));
        setPlaybackMessage("播完暂停失败 · 结束画面仍会保持");
      } finally {
        setPlaybackToggling(false);
      }
    };
    void pauseAtCompletion();
  }, [
    relayStatus?.stage,
    relayStatus?.session_id,
    playbackEndBehavior,
    playbackUpdating,
    playbackToggling,
  ]);

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
    if (playbackPaused || sourceResolution.routing.kind === "direct") return;
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
      setPlaybackPaused(false);
      setRelayError(null);
    } catch (error) {
      setRelayError(relayErrorMessage(error));
    } finally {
      setRelayStopping(false);
    }
  };

  const togglePlayback = async () => {
    if (sourceResolution === null) {
      setPlaybackPaused((current) => !current);
      return;
    }
    if (
      sourceResolution.kind !== "video"
      || sourceResolution.routing.kind === "direct"
      || playbackToggling
      || playbackUpdating !== null
      || relayStatus?.stage === "starting"
    ) return;
    if (relayStatus?.stage === "draining") {
      const requestedPart = sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
      void retargetPlayback(requestedPart, 0, "seek");
      return;
    }

    setPlaybackToggling(true);
    setPlaybackMessage(null);
    setRelayError(null);
    try {
      const active = relayStatus?.stage === "running";
      if (active && relayStatus) {
        const nextPaused = !relayStatus.paused;
        const options = configuredPlaybackOptions(danmaku, danmakuSettings);
        const selectedPart = sourceResolution.selected_part ?? (Number.parseInt(part, 10) || 1);
        const selectedDuration = sourceResolution.parts
          ?.find((entry) => entry.page === selectedPart)
          ?.duration_seconds
          ?? sourceResolution.duration_seconds
          ?? 0;
        const requestedPosition = !nextPaused
          && selectedDuration > 0
          && playbackPosition >= selectedDuration - 1
            ? 0
            : playbackPosition;
        const updated = await getRelayWorker().setRelayPaused(
          relayStatus.session_id,
          nextPaused,
          options,
          requestedPosition,
        );
        if (!nextPaused) appliedPlaybackOptions.current = playbackOptionsSignature(options);
        setRelayStatus(updated);
        if (updated.position_seconds !== undefined) setPlaybackPosition(updated.position_seconds);
        setPlaybackPaused(updated.paused);
        return;
      }
      if (!playbackPaused || !sourceResolution.session_id) return;
      const options = configuredPlaybackOptions(danmaku, danmakuSettings);
      const started = await getRelayWorker().startRelay(
        sourceResolution.session_id,
        options,
        playbackPosition,
        false,
      );
      appliedPlaybackOptions.current = playbackOptionsSignature(options);
      setRelayStatus(started);
      if (started.position_seconds !== undefined) setPlaybackPosition(started.position_seconds);
      setPlaybackPaused(false);
    } catch (error) {
      setRelayError(relayErrorMessage(error));
      setPlaybackMessage(playbackPaused ? "继续播放失败" : "暂停失败");
    } finally {
      setPlaybackToggling(false);
    }
  };

  const cancelConversion = () => {
    conversionEpoch.current += 1;
    const previous = sceneBeforeConversion.current;
    const fallback = sourceResolution ? "ready-vod" : "idle";
    setScene(
      previous === "loading" || previous === "settings" || previous === "danmaku"
        ? fallback
        : previous,
    );
  };

  const resumePreparedRelay = async () => {
    const resolution = sourceResolution;
    if (!resolution?.session_id) return;
    const epoch = ++conversionEpoch.current;
    const options = configuredPlaybackOptions(danmaku, danmakuSettings);
    setRelayStatus(null);
    setRelayError(null);
    setPlaybackMessage("正在继续生成地址");
    try {
      const started = await getRelayWorker().startRelay(
        resolution.session_id,
        options,
        playbackPosition,
        resolution.kind === "video",
      );
      if (conversionEpoch.current !== epoch) return;
      appliedPlaybackOptions.current = started.paused
        ? null
        : playbackOptionsSignature(options);
      setRelayStatus(started);
      setPlaybackPaused(started.paused);
      if (started.position_seconds !== undefined) setPlaybackPosition(started.position_seconds);
    } catch (error) {
      if (conversionEpoch.current === epoch) setRelayError(relayErrorMessage(error));
    } finally {
      if (conversionEpoch.current === epoch) setPlaybackMessage(null);
    }
  };

  const showSubview = (next: "settings" | "danmaku") => {
    conversionEpoch.current += 1;
    if (scene !== "settings" && scene !== "danmaku") {
      setLastMainScene(scene === "loading" ? (sourceResolution ? "ready-vod" : "idle") : scene);
    }
    setScene(next);
    if (next === "settings") {
      const active = hasActivePublisher(relayStatus);
      setResumeRelayAfterSettings(Boolean(relayError && sourceResolution?.session_id && !active));
      if (!settingsReady || settingsError) void refreshProductSettings();
      void refreshMediaState();
      void refreshBilibiliAuth();
    }
  };

  const leaveSubview = () => {
    const returnScene = lastMainScene === "settings" || lastMainScene === "danmaku"
      ? sourceResolution
        ? "ready-vod"
        : "idle"
      : lastMainScene;
    const shouldResumeRelay = scene === "settings"
      && resumeRelayAfterSettings
      && relaySettingsReady(productSettings)
      && Boolean(sourceResolution?.session_id);
    const active = relayStatus?.stage === "starting" || relayStatus?.stage === "running";
    const options = configuredPlaybackOptions(danmaku, danmakuSettings);
    const shouldApplyDanmaku = scene === "danmaku"
      && active
      && (sourceResolution?.kind === "video" || sourceResolution?.kind === "live")
      && appliedPlaybackOptions.current !== playbackOptionsSignature(options);
    setResumeRelayAfterSettings(false);
    setScene(shouldResumeRelay ? "ready-vod" : returnScene);
    if (shouldResumeRelay) {
      void resumePreparedRelay();
      return;
    }
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
        userSelect: "none",
        backgroundColor: palette.panel,
      }}
    >
      <Header
        palette={palette}
        scene={scene}
        onSettings={() => showSubview("settings")}
        onBack={leaveSubview}
        onClose={closeApplication}
      />
      <div
        style={{
          height: 1,
          marginLeft: 26,
          marginRight: 26,
          backgroundColor: palette.surfaceDivider,
        }}
      />
      {scene === "settings" ? (
        <MotionFade key="settings" style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
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
            onRevealStreamKey={() => getRelayWorker().revealStreamKey()}
            mediaState={mediaState}
            mediaStatus={mediaStatus}
            onInstallFfmpeg={() => void installFfmpeg()}
          />
        </MotionFade>
      ) : scene === "danmaku" ? (
        <MotionFade key="danmaku" style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <DanmakuView
            palette={palette}
            visibility={danmaku}
            setVisibility={setDanmaku}
            settings={danmakuSettings}
            setSettings={setDanmakuSettings}
          />
        </MotionFade>
      ) : (
        <div style={{ flexGrow: 1, minHeight: 0, paddingTop: 17, paddingRight: 26, paddingBottom: 16, paddingLeft: 26 }}>
          <div style={{ height: 17, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusDot color={palette.accentTeal} />
            <text style={{ color: palette.inkMuted, fontFamily: FONT_SERIF, fontSize: 13, fontWeight: 600 }}>
              视频链接
            </text>
          </div>
          <div style={{ marginTop: 7 }}>
            <SourceField source={source} setSource={setSource} palette={palette} />
          </div>
          <div style={{ minHeight: 33, marginTop: 9, display: "flex", flexDirection: "row", alignItems: "center", gap: 9 }}>
            <Button
              label="生成地址"
              palette={palette}
              icon="play"
              iconColor={palette.accentTeal}
              onClick={() => void convert()}
              disabled={!source.trim() || scene === "loading" || playbackUpdating !== null}
              testId="convert-source"
            />
            {scene === "loading" ? (
              <MotionFade key="loading" duration={MOTION.stateCrossfadeSeconds}>
                <Loading palette={palette} />
              </MotionFade>
            ) : null}
            {scene === "loading" ? (
              <div style={{ flexGrow: 1, display: "flex", justifyContent: "flex-end" }}>
                <MotionFade key="cancel-conversion" duration={MOTION.stateCrossfadeSeconds}>
                  <Button label="取消" palette={palette} quiet onClick={cancelConversion} />
                </MotionFade>
              </div>
            ) : null}
          </div>

          {scene === "error" ? (
            <MotionFade
              key="error"
              style={{
                minHeight: 36,
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
              <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 12.5 }}>
                {conversionError}
              </text>
              <div style={{ flexGrow: 1 }} />
              <Button label="重试" palette={palette} quiet onClick={() => void convert()} />
            </MotionFade>
          ) : null}

          {scene === "ready-vod" ? (
            <MotionFade key="ready-vod">
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
                playbackPaused={playbackPaused}
                playbackToggling={playbackToggling}
                onTogglePlayback={() => void togglePlayback()}
                playbackEndBehavior={playbackEndBehavior}
                onPlaybackEndBehaviorChange={setPlaybackEndBehavior}
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
            </MotionFade>
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
      return "没有找到可用的视频流。";
    case "unsupported_media_source":
    case "invalid_media_source":
      return "暂不支持这个媒体链接。";
    case "ffprobe_start_failed":
    case "ffprobe_status_failed":
      return "视频处理组件无法启动，请在设置中重新下载。";
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
    case "bilibili_session_storage_failed":
      return "本机登录信息暂时无法更新，请重试。";
    case "settings_read_failed":
      return "本机设置暂时无法读取。";
    case "settings_write_failed":
      return "设置没有保存，请检查磁盘空间后重试。";
    case "settings_invalid_data":
      return "本机设置内容有误，请恢复默认后保存。";
    case "settings_too_large":
      return "设置内容过长，检查后再保存。";
    case "settings_secret_unavailable":
      return "已保存的推流密钥无法读取，请重新填写。";
    case "settings_encryption_unavailable":
      return "当前系统无法安全保存推流密钥。";
    case "settings_encryption_failed":
      return "推流密钥没有保存，请稍后重试。";
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
      return "当前视频处理组件不支持直播弹幕，请在设置中重新下载。";
    case "ffmpeg_start_failed":
    case "ffmpeg_status_failed":
      return "视频处理组件无法启动，请检查相关设置。";
    case "ffmpeg_install_failed":
      return "视频处理组件暂时无法下载，请稍后重试。";
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
      return "FFmpeg 已就绪";
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

function mediaStateCaption(state: MediaComponentState, status: FfmpegStatus | null): string | null {
  switch (state) {
    case "checking":
      return null;
    case "external":
      return null;
    case "managed":
      return null;
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
