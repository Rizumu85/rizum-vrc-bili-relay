export const RELAY_PROTOCOL_VERSION = 7;

export type SourceKind = "video" | "live" | "media" | "short_link";
export type RelayNextStep =
  | "probe_direct_playback"
  | "resolve_live_room"
  | "probe_media"
  | "expand_short_link";

export interface SourceInspection {
  kind: SourceKind;
  source_id?: string;
  canonical_url?: string;
  requires_network_resolution: boolean;
  next_step: RelayNextStep;
}

export interface VideoPart {
  page: number;
  cid: number;
  title: string;
  duration_seconds: number;
}

export interface SourceResolution {
  kind: "video" | "live" | "media";
  source_id: string;
  canonical_url: string;
  title: string;
  parts?: VideoPart[];
  selected_part?: number;
  duration_seconds?: number;
  live_status?: "offline" | "live" | "replay";
  routing: RouteDecision;
  playback_url?: string;
  session_id?: string;
  session_expires_in_seconds?: number;
}

export interface RelayTarget {
  ingest_server: string;
  stream_key: string;
  playback_url: string;
  start_seconds?: number;
}

export interface RelayStatus {
  session_id: string;
  stage: "starting" | "running" | "completed" | "stopped" | "failed";
  playback_url?: string;
  position_seconds?: number;
  diagnostic?: string;
}

export interface RouteDecision {
  kind: "direct" | "relay_proxy" | "relay_with_ffmpeg" | "unavailable";
  reason:
    | "direct_compatible"
    | "requires_headers"
    | "expiring_url"
    | "dash_tracks"
    | "flv_container"
    | "mpeg_ts_container"
    | "source_offline"
    | "source_replay";
  media_format?: "dash" | "flv" | "mpeg_ts" | "hls" | "mp4";
  quality?: number;
  estimated_bitrate?: number;
  has_separate_audio: boolean;
}

export interface FfmpegStatus {
  availability: "system" | "managed" | "missing" | "installing" | "failed";
  path?: string;
  probe_path?: string;
  version?: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  diagnostic?: string;
}

export interface HealthReply {
  type: "health";
  protocol_version: number;
  backend_version: string;
  ffmpeg: FfmpegStatus;
}

export interface SourceInspectionReply {
  type: "source_inspection";
  inspection: SourceInspection;
}

export interface SourceResolutionReply {
  type: "source_resolution";
  resolution: SourceResolution;
}

export interface RelayStateReply {
  type: "relay_state";
  relay: RelayStatus;
}

export interface PlaybackStateReply {
  type: "playback_state";
  resolution: SourceResolution;
  relay: RelayStatus;
}

export interface FfmpegStateReply {
  type: "ffmpeg_state";
  ffmpeg: FfmpegStatus;
}

export interface ShutdownAcceptedReply {
  type: "shutdown_accepted";
}

export type RelayReply =
  | HealthReply
  | SourceInspectionReply
  | SourceResolutionReply
  | RelayStateReply
  | PlaybackStateReply
  | FfmpegStateReply
  | ShutdownAcceptedReply;

export interface RelayFailure {
  code: string;
  message: string;
}

export type RelayResponse =
  | { status: "ok"; id: number; result: RelayReply }
  | { status: "error"; id: number; error: RelayFailure };
