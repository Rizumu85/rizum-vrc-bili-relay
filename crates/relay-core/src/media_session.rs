use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use url::Url;

use crate::danmaku::{DanmakuOverlay, DanmakuSource};
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
    overlay: Option<DanmakuOverlay>,
    stage: RelayStage,
    playback_url: Option<String>,
    position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    paused: bool,
    diagnostic: Option<String>,
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
                    overlay: None,
                    stage: RelayStage::Stopped,
                    playback_url: None,
                    position_seconds,
                    duration_seconds,
                    paused: false,
                    diagnostic: None,
                },
            );
        }
        resolved.resolution
    }

    pub fn is_active(&mut self, session_id: &str) -> bool {
        self.cleanup_expired();
        self.sessions
            .get(session_id)
            .is_some_and(|session| session.process.is_some())
    }

    pub fn start(
        &mut self,
        session_id: &str,
        target: RelayTarget,
        ffmpeg_path: Option<&str>,
        overlay: Option<DanmakuOverlay>,
        start_paused: bool,
    ) -> Result<RelayStatus, RelayError> {
        self.cleanup_expired();
        let ffmpeg_path = ffmpeg_path.ok_or_else(|| {
            RelayError::new("ffmpeg_missing", "No usable FFmpeg executable was found")
        })?;
        let ingest_url = validate_relay_target(&target)?;
        let session = self.sessions.get(session_id).ok_or_else(|| {
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
        // A single configured ingest target cannot safely accept two local
        // publishers. Enforce that invariant in the core so a stale UI session
        // cannot leave the previous FFmpeg process competing with the new one.
        self.suspend_other_relays(session_id);
        let session = self.sessions.get_mut(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        if let Some(mut process) = session.process.take() {
            if let Some(position) = process.position_seconds() {
                session.position_seconds = Some(position);
            }
            process.stop();
        }
        session.overlay = None;
        let process = FfmpegProcess::spawn(
            ffmpeg_path,
            &session.input,
            &ingest_url,
            &target.stream_key,
            start_seconds,
            start_paused,
            overlay.as_ref(),
        )
        .inspect_err(|error| {
            session.stage = RelayStage::Failed;
            session.diagnostic = Some(error.message.clone());
        })?;
        session.overlay = overlay;
        session.process = Some(process);
        session.stage = RelayStage::Starting;
        session.playback_url = Some(target.playback_url);
        session.position_seconds = (!session.input.is_live).then_some(start_seconds);
        session.paused = start_paused;
        session.diagnostic = None;
        session.expires_at = Instant::now() + SESSION_TTL;
        Ok(status_for(session_id, session))
    }

    pub fn switch(
        &mut self,
        current_session_id: &str,
        next_session_id: &str,
        target: RelayTarget,
        overlay: Option<DanmakuOverlay>,
        remain_paused: bool,
    ) -> Result<RelayStatus, RelayError> {
        self.cleanup_expired();
        validate_relay_target(&target)?;
        if current_session_id == next_session_id {
            return Err(RelayError::new(
                "invalid_relay_switch",
                "The current and target media sessions must be different",
            ));
        }

        let mut current = self.sessions.remove(current_session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Current media session expired or does not exist",
            )
        })?;
        let mut next = match self.sessions.remove(next_session_id) {
            Some(session) => session,
            None => {
                self.sessions
                    .insert(current_session_id.to_string(), current);
                return Err(RelayError::new(
                    "media_session_not_found",
                    "Target media session expired or does not exist",
                ));
            }
        };

        let result = (|| {
            let start_seconds = normalize_start(
                target.start_seconds,
                next.duration_seconds,
                next.input.is_live,
            )?;
            let mut process = current.process.take().ok_or_else(|| {
                RelayError::new(
                    "relay_not_running",
                    "The current relay is not active and cannot switch content in place",
                )
            })?;
            let previous_position = process
                .position_seconds()
                .or(current.position_seconds)
                .map(|position| clamp_position(position, current.duration_seconds))
                .unwrap_or(0.0);
            let previous_paused = process.is_paused();
            let previous_overlay = current.overlay.take();

            let switch_result = if remain_paused {
                let pause_result = if process.is_paused() {
                    Ok(())
                } else {
                    process.set_paused(
                        true,
                        &current.input,
                        previous_position,
                        previous_overlay.as_ref(),
                    )
                };
                pause_result.and_then(|_| process.retarget_paused(&next.input, start_seconds))
            } else {
                process.switch_content(&next.input, start_seconds, overlay.as_ref())
            };

            if let Err(mut error) = switch_result {
                let restored = if previous_paused {
                    process.retarget_paused(&current.input, previous_position)
                } else {
                    process.switch_content(
                        &current.input,
                        previous_position,
                        previous_overlay.as_ref(),
                    )
                }
                .is_ok();
                current.process = Some(process);
                current.overlay = previous_overlay;
                current.position_seconds = Some(previous_position);
                current.stage = if restored {
                    RelayStage::Running
                } else {
                    RelayStage::Failed
                };
                current.paused = previous_paused || !restored;
                current.diagnostic = (!restored).then(|| error.message.clone());
                current.expires_at = Instant::now() + SESSION_TTL;
                if !restored {
                    error.code = "retarget_restore_failed";
                    error
                        .message
                        .push_str("; the previous relay could not be restored");
                }
                return Err(error);
            }

            let playback_url = current.playback_url.take().unwrap_or(target.playback_url);
            current.position_seconds = Some(previous_position);
            current.stage = RelayStage::Stopped;
            current.paused = false;
            current.diagnostic = None;
            current.expires_at = Instant::now() + SESSION_TTL;

            next.process = Some(process);
            next.overlay = if remain_paused { None } else { overlay };
            next.stage = RelayStage::Running;
            next.playback_url = Some(playback_url);
            next.position_seconds = (!next.input.is_live).then_some(start_seconds);
            next.paused = remain_paused;
            next.diagnostic = None;
            next.expires_at = Instant::now() + SESSION_TTL;
            Ok(status_for(next_session_id, &next))
        })();

        self.sessions
            .insert(current_session_id.to_string(), current);
        self.sessions.insert(next_session_id.to_string(), next);
        result
    }

    pub fn playback_context(
        &mut self,
        session_id: &str,
        requested_start: f64,
    ) -> Result<(Option<DanmakuSource>, f64), RelayError> {
        self.cleanup_expired();
        let session = self.sessions.get(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        let start_seconds = normalize_start(
            requested_start,
            session.duration_seconds,
            session.input.is_live,
        )?;
        Ok((session.input.danmaku_source.clone(), start_seconds))
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

    pub fn set_paused(
        &mut self,
        session_id: &str,
        paused: bool,
        requested_start: f64,
        overlay: Option<DanmakuOverlay>,
    ) -> Result<RelayStatus, RelayError> {
        self.cleanup_expired();
        let session = self.sessions.get_mut(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            )
        })?;
        let start_seconds = normalize_start(
            requested_start,
            session.duration_seconds,
            session.input.is_live,
        )?;
        let process = session.process.as_mut().ok_or_else(|| {
            RelayError::new(
                "relay_not_running",
                "The relay is not running and cannot be paused or resumed",
            )
        })?;
        process.set_paused(
            paused,
            &session.input,
            start_seconds,
            if paused {
                session.overlay.as_ref()
            } else {
                overlay.as_ref()
            },
        )?;
        if let Some(position) = process.position_seconds() {
            session.position_seconds = Some(clamp_position(position, session.duration_seconds));
        }
        if !paused {
            session.overlay = overlay;
        }
        session.paused = paused;
        session.stage = RelayStage::Running;
        session.diagnostic = None;
        session.expires_at = Instant::now() + SESSION_TTL;
        Ok(status_for(session_id, session))
    }

    pub fn stop(&mut self, session_id: &str) -> Result<RelayStatus, RelayError> {
        if !self.suspend(session_id) {
            return Err(RelayError::new(
                "media_session_not_found",
                "Media session expired or does not exist; resolve the source again",
            ));
        }
        let session = self.sessions.get(session_id).ok_or_else(|| {
            RelayError::new(
                "media_session_not_found",
                "Media session expired while it was stopping",
            )
        })?;
        Ok(status_for(session_id, session))
    }

    fn suspend(&mut self, session_id: &str) -> bool {
        self.cleanup_expired();
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        if let Some(mut process) = session.process.take() {
            if let Some(position) = process.position_seconds() {
                session.position_seconds = Some(position);
            }
            process.stop();
        }
        session.overlay = None;
        session.stage = RelayStage::Stopped;
        session.paused = false;
        session.diagnostic = None;
        session.expires_at = Instant::now() + SESSION_TTL;
        true
    }

    pub fn shutdown(&mut self) {
        self.sessions.clear();
    }

    fn suspend_other_relays(&mut self, active_session_id: &str) {
        for (session_id, session) in &mut self.sessions {
            if session_id == active_session_id || session.process.is_none() {
                continue;
            }
            if let Some(mut process) = session.process.take() {
                if let Some(position) = process.position_seconds() {
                    session.position_seconds = Some(position);
                }
                process.stop();
            }
            session.overlay = None;
            session.stage = RelayStage::Stopped;
            session.paused = false;
            session.diagnostic = None;
            session.expires_at = Instant::now() + SESSION_TTL;
        }
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
    let poll = {
        let Some(process) = session.process.as_mut() else {
            return Ok(());
        };
        let poll = process.poll(&session.input, session.overlay.as_ref())?;
        if let Some(position) = process.position_seconds() {
            session.position_seconds = Some(clamp_position(position, session.duration_seconds));
        }
        poll
    };
    match poll {
        ProcessPoll::Alive { stable } => {
            if stable
                && let Some(overlay) = session.overlay.as_mut()
                && let Err(error) = overlay.start()
            {
                if let Some(mut process) = session.process.take() {
                    process.stop();
                }
                session.overlay = None;
                session.stage = RelayStage::Failed;
                session.diagnostic = Some(error.message);
                session.expires_at = Instant::now() + SESSION_TTL;
                return Ok(());
            }
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
            session.overlay = None;
            session.paused = false;
            session.expires_at = Instant::now() + SESSION_TTL;
        }
        ProcessPoll::PauseExpired => {
            session.stage = RelayStage::Stopped;
            session.process = None;
            session.overlay = None;
            // Preserve the transport intent so the UI can restart playback at
            // the frozen position after the one-hour safety cutoff.
            session.paused = true;
            session.diagnostic = None;
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
        paused: session.paused,
        danmaku_events: session.overlay.as_ref().map(DanmakuOverlay::event_count),
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
