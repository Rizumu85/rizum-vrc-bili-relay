use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use url::Url;

use crate::ffmpeg::{FfmpegProcess, ProcessPoll};
use crate::{
    MediaInput, RelayError, RelayStage, RelayStatus, RelayTarget, ResolvedSource, SourceResolution,
};

const SESSION_TTL: Duration = Duration::from_secs(10 * 60);

pub(crate) struct MediaSessionStore {
    sessions: HashMap<String, MediaSession>,
    next_id: u64,
}

struct MediaSession {
    input: MediaInput,
    expires_at: Instant,
    process: Option<FfmpegProcess>,
    stage: RelayStage,
    playback_url: Option<String>,
    position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    diagnostic: Option<String>,
}

pub(crate) struct SuspendedSession {
    pub was_active: bool,
    pub position_seconds: Option<f64>,
}

impl MediaSessionStore {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_id: 1,
        }
    }

    pub fn prepare(&mut self, mut resolved: ResolvedSource) -> SourceResolution {
        self.cleanup_expired();
        if let Some(input) = resolved.input {
            let duration_seconds = resolved
                .resolution
                .duration_seconds
                .map(|value| value as f64);
            let position_seconds = (!input.is_live).then_some(0.0);
            let session_id = self.create_id();
            resolved.resolution.session_id = Some(session_id.clone());
            resolved.resolution.session_expires_in_seconds = Some(SESSION_TTL.as_secs());
            self.sessions.insert(
                session_id,
                MediaSession {
                    input,
                    expires_at: Instant::now() + SESSION_TTL,
                    process: None,
                    stage: RelayStage::Stopped,
                    playback_url: None,
                    position_seconds,
                    duration_seconds,
                    diagnostic: None,
                },
            );
        }
        resolved.resolution
    }

    pub fn start(
        &mut self,
        session_id: &str,
        target: RelayTarget,
        ffmpeg_path: Option<&str>,
    ) -> Result<RelayStatus, RelayError> {
        self.cleanup_expired();
        let ffmpeg_path = ffmpeg_path.ok_or_else(|| {
            RelayError::new("ffmpeg_missing", "No usable FFmpeg executable was found")
        })?;
        let ingest_url = validate_relay_target(&target)?;
        let session = self.sessions.get_mut(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        let start_seconds = normalize_start(
            target.start_seconds,
            session.duration_seconds,
            session.input.is_live,
        )?;
        if let Some(mut process) = session.process.take() {
            if let Some(position) = process.position_seconds() {
                session.position_seconds = Some(position);
            }
            process.stop();
        }
        let process = FfmpegProcess::spawn(
            ffmpeg_path,
            &session.input,
            &ingest_url,
            &target.stream_key,
            start_seconds,
        )
        .inspect_err(|error| {
            session.stage = RelayStage::Failed;
            session.diagnostic = Some(error.message.clone());
        })?;
        session.process = Some(process);
        session.stage = RelayStage::Starting;
        session.playback_url = Some(target.playback_url);
        session.position_seconds = (!session.input.is_live).then_some(start_seconds);
        session.diagnostic = None;
        session.expires_at = Instant::now() + SESSION_TTL;
        Ok(status_for(session_id, session))
    }

    pub fn status(&mut self, session_id: &str) -> Result<RelayStatus, RelayError> {
        self.cleanup_expired();
        let session = self.sessions.get_mut(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        refresh(session)?;
        Ok(status_for(session_id, session))
    }

    pub fn stop(&mut self, session_id: &str) -> Result<RelayStatus, RelayError> {
        self.suspend(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        let session = self.sessions.get(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired while it was stopping",
            )
        })?;
        Ok(status_for(session_id, session))
    }

    pub fn suspend(&mut self, session_id: &str) -> Option<SuspendedSession> {
        self.cleanup_expired();
        let session = self.sessions.get_mut(session_id)?;
        let was_active = session.process.is_some();
        if let Some(mut process) = session.process.take() {
            if let Some(position) = process.position_seconds() {
                session.position_seconds = Some(position);
            }
            process.stop();
        }
        session.stage = RelayStage::Stopped;
        session.diagnostic = None;
        session.expires_at = Instant::now() + SESSION_TTL;
        Some(SuspendedSession {
            was_active,
            position_seconds: session.position_seconds,
        })
    }

    pub fn shutdown(&mut self) {
        self.sessions.clear();
    }

    fn cleanup_expired(&mut self) {
        let now = Instant::now();
        self.sessions.retain(|_, session| {
            let active = matches!(session.stage, RelayStage::Starting | RelayStage::Running);
            active || session.expires_at > now
        });
    }

    fn create_id(&mut self) -> String {
        let counter = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let epoch_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{epoch_millis:x}-{counter:x}")
    }
}

impl Drop for MediaSessionStore {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn refresh(session: &mut MediaSession) -> Result<(), RelayError> {
    let Some(process) = session.process.as_mut() else {
        return Ok(());
    };
    let poll = process.poll()?;
    if let Some(position) = process.position_seconds() {
        session.position_seconds = Some(clamp_position(position, session.duration_seconds));
    }
    match poll {
        ProcessPoll::Alive { stable } => {
            session.stage = if stable {
                RelayStage::Running
            } else {
                RelayStage::Starting
            };
        }
        ProcessPoll::Exited {
            success,
            diagnostic,
        } => {
            session.stage = if success {
                RelayStage::Completed
            } else {
                RelayStage::Failed
            };
            session.diagnostic = (!diagnostic.is_empty()).then_some(diagnostic);
            session.process = None;
            session.expires_at = Instant::now() + SESSION_TTL;
        }
    }
    Ok(())
}

fn status_for(session_id: &str, session: &MediaSession) -> RelayStatus {
    RelayStatus {
        session_id: session_id.to_string(),
        stage: session.stage.clone(),
        playback_url: session.playback_url.clone(),
        position_seconds: session.position_seconds,
        diagnostic: session.diagnostic.clone(),
    }
}

fn normalize_start(
    requested: f64,
    duration_seconds: Option<f64>,
    is_live: bool,
) -> Result<f64, RelayError> {
    if is_live {
        if requested > 0.0 {
            return Err(RelayError::new(
                "seek_not_supported",
                "Live streams cannot start from a playback position",
            ));
        }
        return Ok(0.0);
    }
    Ok(clamp_position(requested, duration_seconds))
}

fn clamp_position(position: f64, duration_seconds: Option<f64>) -> f64 {
    let maximum = duration_seconds
        .map(|duration| (duration - 1.0).max(0.0))
        .unwrap_or(position.max(0.0));
    position.clamp(0.0, maximum)
}

pub(crate) fn validate_relay_target(target: &RelayTarget) -> Result<String, RelayError> {
    let ingest_server = normalize_ingest_server(&target.ingest_server)?;
    let stream_key = target.stream_key.trim();
    if stream_key.is_empty() || stream_key.chars().any(char::is_whitespace) {
        return Err(RelayError::new(
            "invalid_stream_key",
            "VRCDN stream key is empty or contains whitespace",
        ));
    }
    let playback = Url::parse(target.playback_url.trim()).map_err(|_| {
        RelayError::new(
            "invalid_playback_url",
            "VRCDN playback URL is not a valid absolute URL",
        )
    })?;
    if !matches!(
        playback.scheme(),
        "rtspt" | "rtsp" | "http" | "https" | "rtmp"
    ) {
        return Err(RelayError::new(
            "invalid_playback_url",
            "VRCDN playback URL uses an unsupported scheme",
        ));
    }
    if !target.start_seconds.is_finite() || target.start_seconds < 0.0 {
        return Err(RelayError::new(
            "invalid_start_position",
            "Playback start position must be a non-negative number",
        ));
    }
    Ok(format!(
        "{}/{}",
        ingest_server.trim_end_matches('/'),
        stream_key.trim_start_matches('/')
    ))
}

fn normalize_ingest_server(value: &str) -> Result<String, RelayError> {
    let value = value.trim();
    let normalized = if value.eq_ignore_ascii_case("vrcdn.live") {
        "rtmp://ingest.vrcdn.live/live"
    } else {
        value
    };
    let url = Url::parse(normalized).map_err(|_| {
        RelayError::new(
            "invalid_ingest_server",
            "VRCDN ingest server is not a valid absolute URL",
        )
    })?;
    if !matches!(url.scheme(), "rtmp" | "rtmps") {
        return Err(RelayError::new(
            "invalid_ingest_server",
            "VRCDN ingest server must use RTMP or RTMPS",
        ));
    }
    Ok(normalized.to_string())
}
