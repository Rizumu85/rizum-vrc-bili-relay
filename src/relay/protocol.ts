export const RELAY_PROTOCOL_VERSION = 2;

export type SourceKind = "video" | "live" | "short_link";
export type RelayNextStep =
  | "probe_direct_playback"
  | "resolve_live_room"
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
  kind: "video" | "live";
  source_id: string;
  canonical_url: string;
  title: string;
  parts?: VideoPart[];
  selected_part?: number;
  duration_seconds?: number;
  live_status?: "offline" | "live" | "replay";
}

export interface FfmpegStatus {
  availability: "system" | "missing";
  path?: string;
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

export interface ShutdownAcceptedReply {
  type: "shutdown_accepted";
}

export type RelayReply =
  | HealthReply
  | SourceInspectionReply
  | SourceResolutionReply
  | ShutdownAcceptedReply;

export interface RelayFailure {
  code: string;
  message: string;
}

export type RelayResponse =
  | { status: "ok"; id: number; result: RelayReply }
  | { status: "error"; id: number; error: RelayFailure };
