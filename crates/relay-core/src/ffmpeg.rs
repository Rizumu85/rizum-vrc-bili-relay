use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

use crate::danmaku::{
    AUDIO_BITRATE_KBPS, DanmakuOverlay, OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH, VIDEO_BITRATE_KBPS,
};
use crate::{MediaInput, RelayError};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const PAUSE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const STREAM_SWITCH_GAP_SECONDS: f64 = 0.050;
const LOG_LINE_LIMIT: usize = 24;

/// One stable RTMP publisher backed by a replaceable local MPEG-TS producer.
///
/// The publisher owns the remote VRCDN connection for the full relay lifetime.
/// Pausing only replaces the media producer with a generated still frame and
/// silence, so VRChat never observes the publisher disconnecting.
pub(crate) struct FfmpegProcess {
    publisher: ManagedChild,
    producer: Option<ManagedChild>,
    executable: String,
    udp_output: String,
    timeline_offset_seconds: f64,
    content_start_seconds: f64,
    paused_position_seconds: Option<f64>,
    paused_at: Option<Instant>,
    awaiting_content_start: bool,
    is_live: bool,
}

pub(crate) enum ProcessPoll {
    Alive { stable: bool },
    Exited { success: bool, diagnostic: String },
    PauseExpired,
}

struct ManagedChild {
    child: Child,
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    _job: FfmpegJob,
    started_at: Instant,
    stderr: Arc<Mutex<VecDeque<String>>>,
    has_output: Arc<AtomicBool>,
    output_micros: Arc<AtomicU64>,
}

enum ChildPoll {
    Alive {
        stable: bool,
    },
    Exited {
        status: ExitStatus,
        diagnostic: String,
    },
}

impl FfmpegProcess {
    pub fn spawn(
        executable: &str,
        input: &MediaInput,
        ingest_url: &str,
        stream_key: &str,
        start_seconds: f64,
        _overlay: Option<&DanmakuOverlay>,
    ) -> Result<Self, RelayError> {
        let port = reserve_udp_port()?;
        let udp_input = format!("udp://127.0.0.1:{port}?fifo_size=1000000&overrun_nonfatal=1");
        let udp_output = format!("udp://127.0.0.1:{port}?pkt_size=1316");
        let publisher = spawn_publisher(executable, &udp_input, ingest_url, stream_key)?;
        // Prime the publisher with a still frame. FFmpeg can consume several
        // seconds while probing the local MPEG-TS stream and opening RTMP; the
        // real video must not advance during that phase.
        let producer = match spawn_hold_producer(executable, &udp_output, 0.0) {
            Ok(producer) => producer,
            Err(error) => {
                let mut publisher = publisher;
                publisher.force_stop();
                return Err(error);
            }
        };

        Ok(Self {
            publisher,
            producer: Some(producer),
            executable: executable.to_string(),
            udp_output,
            timeline_offset_seconds: 0.0,
            content_start_seconds: start_seconds,
            paused_position_seconds: None,
            paused_at: None,
            awaiting_content_start: true,
            is_live: input.is_live,
        })
    }

    pub fn poll(
        &mut self,
        input: &MediaInput,
        overlay: Option<&DanmakuOverlay>,
    ) -> Result<ProcessPoll, RelayError> {
        if self
            .paused_at
            .is_some_and(|paused_at| paused_at.elapsed() >= PAUSE_TIMEOUT)
        {
            self.stop();
            return Ok(ProcessPoll::PauseExpired);
        }

        let publisher_stable = match self.publisher.poll(true)? {
            ChildPoll::Exited { status, diagnostic } => {
                if let Some(mut producer) = self.producer.take() {
                    producer.stop();
                }
                return Ok(ProcessPoll::Exited {
                    success: status.success(),
                    diagnostic,
                });
            }
            ChildPoll::Alive { stable } => stable,
        };

        if self.awaiting_content_start && publisher_stable {
            self.stop_producer_and_advance_timeline();
            if let Err(error) =
                self.spawn_content_producer(input, self.content_start_seconds, overlay)
            {
                let _ = self.spawn_hold_producer();
                self.stop();
                return Ok(ProcessPoll::Exited {
                    success: false,
                    diagnostic: error.message,
                });
            }
            self.awaiting_content_start = false;
            return Ok(ProcessPoll::Alive { stable: false });
        }

        let producer_poll = match self.producer.as_mut() {
            Some(producer) => producer.poll(false)?,
            None => {
                self.publisher.force_stop();
                return Ok(ProcessPoll::Exited {
                    success: false,
                    diagnostic: "FFmpeg media producer is unavailable".to_string(),
                });
            }
        };
        let producer_stable = match producer_poll {
            ChildPoll::Exited { status, diagnostic } => {
                // Keep packets flowing while the publisher is asked to close.
                // A blocking UDP read can otherwise force an abrupt teardown.
                let _ = self.replace_producer_with_hold();
                self.stop();
                return Ok(ProcessPoll::Exited {
                    success: status.success() && !self.is_paused(),
                    diagnostic,
                });
            }
            ChildPoll::Alive { stable } => stable,
        };

        match self.publisher.poll(true)? {
            ChildPoll::Alive { stable } => Ok(ProcessPoll::Alive {
                stable: stable && (self.is_paused() || producer_stable),
            }),
            ChildPoll::Exited { status, diagnostic } => Ok(ProcessPoll::Exited {
                success: status.success(),
                diagnostic,
            }),
        }
    }

    pub fn set_paused(
        &mut self,
        paused: bool,
        input: &MediaInput,
        requested_start_seconds: f64,
        overlay: Option<&DanmakuOverlay>,
    ) -> Result<(), RelayError> {
        if self.is_live {
            return Err(RelayError::new(
                "pause_not_supported",
                "Live streams cannot be paused",
            ));
        }
        if paused == self.is_paused() {
            return Ok(());
        }

        if paused {
            if self.awaiting_content_start {
                self.awaiting_content_start = false;
                self.paused_position_seconds = Some(requested_start_seconds.max(0.0));
                self.paused_at = Some(Instant::now());
                return Ok(());
            }
            let frozen_position = self
                .position_seconds()
                .unwrap_or(requested_start_seconds.max(0.0));
            self.stop_producer_and_advance_timeline();
            match self.spawn_hold_producer() {
                Ok(()) => {
                    self.paused_position_seconds = Some(frozen_position);
                    self.paused_at = Some(Instant::now());
                    Ok(())
                }
                Err(error) => {
                    let _ = self.spawn_content_producer(input, frozen_position, overlay);
                    Err(error)
                }
            }
        } else {
            self.stop_producer_and_advance_timeline();
            match self.spawn_content_producer(input, requested_start_seconds, overlay) {
                Ok(()) => {
                    self.content_start_seconds = requested_start_seconds;
                    self.paused_position_seconds = None;
                    self.paused_at = None;
                    self.awaiting_content_start = false;
                    Ok(())
                }
                Err(error) => {
                    let _ = self.spawn_hold_producer();
                    self.paused_position_seconds = Some(requested_start_seconds);
                    self.paused_at = Some(Instant::now());
                    Err(error)
                }
            }
        }
    }

    pub fn stop(&mut self) {
        // Stop the publisher first while the producer is still sending data.
        // That lets FFmpeg finish the FLV/RTMP session instead of being stuck
        // in a blocking UDP read and falling back to a force kill.
        self.publisher.stop();
        if let Some(mut producer) = self.producer.take() {
            producer.stop();
        }
    }

    pub fn position_seconds(&self) -> Option<f64> {
        if self.is_live {
            return None;
        }
        if let Some(position) = self.paused_position_seconds {
            return Some(position);
        }
        if self.awaiting_content_start {
            return Some(self.content_start_seconds);
        }
        Some(
            self.content_start_seconds
                + self
                    .producer
                    .as_ref()
                    .map(ManagedChild::output_seconds)
                    .unwrap_or(0.0),
        )
    }

    pub fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }

    fn stop_producer_and_advance_timeline(&mut self) {
        if let Some(mut producer) = self.producer.take() {
            producer.stop();
            self.timeline_offset_seconds += producer.output_seconds() + STREAM_SWITCH_GAP_SECONDS;
        }
    }

    fn spawn_content_producer(
        &mut self,
        input: &MediaInput,
        start_seconds: f64,
        overlay: Option<&DanmakuOverlay>,
    ) -> Result<(), RelayError> {
        let producer = spawn_content_producer(
            &self.executable,
            input,
            &self.udp_output,
            start_seconds,
            self.timeline_offset_seconds,
            overlay,
        )?;
        self.content_start_seconds = start_seconds;
        self.producer = Some(producer);
        Ok(())
    }

    fn spawn_hold_producer(&mut self) -> Result<(), RelayError> {
        let producer = spawn_hold_producer(
            &self.executable,
            &self.udp_output,
            self.timeline_offset_seconds,
        )?;
        self.producer = Some(producer);
        Ok(())
    }

    fn replace_producer_with_hold(&mut self) -> Result<(), RelayError> {
        self.stop_producer_and_advance_timeline();
        self.spawn_hold_producer()
    }
}

impl ManagedChild {
    fn spawn(
        mut command: Command,
        redactions: Vec<String>,
        error_code: &'static str,
        error_subject: &'static str,
    ) -> Result<Self, RelayError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let mut child = command.spawn().map_err(|error| {
            RelayError::new(
                error_code,
                format!("{error_subject} could not be started: {error}"),
            )
        })?;
        #[cfg(windows)]
        let job = match FfmpegJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RelayError::new(
                    error_code,
                    format!("{error_subject} process guard could not be created: {error}"),
                ));
            }
        };
        let stdin = child.stdin.take();
        let stderr = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_LINE_LIMIT)));
        if let Some(pipe) = child.stderr.take() {
            drain_stderr(pipe, Arc::clone(&stderr), redactions);
        }
        let has_output = Arc::new(AtomicBool::new(false));
        let output_micros = Arc::new(AtomicU64::new(0));
        if let Some(pipe) = child.stdout.take() {
            drain_progress(pipe, Arc::clone(&has_output), Arc::clone(&output_micros));
        }

        Ok(Self {
            child,
            stdin,
            #[cfg(windows)]
            _job: job,
            started_at: Instant::now(),
            stderr,
            has_output,
            output_micros,
        })
    }

    fn poll(&mut self, enforce_startup_timeout: bool) -> Result<ChildPoll, RelayError> {
        match self.child.try_wait().map_err(|error| {
            RelayError::new(
                "ffmpeg_status_failed",
                format!("FFmpeg status could not be read: {error}"),
            )
        })? {
            Some(status) => Ok(ChildPoll::Exited {
                status,
                diagnostic: self.diagnostic(),
            }),
            None if self.has_output.load(Ordering::Acquire) => {
                Ok(ChildPoll::Alive { stable: true })
            }
            None if enforce_startup_timeout && self.started_at.elapsed() >= STARTUP_TIMEOUT => {
                self.stop();
                Err(RelayError::new("ffmpeg_start_failed", {
                    let diagnostic = self.diagnostic();
                    if diagnostic.is_empty() {
                        "FFmpeg produced no output before the startup timeout".to_string()
                    } else {
                        diagnostic
                    }
                }))
            }
            None => Ok(ChildPoll::Alive { stable: false }),
        }
    }

    fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            if let Some(mut stdin) = self.stdin.take() {
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
            let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
            loop {
                match self.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Ok(None) | Err(_) => {
                        let _ = self.child.kill();
                        break;
                    }
                }
            }
        }
        let _ = self.child.wait();
    }

    fn force_stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }

    fn output_seconds(&self) -> f64 {
        self.output_micros.load(Ordering::Acquire) as f64 / 1_000_000.0
    }

    fn diagnostic(&self) -> String {
        self.stderr
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

fn spawn_publisher(
    executable: &str,
    udp_input: &str,
    ingest_url: &str,
    stream_key: &str,
) -> Result<ManagedChild, RelayError> {
    let mut command = base_command(executable);
    command.args([
        "-fflags",
        "+genpts+discardcorrupt",
        "-thread_queue_size",
        "1024",
        "-i",
        udp_input,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-max_muxing_queue_size",
        "1024",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        ingest_url,
    ]);
    ManagedChild::spawn(
        command,
        vec![ingest_url.to_string(), stream_key.to_string()],
        "ffmpeg_start_failed",
        "FFmpeg publisher",
    )
}

fn spawn_content_producer(
    executable: &str,
    input: &MediaInput,
    udp_output: &str,
    start_seconds: f64,
    timeline_offset_seconds: f64,
    overlay: Option<&DanmakuOverlay>,
) -> Result<ManagedChild, RelayError> {
    let mut command = base_command(executable);
    add_input(&mut command, input, &input.video_url, start_seconds);
    if let Some(audio_url) = input.audio_url.as_deref() {
        add_input(&mut command, input, audio_url, start_seconds);
        command.args(["-map", "0:v:0", "-map", "1:a:0"]);
    } else {
        command.args(["-map", "0:v:0", "-map", "0:a:0?"]);
    }
    add_standard_transcode(&mut command, overlay);
    add_mpegts_output(&mut command, udp_output, timeline_offset_seconds);
    let mut redactions = vec![input.video_url.clone()];
    if let Some(audio_url) = input.audio_url.as_ref() {
        redactions.push(audio_url.clone());
    }
    ManagedChild::spawn(
        command,
        redactions,
        "ffmpeg_start_failed",
        "FFmpeg media producer",
    )
}

fn spawn_hold_producer(
    executable: &str,
    udp_output: &str,
    timeline_offset_seconds: f64,
) -> Result<ManagedChild, RelayError> {
    let mut command = base_command(executable);
    let video_source = format!("color=c=0x202126:s={OUTPUT_WIDTH}x{OUTPUT_HEIGHT}:r={OUTPUT_FPS}");
    command.args(["-re", "-f", "lavfi", "-i", &video_source]);
    command.args([
        "-re",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
    ]);
    let pause_filter = format!(
        "setpts=PTS-STARTPTS,drawbox=x=iw/2-42:y=ih/2-56:w=32:h=112:color=white@0.72:t=fill,\
         drawbox=x=iw/2+10:y=ih/2-56:w=32:h=112:color=white@0.72:t=fill,fps={OUTPUT_FPS}"
    );
    add_transcode_with_video_filter(&mut command, &pause_filter);
    add_mpegts_output(&mut command, udp_output, timeline_offset_seconds);
    ManagedChild::spawn(
        command,
        Vec::new(),
        "ffmpeg_pause_failed",
        "FFmpeg pause producer",
    )
}

fn base_command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command.args([
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostats",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",
    ]);
    command
}

fn add_standard_transcode(command: &mut Command, overlay: Option<&DanmakuOverlay>) {
    let mut filter = format!(
        "setpts=PTS-STARTPTS,\
         scale=w={OUTPUT_WIDTH}:h={OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,\
         pad={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,\
         fps={OUTPUT_FPS}"
    );
    if let Some(path) = overlay.and_then(DanmakuOverlay::ass_path) {
        filter.push_str(&format!(",ass=filename='{}'", escape_filter_path(path)));
    }
    if let Some(live_filter) = overlay.and_then(DanmakuOverlay::live_filter_graph) {
        filter.push(',');
        filter.push_str(live_filter);
    }
    add_transcode_with_video_filter(command, &filter);
}

fn add_transcode_with_video_filter(command: &mut Command, video_filter: &str) {
    let video_bitrate = format!("{VIDEO_BITRATE_KBPS}k");
    let video_buffer = format!("{}k", VIDEO_BITRATE_KBPS * 2);
    let keyframe_interval = OUTPUT_FPS.to_string();
    let audio_bitrate = format!("{AUDIO_BITRATE_KBPS}k");
    command.args(["-vf", video_filter, "-pix_fmt", "yuv420p"]);
    command.args([
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-b:v",
        &video_bitrate,
        "-maxrate",
        &video_bitrate,
        "-bufsize",
        &video_buffer,
        "-g",
        &keyframe_interval,
        "-keyint_min",
        &keyframe_interval,
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        &audio_bitrate,
        "-ar",
        "48000",
        "-ac",
        "2",
        "-af",
        "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0",
    ]);
}

fn add_mpegts_output(command: &mut Command, udp_output: &str, timeline_offset_seconds: f64) {
    let offset = format!("{timeline_offset_seconds:.6}");
    command.args([
        "-max_muxing_queue_size",
        "1024",
        "-mpegts_copyts",
        "1",
        "-output_ts_offset",
        &offset,
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-flush_packets",
        "1",
        "-f",
        "mpegts",
        udp_output,
    ]);
}

fn reserve_udp_port() -> Result<u16, RelayError> {
    let socket = UdpSocket::bind(("127.0.0.1", 0)).map_err(|error| {
        RelayError::new(
            "ffmpeg_start_failed",
            format!("A local media bridge port could not be reserved: {error}"),
        )
    })?;
    socket
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| {
            RelayError::new(
                "ffmpeg_start_failed",
                format!("The local media bridge port could not be read: {error}"),
            )
        })
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', r"\:")
        .replace('\'', r"\'")
        .replace('[', r"\[")
        .replace(']', r"\]")
        .replace(',', r"\,")
}

impl Drop for FfmpegProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
struct FfmpegJob {
    handle: HANDLE,
}

#[cfg(windows)]
impl FfmpegJob {
    fn attach(child: &Child) -> std::io::Result<Self> {
        // SAFETY: null security attributes and name request an unnamed job with
        // default security. The returned handle is owned by this value.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` has the exact layout and byte length required by the
        // selected information class, and `handle` remains valid for the call.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: `handle` was created above and has not been closed.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }

        let process = child.as_raw_handle() as HANDLE;
        // SAFETY: `process` is the live handle owned by `child`, while `handle`
        // is a configured job object owned by this function.
        if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: `handle` was created above and has not been closed.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }

        Ok(Self { handle })
    }
}

#[cfg(windows)]
impl Drop for FfmpegJob {
    fn drop(&mut self) {
        // SAFETY: this value owns `handle` and closes it exactly once.
        unsafe { CloseHandle(self.handle) };
    }
}

fn add_input(command: &mut Command, input: &MediaInput, url: &str, start_seconds: f64) {
    command.args([
        "-rw_timeout",
        "15000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
    ]);
    if input.is_live {
        command.args(["-reconnect_at_eof", "1"]);
    }
    if !input.is_live {
        command.arg("-re");
        if start_seconds > 0.0 {
            command.args(["-ss", &format!("{start_seconds:.3}")]);
        }
    }
    if input.requires_bilibili_headers {
        command.args([
            "-user_agent",
            BROWSER_USER_AGENT,
            "-referer",
            &input.referer,
        ]);
    }
    command.args(["-i", url]);
}

fn drain_stderr(
    pipe: impl std::io::Read + Send + 'static,
    destination: Arc<Mutex<VecDeque<String>>>,
    redactions: Vec<String>,
) {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let sanitized = redactions.iter().fold(line, |text, secret| {
                if secret.is_empty() {
                    text
                } else {
                    text.replace(secret, "<redacted>")
                }
            });
            if let Ok(mut lines) = destination.lock() {
                if lines.len() == LOG_LINE_LIMIT {
                    lines.pop_front();
                }
                lines.push_back(sanitized);
            }
        }
    });
}

fn drain_progress(
    pipe: impl std::io::Read + Send + 'static,
    has_output: Arc<AtomicBool>,
    output_micros: Arc<AtomicU64>,
) {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let position = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|value| value.parse::<u64>().ok());
            if let Some(position) = position {
                output_micros.store(position, Ordering::Release);
                if position > 0 {
                    has_output.store(true, Ordering::Release);
                }
            }
        }
    });
}
