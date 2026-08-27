use serde::{Deserialize, Serialize};
use url::Url;

mod bilibili;
mod danmaku;
mod ffmpeg;
mod ffmpeg_manager;
mod media_session;
mod media_source;

use bilibili::BilibiliClient;
use danmaku::{DanmakuOverlay, DanmakuService};
use ffmpeg_manager::FfmpegManager;
use media_session::MediaSessionStore;

pub const PROTOCOL_VERSION: u32 = 8;

#[derive(Debug, Deserialize)]
pub struct RequestEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Health,
    InspectSource {
        source: String,
    },
    ResolveSource {
        source: String,
        #[serde(default)]
        requested_part: Option<u32>,
    },
    StartRelay {
        session_id: String,
        target: RelayTarget,
        #[serde(default)]
        options: PlaybackOptions,
    },
    RetargetRelay {
        current_session_id: Option<String>,
        source: String,
        requested_part: u32,
        target: RelayTarget,
        #[serde(default)]
        options: PlaybackOptions,
    },
    RelayStatus {
        session_id: String,
    },
    StopRelay {
        session_id: String,
    },
    EnsureFfmpeg,
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResponseEnvelope {
    Ok { id: u64, result: Box<Reply> },
    Error { id: u64, error: RelayError },
}

impl ResponseEnvelope {
    pub fn from_result(id: u64, result: Result<Reply, RelayError>) -> Self {
        match result {
            Ok(result) => Self::Ok {
                id,
                result: Box::new(result),
            },
            Err(error) => Self::Error { id, error },
        }
    }

    pub fn protocol_error(message: impl Into<String>) -> Self {
        Self::Error {
            id: 0,
            error: RelayError::new("invalid_request", message),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Health {
        protocol_version: u32,
        backend_version: &'static str,
        ffmpeg: FfmpegStatus,
    },
    SourceInspection {
        inspection: SourceInspection,
    },
    SourceResolution {
        resolution: SourceResolution,
    },
    RelayState {
        relay: RelayStatus,
    },
    PlaybackState {
        resolution: SourceResolution,
        relay: RelayStatus,
    },
    FfmpegState {
        ffmpeg: FfmpegStatus,
    },
    ShutdownAccepted,
}

impl Reply {
    pub fn should_shutdown(&self) -> bool {
        matches!(self, Self::ShutdownAccepted)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayError {
    pub code: &'static str,
    pub message: String,
}

impl RelayError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FfmpegStatus {
    pub availability: FfmpegAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FfmpegAvailability {
    System,
    Managed,
    Missing,
    Installing,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInspection {
    pub kind: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    pub requires_network_resolution: bool,
    pub next_step: NextStep,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceResolution {
    pub kind: SourceKind,
    pub source_id: String,
    pub canonical_url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<VideoPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_part: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_status: Option<LiveStatus>,
    pub routing: RouteDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_expires_in_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelayTarget {
    pub ingest_server: String,
    pub stream_key: String,
    pub playback_url: String,
    #[serde(default)]
    pub start_seconds: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PlaybackOptions {
    pub danmaku: DanmakuSettings,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct DanmakuSettings {
    pub enabled: bool,
    pub size: DanmakuSize,
    pub area: DanmakuArea,
    pub speed: DanmakuSpeed,
    pub opacity: u8,
    pub font: DanmakuFont,
    pub weight: DanmakuWeight,
    pub outline: DanmakuOutline,
    pub hidden_types: Vec<DanmakuFilter>,
}

impl Default for DanmakuSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            size: DanmakuSize::Medium,
            area: DanmakuArea::Half,
            speed: DanmakuSpeed::Normal,
            opacity: 80,
            font: DanmakuFont::MicrosoftYahei,
            weight: DanmakuWeight::Bold,
            outline: DanmakuOutline::Heavy,
            hidden_types: vec![DanmakuFilter::Advanced],
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuSize {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuArea {
    Quarter,
    #[default]
    Half,
    Full,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuSpeed {
    Slow,
    #[default]
    Normal,
    Fast,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuFont {
    #[default]
    MicrosoftYahei,
    NotoSansSc,
    SourceHanSans,
    Simhei,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuWeight {
    Regular,
    #[default]
    Bold,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuOutline {
    #[default]
    Heavy,
    Outline,
    Shadow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuFilter {
    Rolling,
    Fixed,
    Colored,
    Advanced,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayStatus {
    pub session_id: String,
    pub stage: RelayStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danmaku_events: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayStage {
    Starting,
    Running,
    Completed,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteDecision {
    pub kind: RouteKind,
    pub reason: RouteReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_format: Option<MediaFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_bitrate: Option<u64>,
    pub has_separate_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Direct,
    RelayProxy,
    RelayWithFfmpeg,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteReason {
    DirectCompatible,
    RequiresHeaders,
    ExpiringUrl,
    DashTracks,
    FlvContainer,
    MpegTsContainer,
    SourceOffline,
    SourceReplay,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaFormat {
    Dash,
    Flv,
    MpegTs,
    Hls,
    Mp4,
}

#[derive(Debug, Clone)]
pub(crate) struct MediaInput {
    pub video_url: String,
    pub audio_url: Option<String>,
    pub referer: String,
    pub is_live: bool,
    pub requires_bilibili_headers: bool,
    pub danmaku_source: Option<danmaku::VideoDanmakuSource>,
}

pub(crate) struct ResolvedSource {
    pub resolution: SourceResolution,
    pub input: Option<MediaInput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoPart {
    pub page: u32,
    pub cid: u64,
    pub title: String,
    pub duration_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStatus {
    Offline,
    Live,
    Replay,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Video,
    Live,
    Media,
    ShortLink,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NextStep {
    ProbeDirectPlayback,
    ResolveLiveRoom,
    ProbeMedia,
    ExpandShortLink,
}

pub struct RelayCore {
    ffmpeg: FfmpegManager,
    bilibili: BilibiliClient,
    danmaku: DanmakuService,
    sessions: MediaSessionStore,
}

impl Default for RelayCore {
    fn default() -> Self {
        Self::new()
    }
}

impl RelayCore {
    pub fn new() -> Self {
        Self {
            ffmpeg: FfmpegManager::new(),
            bilibili: BilibiliClient::new(),
            danmaku: DanmakuService::new(),
            sessions: MediaSessionStore::new(),
        }
    }

    pub fn handle(&mut self, command: Command) -> Result<Reply, RelayError> {
        match command {
            Command::Health => Ok(Reply::Health {
                protocol_version: PROTOCOL_VERSION,
                backend_version: env!("CARGO_PKG_VERSION"),
                ffmpeg: self.ffmpeg.status(),
            }),
            Command::InspectSource { source } => Ok(Reply::SourceInspection {
                inspection: inspect_source(&source)?,
            }),
            Command::ResolveSource {
                source,
                requested_part,
            } => {
                let inspection = inspect_source(&source)?;
                let resolved = if matches!(inspection.kind, SourceKind::Media) {
                    let ffprobe_path = self.ffmpeg.probe_path().ok_or_else(|| {
                        RelayError::new(
                            "ffmpeg_missing",
                            "A complete FFmpeg and FFprobe toolchain is required to analyze media URLs",
                        )
                    })?;
                    media_source::resolve(&source, &ffprobe_path)?
                } else {
                    self.bilibili.resolve(&source, requested_part)?
                };
                Ok(Reply::SourceResolution {
                    resolution: self.sessions.prepare(resolved),
                })
            }
            Command::StartRelay {
                session_id,
                mut target,
                options,
            } => {
                media_session::validate_relay_target(&target)?;
                let ffmpeg_path = self.ffmpeg.executable_path().ok_or_else(|| {
                    RelayError::new("ffmpeg_missing", "No usable FFmpeg executable was found")
                })?;
                let (overlay, normalized_start) = self.prepare_danmaku_overlay(
                    &session_id,
                    &options.danmaku,
                    target.start_seconds,
                )?;
                target.start_seconds = normalized_start;
                Ok(Reply::RelayState {
                    relay: self
                        .sessions
                        .start(&session_id, target, Some(&ffmpeg_path), overlay)?,
                })
            }
            Command::RetargetRelay {
                current_session_id,
                source,
                requested_part,
                mut target,
                options,
            } => {
                media_session::validate_relay_target(&target)?;
                let ffmpeg_path = self.ffmpeg.executable_path().ok_or_else(|| {
                    RelayError::new("ffmpeg_missing", "No usable FFmpeg executable was found")
                })?;
                let resolved = self.bilibili.resolve(&source, Some(requested_part))?;
                let resolution = self.sessions.prepare(resolved);
                let next_session_id = resolution.session_id.clone().ok_or_else(|| {
                    RelayError::new(
                        "media_session_not_available",
                        "Selected video part cannot be relayed",
                    )
                })?;
                let (next_overlay, normalized_start) = self.prepare_danmaku_overlay(
                    &next_session_id,
                    &options.danmaku,
                    target.start_seconds,
                )?;
                target.start_seconds = normalized_start;
                let suspended = current_session_id
                    .as_deref()
                    .and_then(|session_id| self.sessions.suspend(session_id));
                let restoration_required = suspended
                    .as_ref()
                    .is_some_and(|previous| previous.was_active);
                match self.sessions.start(
                    &next_session_id,
                    target.clone(),
                    Some(&ffmpeg_path),
                    next_overlay,
                ) {
                    Ok(relay) => Ok(Reply::PlaybackState { resolution, relay }),
                    Err(mut error) => {
                        let restored = if let (Some(previous_session_id), Some(previous)) =
                            (current_session_id.as_deref(), suspended)
                            && previous.was_active
                        {
                            let mut resume_target = target;
                            resume_target.start_seconds = previous.position_seconds.unwrap_or(0.0);
                            self.prepare_danmaku_overlay(
                                previous_session_id,
                                &options.danmaku,
                                resume_target.start_seconds,
                            )
                            .and_then(|(overlay, normalized_start)| {
                                resume_target.start_seconds = normalized_start;
                                self.sessions.start(
                                    previous_session_id,
                                    resume_target,
                                    Some(&ffmpeg_path),
                                    overlay,
                                )
                            })
                            .is_ok()
                        } else {
                            !restoration_required
                        };
                        if !restored {
                            error.code = "retarget_restore_failed";
                            error
                                .message
                                .push_str("; the previous relay could not be restored");
                        }
                        Err(error)
                    }
                }
            }
            Command::RelayStatus { session_id } => Ok(Reply::RelayState {
                relay: self.sessions.status(&session_id)?,
            }),
            Command::StopRelay { session_id } => Ok(Reply::RelayState {
                relay: self.sessions.stop(&session_id)?,
            }),
            Command::EnsureFfmpeg => Ok(Reply::FfmpegState {
                ffmpeg: self.ffmpeg.ensure_installed()?,
            }),
            Command::Shutdown => {
                self.ffmpeg.shutdown();
                self.sessions.shutdown();
                Ok(Reply::ShutdownAccepted)
            }
        }
    }

    fn prepare_danmaku_overlay(
        &mut self,
        session_id: &str,
        settings: &DanmakuSettings,
        requested_start: f64,
    ) -> Result<(Option<DanmakuOverlay>, f64), RelayError> {
        let (source, normalized_start) = self
            .sessions
            .playback_context(session_id, requested_start)?;
        let overlay = match source {
            Some(source) => self.danmaku.prepare(&source, settings, normalized_start)?,
            None => None,
        };
        Ok((overlay, normalized_start))
    }
}

pub fn inspect_source(source: &str) -> Result<SourceInspection, RelayError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(RelayError::new("empty_source", "Media source is empty"));
    }

    if is_video_id(source) {
        return Ok(video_inspection(source));
    }

    let url = Url::parse(source).map_err(|_| {
        RelayError::new(
            "invalid_source",
            "Source is not a valid URL or Bilibili video id",
        )
    })?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();

    if host == "b23.tv" || host.ends_with(".b23.tv") {
        return Ok(SourceInspection {
            kind: SourceKind::ShortLink,
            source_id: None,
            canonical_url: Some(url.to_string()),
            requires_network_resolution: true,
            next_step: NextStep::ExpandShortLink,
        });
    }

    if host == "live.bilibili.com" || host.ends_with(".live.bilibili.com") {
        let room_id = url
            .path_segments()
            .and_then(|mut segments| segments.find(|segment| !segment.is_empty()))
            .filter(|segment| segment.chars().all(|character| character.is_ascii_digit()))
            .ok_or_else(|| {
                RelayError::new(
                    "invalid_live_room",
                    "Live URL does not contain a numeric room id",
                )
            })?;

        return Ok(SourceInspection {
            kind: SourceKind::Live,
            source_id: Some(room_id.to_string()),
            canonical_url: Some(format!("https://live.bilibili.com/{room_id}")),
            requires_network_resolution: true,
            next_step: NextStep::ResolveLiveRoom,
        });
    }

    if let Some(inspection) = media_source::inspect(&url) {
        return Ok(inspection);
    }

    if host == "bilibili.com" || host.ends_with(".bilibili.com") {
        let segments: Vec<_> = url
            .path_segments()
            .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
            .unwrap_or_default();

        if let Some(video_id) = segments
            .windows(2)
            .find(|pair| pair[0].eq_ignore_ascii_case("video"))
            .map(|pair| pair[1])
            .filter(|candidate| is_video_id(candidate))
        {
            return Ok(video_inspection(video_id));
        }
    }

    Err(RelayError::new(
        "unsupported_source",
        "Only Bilibili pages and HTTP(S) MP4, HLS, MPEG-TS, or FLV media links are supported",
    ))
}

fn video_inspection(video_id: &str) -> SourceInspection {
    let normalized_id = if video_id[..2].eq_ignore_ascii_case("bv") {
        format!("BV{}", &video_id[2..])
    } else {
        format!("av{}", &video_id[2..])
    };
    SourceInspection {
        kind: SourceKind::Video,
        source_id: Some(normalized_id.clone()),
        canonical_url: Some(format!("https://www.bilibili.com/video/{normalized_id}")),
        requires_network_resolution: true,
        next_step: NextStep::ProbeDirectPlayback,
    }
}

fn is_video_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let is_bv = bytes.len() == 12
        && bytes
            .first()
            .is_some_and(|value| value.eq_ignore_ascii_case(&b'b'))
        && bytes
            .get(1)
            .is_some_and(|value| value.eq_ignore_ascii_case(&b'v'))
        && bytes[2..].iter().all(u8::is_ascii_alphanumeric);
    let is_av = bytes.len() > 2
        && bytes
            .first()
            .is_some_and(|value| value.eq_ignore_ascii_case(&b'a'))
        && bytes
            .get(1)
            .is_some_and(|value| value.eq_ignore_ascii_case(&b'v'))
        && bytes[2..].iter().all(u8::is_ascii_digit);
    is_bv || is_av
}
