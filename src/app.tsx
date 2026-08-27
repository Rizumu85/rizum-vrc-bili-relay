import { useEffect, useRef, useState } from "react";
import { type EventPayload } from "@gpuix/react";
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

type Scene = "loading" | "error" | "ready-vod";
type DanmakuVisibility = "shown" | "hidden";
type DanmakuStyle = "standard" | "bold" | "shadow";

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
  appearance,
  onToggleAppearance,
}: {
  palette: Palette;
  appearance: Appearance;
  onToggleAppearance: () => void;
}) {
  return (
    <div
      style={{
        minHeight: 72,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingTop: 16,
        paddingRight: 24,
        paddingBottom: 11,
        paddingLeft: 24,
      }}
    >
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
      <div style={{ minWidth: 0, flexGrow: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <text
          style={{
            color: palette.ink,
            fontFamily: FONT_SERIF,
            fontSize: 16,
            fontWeight: 600,
            lineHeight: 22,
          }}
        >
          VRC Bili Relay
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
          把 B 站链接转换成 VRChat 播放地址
        </text>
      </div>
      <IconButton
        name="settings"
        palette={palette}
        label={`appearance-${appearance}`}
        onClick={onToggleAppearance}
      />
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

function Segmented({
  value,
  onChange,
  palette,
}: {
  value: DanmakuVisibility;
  onChange: (value: DanmakuVisibility) => void;
  palette: Palette;
}) {
  return (
    <div
      style={{
        width: 92,
        height: 24,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        padding: 3,
        borderRadius: RADII.control,
        backgroundColor: palette.surfaceMuted,
      }}
    >
      {(["shown", "hidden"] as const).map((option) => {
        const selected = value === option;
        return (
          <div
            key={option}
            tabIndex={0}
            onClick={() => onChange(option)}
            onKeyDown={(event) => {
              if (event.key === "enter" || event.key === "space") onChange(option);
            }}
            style={{
              width: 43,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              backgroundColor: selected ? palette.nestedStrong : "#00000000",
              cursor: "pointer",
              userSelect: "none",
              hover: selected ? undefined : { backgroundColor: palette.surfaceHover },
            }}
          >
            <text
              style={{
                color: selected ? palette.inkSoft : palette.caption,
                fontFamily: FONT_UI,
                fontSize: 10.5,
              }}
            >
              {option === "shown" ? "显示" : "隐藏"}
            </text>
          </div>
        );
      })}
    </div>
  );
}

function StylePopover({
  value,
  setValue,
  palette,
}: {
  value: DanmakuStyle;
  setValue: (value: DanmakuStyle) => void;
  palette: Palette;
}) {
  const options: Array<{ value: DanmakuStyle; label: string }> = [
    { value: "standard", label: "标准" },
    { value: "bold", label: "粗体" },
    { value: "shadow", label: "投影" },
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 36,
        right: 0,
        width: 156,
        padding: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.panelEdge,
        backgroundColor: palette.nestedStrong,
        boxShadow: {
          offsetX: 0,
          offsetY: 12,
          blurRadius: 28,
          spreadRadius: 0,
          color: palette.panelShadow,
        },
      }}
    >
      {options.map((option) => (
        <div
          key={option.value}
          onClick={() => setValue(option.value)}
          style={{
            height: 28,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 7,
            cursor: "pointer",
            backgroundColor: value === option.value ? palette.surfaceActive : "#00000000",
            hover: { backgroundColor: palette.surfaceHover },
          }}
        >
          <text style={{ color: palette.inkSoft, fontFamily: FONT_UI, fontSize: 11.5 }}>
            {option.label}
          </text>
          {value === option.value ? <Icon name="check" size={10} color={palette.accentTeal} /> : null}
        </div>
      ))}
    </div>
  );
}

function Result({
  palette,
  part,
  setPart,
}: {
  palette: Palette;
  part: string;
  setPart: (part: string) => void;
}) {
  const [danmaku, setDanmaku] = useState<DanmakuVisibility>("shown");
  const [danmakuStyle, setDanmakuStyle] = useState<DanmakuStyle>("standard");
  const [styleOpen, setStyleOpen] = useState(false);
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
        <Segmented value={danmaku} onChange={setDanmaku} palette={palette} />
        <Button
          label="样式"
          palette={palette}
          onClick={() => setStyleOpen((open) => !open)}
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

      {styleOpen ? (
        <StylePopover
          value={danmakuStyle}
          setValue={(value) => {
            setDanmakuStyle(value);
            setStyleOpen(false);
          }}
          palette={palette}
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
}

export function AppSurface({
  initialScene = "ready-vod",
  initialAppearance = "light",
}: AppSurfaceProps) {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [scene, setScene] = useState<Scene>(initialScene);
  const [source, setSource] = useState(SAMPLE_VIDEO);
  const [part, setPart] = useState("2");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const palette = PALETTES[appearance];

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
        appearance={appearance}
        onToggleAppearance={() => setAppearance((value) => (value === "light" ? "dark" : "light"))}
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

        {scene === "ready-vod" ? <Result palette={palette} part={part} setPart={setPart} /> : null}
      </div>
    </div>
  );
}
