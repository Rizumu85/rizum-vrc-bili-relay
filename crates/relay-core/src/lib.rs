use serde::{Deserialize, Serialize};
use url::Url;

mod bilibili;
mod bilibili_auth;
mod bilibili_session;
mod danmaku;
mod ffmpeg;
mod ffmpeg_manager;
mod live_danmaku;
mod media_session;
mod media_source;
mod settings;
mod windows_secret;

use bilibili::BilibiliClient;
use danmaku::{DanmakuOverlay, DanmakuService};
use ffmpeg_manager::FfmpegManager;
use media_session::MediaSessionStore;
use settings::SettingsStore;

pub const PROTOCOL_VERSION: u32 = 22;

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
        #[serde(default)]
        start_seconds: f64,
        #[serde(default)]
        paused: bool,
        #[serde(default)]
        options: PlaybackOptions,
    },
    RetargetRelay {
        current_session_id: Option<String>,
        source: String,
        requested_part: u32,
        #[serde(default)]
        start_seconds: f64,
        #[serde(default)]
        paused: bool,
        #[serde(default)]
        options: PlaybackOptions,
    },
    RelayStatus {
        session_id: String,
    },
    SetRelayPaused {
        session_id: String,
        paused: bool,
        #[serde(default)]
        start_seconds: f64,
        #[serde(default)]
        options: PlaybackOptions,
    },
    SetRelayRate {
        session_id: String,
        #[serde(default)]
        options: PlaybackOptions,
    },
    StopRelay {
        session_id: String,
    },
    EnsureFfmpeg,
    BilibiliAuthStatus,
    BeginBilibiliLogin,
    PollBilibiliLogin {
        login_id: u64,
    },
    LogoutBilibili,
    GetSettings,
    RevealStreamKey,
    SaveSettings {
        settings: SettingsUpdate,
    },
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
    BilibiliAuthState {
        auth: BilibiliAuthStatus,
    },
    SettingsState {
        settings: ProductSettings,
    },
    StreamKeyValue {
        stream_key: String,
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
    pub collection: Option<VideoCollection>,
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

#[derive(Debug, Clone, Serialize)]
pub struct VideoCollection {
    pub id: u64,
    pub title: String,
    pub selected_item: u32,
    pub items: Vec<VideoCollectionItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoCollectionItem {
    pub index: u32,
    pub source_id: String,
    pub canonical_url: String,
    pub title: String,
    pub duration_seconds: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct RelayTarget {
    pub ingest_server: String,
    pub stream_key: String,
    pub playback_url: String,
    pub start_seconds: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PlaybackOptions {
    pub danmaku: DanmakuSettings,
    pub playback_rate: PlaybackRate,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
pub enum PlaybackRate {
    #[serde(rename = "0.5")]
    Half,
    #[serde(rename = "0.75")]
    ThreeQuarters,
    #[default]
    #[serde(rename = "1")]
    Normal,
    #[serde(rename = "1.25")]
    FiveQuarters,
    #[serde(rename = "1.5")]
    ThreeHalves,
    #[serde(rename = "2")]
    Double,
}

impl PlaybackRate {
    pub(crate) fn factor(self) -> f64 {
        match self {
            Self::Half => 0.5,
            Self::ThreeQuarters => 0.75,
            Self::Normal => 1.0,
            Self::FiveQuarters => 1.25,
            Self::ThreeHalves => 1.5,
            Self::Double => 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BilibiliAuthStatus {
    pub stage: BilibiliAuthStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr: Option<BilibiliLoginQr>,
    pub persistence: BilibiliPersistenceStatus,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BilibiliPersistenceStatus {
    #[default]
    None,
    Session,
    Saved,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BilibiliAuthStage {
    Guest,
    Waiting,
    Scanned,
    Authenticated,
    Expired,
}

#[derive(Debug, Clone, Serialize)]
pub struct BilibiliLoginQr {
    pub size: usize,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSettings {
    pub host: String,
    pub playback_url: String,
    pub theme: ThemePreference,
    pub stream_key_status: StreamKeyStatus,
    pub danmaku: DanmakuSettings,
    pub playback_end_behavior: PlaybackEndBehavior,
    pub playback_rate: PlaybackRate,
    pub bilibili_mode: BilibiliAccessMode,
}

impl Default for ProductSettings {
    fn default() -> Self {
        Self {
            host: "vrcdn.live".to_string(),
            playback_url: String::new(),
            theme: ThemePreference::System,
            stream_key_status: StreamKeyStatus::Missing,
            danmaku: default_danmaku_preferences(),
            playback_end_behavior: PlaybackEndBehavior::Pause,
            playback_rate: PlaybackRate::Normal,
            bilibili_mode: BilibiliAccessMode::Account,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKeyStatus {
    #[default]
    Missing,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackEndBehavior {
    #[default]
    Pause,
    Repeat,
    Next,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BilibiliAccessMode {
    Guest,
    #[default]
    Account,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub playback_url: Option<String>,
    #[serde(default)]
    pub theme: Option<ThemePreference>,
    #[serde(default)]
    pub stream_key: Option<String>,
    #[serde(default)]
    pub danmaku: Option<DanmakuSettings>,
    #[serde(default)]
    pub playback_end_behavior: Option<PlaybackEndBehavior>,
    #[serde(default)]
    pub playback_rate: Option<PlaybackRate>,
    #[serde(default)]
    pub bilibili_mode: Option<BilibiliAccessMode>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
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

pub(crate) fn default_danmaku_preferences() -> DanmakuSettings {
    DanmakuSettings {
        enabled: true,
        ..DanmakuSettings::default()
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
    pub paused: bool,
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
    Draining,
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
    pub danmaku_source: Option<danmaku::DanmakuSource>,
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
    settings: SettingsStore,
}

impl Default for RelayCore {
    fn default() -> Self {
        Self::new()
    }
}

impl RelayCore {
    pub fn new() -> Self {
        let settings = SettingsStore::new();
        let bilibili_mode = settings
            .load()
            .map(|settings| settings.bilibili_mode)
            .unwrap_or_default();
        Self {
            ffmpeg: FfmpegManager::new(),
            bilibili: BilibiliClient::new(bilibili_mode),
            danmaku: DanmakuService::new(),
            sessions: MediaSessionStore::new(),
            settings,
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
                let source = normalize_source_input(&source)?;
                let inspection = inspect_normalized_source(&source)?;
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
                start_seconds,
                paused,
                options,
            } => {
                let mut target = self.settings.relay_target(start_seconds)?;
                media_session::validate_relay_target(&target)?;
                let ffmpeg_path = self.ffmpeg.executable_path().ok_or_else(|| {
                    RelayError::new("ffmpeg_missing", "No usable FFmpeg executable was found")
                })?;
                let (overlay, normalized_start) = if paused {
                    let (_, normalized_start) = self
                        .sessions
                        .playback_context(&session_id, target.start_seconds)?;
                    (None, normalized_start)
                } else {
                    self.prepare_danmaku_overlay(
                        &session_id,
                        &options.danmaku,
                        target.start_seconds,
                    )?
                };
                target.start_seconds = normalized_start;
                Ok(Reply::RelayState {
                    relay: self.sessions.start(
                        &session_id,
                        target,
                        Some(&ffmpeg_path),
                        overlay,
                        paused,
                        options.playback_rate,
                    )?,
                })
            }
            Command::RetargetRelay {
                current_session_id,
                source,
                requested_part,
                start_seconds,
                paused,
                options,
            } => {
                let source = normalize_source_input(&source)?;
                let mut target = self.settings.relay_target(start_seconds)?;
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
                let (next_overlay, normalized_start) = if paused {
                    let (_, normalized_start) = self
                        .sessions
                        .playback_context(&next_session_id, target.start_seconds)?;
                    (None, normalized_start)
                } else {
                    self.prepare_danmaku_overlay(
                        &next_session_id,
                        &options.danmaku,
                        target.start_seconds,
                    )?
                };
                target.start_seconds = normalized_start;
                let current_active = current_session_id
                    .as_deref()
                    .is_some_and(|session_id| self.sessions.is_active(session_id));
                let relay = if current_active {
                    self.sessions.switch(
                        current_session_id.as_deref().expect("active session id"),
                        &next_session_id,
                        target,
                        next_overlay,
                        paused,
                        options.playback_rate,
                    )?
                } else {
                    self.sessions.start(
                        &next_session_id,
                        target,
                        Some(&ffmpeg_path),
                        next_overlay,
                        paused,
                        options.playback_rate,
                    )?
                };
                Ok(Reply::PlaybackState { resolution, relay })
            }
            Command::RelayStatus { session_id } => Ok(Reply::RelayState {
                relay: self.sessions.status(&session_id)?,
            }),
            Command::SetRelayPaused {
                session_id,
                paused,
                start_seconds,
                options,
            } => {
                let (overlay, normalized_start) = if paused {
                    (None, start_seconds)
                } else {
                    self.prepare_danmaku_overlay(&session_id, &options.danmaku, start_seconds)?
                };
                Ok(Reply::RelayState {
                    relay: self.sessions.set_paused(
                        &session_id,
                        paused,
                        normalized_start,
                        overlay,
                        options.playback_rate,
                    )?,
                })
            }
            Command::SetRelayRate {
                session_id,
                options,
            } => {
                let current = self.sessions.status(&session_id)?;
                let start_seconds = current.position_seconds.unwrap_or(0.0);
                let (overlay, normalized_start) =
                    self.prepare_danmaku_overlay(&session_id, &options.danmaku, start_seconds)?;
                Ok(Reply::RelayState {
                    relay: self.sessions.set_playback_rate(
                        &session_id,
                        normalized_start,
                        overlay,
                        options.playback_rate,
                    )?,
                })
            }
            Command::StopRelay { session_id } => Ok(Reply::RelayState {
                relay: self.sessions.stop(&session_id)?,
            }),
            Command::EnsureFfmpeg => Ok(Reply::FfmpegState {
                ffmpeg: self.ffmpeg.ensure_installed()?,
            }),
            Command::BilibiliAuthStatus => Ok(Reply::BilibiliAuthState {
                auth: self.bilibili.auth_status(),
            }),
            Command::BeginBilibiliLogin => Ok(Reply::BilibiliAuthState {
                auth: self.bilibili.begin_login()?,
            }),
            Command::PollBilibiliLogin { login_id } => Ok(Reply::BilibiliAuthState {
                auth: self.bilibili.poll_login(login_id)?,
            }),
            Command::LogoutBilibili => Ok(Reply::BilibiliAuthState {
                auth: self.bilibili.logout()?,
            }),
            Command::GetSettings => Ok(Reply::SettingsState {
                settings: self.settings.load()?,
            }),
            Command::RevealStreamKey => Ok(Reply::StreamKeyValue {
                stream_key: self.settings.reveal_stream_key()?,
            }),
            Command::SaveSettings { settings } => {
                let settings = self.settings.save(settings)?;
                self.bilibili.set_access_mode(settings.bilibili_mode);
                Ok(Reply::SettingsState { settings })
            }
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
            Some(source) => {
                if settings.enabled && source.is_live() {
                    self.ffmpeg.ensure_live_danmaku_support()?;
                }
                self.danmaku.prepare(&source, settings, normalized_start)?
            }
            None => None,
        };
        Ok((overlay, normalized_start))
    }
}

pub fn inspect_source(source: &str) -> Result<SourceInspection, RelayError> {
    let source = normalize_source_input(source)?;
    inspect_normalized_source(&source)
}

pub(crate) fn normalize_source_input(source: &str) -> Result<String, RelayError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(RelayError::new("empty_source", "Media source is empty"));
    }

    let candidate = preferred_http_url(source).unwrap_or_else(|| source.to_string());

    Ok(normalize_bilibili_list_url(&candidate).unwrap_or(candidate))
}

fn inspect_normalized_source(source: &str) -> Result<SourceInspection, RelayError> {
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

fn preferred_http_url(source: &str) -> Option<String> {
    let candidates = extract_http_urls(source);
    candidates
        .iter()
        .rev()
        .find(|candidate| is_bilibili_page_candidate(candidate))
        .or_else(|| candidates.last())
        .cloned()
}

fn extract_http_urls(source: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let remainder = &source[cursor..];
        let lowercase = remainder.to_ascii_lowercase();
        let Some(relative_start) = [lowercase.find("https://"), lowercase.find("http://")]
            .into_iter()
            .flatten()
            .min()
        else {
            break;
        };
        let start = cursor + relative_start;
        let tail = &source[start..];
        let end = tail
            .char_indices()
            .find_map(|(index, character)| {
                (character.is_whitespace()
                    || matches!(
                        character,
                        '[' | ']'
                            | '{'
                            | '}'
                            | '<'
                            | '>'
                            | '【'
                            | '】'
                            | '（'
                            | '）'
                            | '。'
                            | '，'
                            | '；'
                            | '！'
                    ))
                .then_some(index)
            })
            .unwrap_or(tail.len());
        let candidate = tail[..end]
            .trim_end_matches([')', ',', ';', '!', '"', '\''])
            .replace("\\&", "&");
        if !candidate.is_empty() {
            candidates.push(candidate);
        }
        cursor = start + end.max(1);
    }
    candidates
}

fn is_bilibili_page_candidate(source: &str) -> bool {
    let Ok(url) = Url::parse(source) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "b23.tv"
        || host.ends_with(".b23.tv")
        || host == "bilibili.com"
        || host.ends_with(".bilibili.com")
}

fn normalize_bilibili_list_url(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if !(host == "bilibili.com" || host.ends_with(".bilibili.com")) {
        return None;
    }
    let is_list_page = url
        .path_segments()
        .and_then(|mut segments| segments.find(|segment| !segment.is_empty()))
        .is_some_and(|segment| segment.eq_ignore_ascii_case("list"));
    if !is_list_page {
        return None;
    }

    let query = url.query_pairs().collect::<Vec<_>>();
    let source_id = query
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("bvid"))
        .map(|(_, value)| value.as_ref())
        .filter(|value| is_video_id(value))
        .map(ToOwned::to_owned)
        .or_else(|| {
            query
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("oid"))
                .map(|(_, value)| value.as_ref())
                .filter(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                })
                .map(|value| format!("av{value}"))
        })?;
    let normalized_id = if source_id[..2].eq_ignore_ascii_case("bv") {
        format!("BV{}", &source_id[2..])
    } else {
        source_id
    };
    let part = query
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("p"))
        .map(|(_, value)| value.as_ref())
        .filter(|value| value.parse::<u32>().is_ok_and(|part| part > 0));
    Some(match part {
        Some(part) => format!("https://www.bilibili.com/video/{normalized_id}?p={part}"),
        None => format!("https://www.bilibili.com/video/{normalized_id}"),
    })
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
