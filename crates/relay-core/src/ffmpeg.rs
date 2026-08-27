use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::{MediaInput, RelayError};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const LOG_LINE_LIMIT: usize = 24;

pub(crate) struct FfmpegProcess {
    child: Child,
    started_at: Instant,
    stderr: Arc<Mutex<VecDeque<String>>>,
    has_output: Arc<AtomicBool>,
}

pub(crate) enum ProcessPoll {
    Alive { stable: bool },
    Exited { success: bool, diagnostic: String },
}

impl FfmpegProcess {
    pub fn spawn(
        executable: &str,
        input: &MediaInput,
        ingest_url: &str,
        stream_key: &str,
        start_seconds: f64,
    ) -> Result<Self, RelayError> {
        let mut command = Command::new(executable);
        command
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "warning",
                "-nostats",
                "-progress",
                "pipe:1",
                "-stats_period",
                "0.5",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        add_input(&mut command, input, &input.video_url, start_seconds);
        if let Some(audio_url) = input.audio_url.as_deref() {
            add_input(&mut command, input, audio_url, start_seconds);
            command.args(["-map", "0:v:0", "-map", "1:a:0"]);
        } else {
            command.args(["-map", "0:v:0", "-map", "0:a:0?"]);
        }
        command.args([
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

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let mut child = command.spawn().map_err(|error| {
            RelayError::new(
                "ffmpeg_start_failed",
                format!("FFmpeg could not be started: {error}"),
            )
        })?;
        let stderr = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_LINE_LIMIT)));
        if let Some(pipe) = child.stderr.take() {
            drain_stderr(
                pipe,
                Arc::clone(&stderr),
                vec![ingest_url.to_string(), stream_key.to_string()],
            );
        }
        let has_output = Arc::new(AtomicBool::new(false));
        if let Some(pipe) = child.stdout.take() {
            drain_progress(pipe, Arc::clone(&has_output));
        }

        Ok(Self {
            child,
            started_at: Instant::now(),
            stderr,
            has_output,
        })
    }

    pub fn poll(&mut self) -> Result<ProcessPoll, RelayError> {
        match self.child.try_wait().map_err(|error| {
            RelayError::new(
                "ffmpeg_status_failed",
                format!("FFmpeg status could not be read: {error}"),
            )
        })? {
            Some(status) => Ok(ProcessPoll::Exited {
                success: status.success(),
                diagnostic: self.diagnostic(),
            }),
            None if self.has_output.load(Ordering::Acquire) => {
                Ok(ProcessPoll::Alive { stable: true })
            }
            None if self.started_at.elapsed() >= STARTUP_TIMEOUT => {
                self.stop();
                let diagnostic = self.diagnostic();
                Ok(ProcessPoll::Exited {
                    success: false,
                    diagnostic: if diagnostic.is_empty() {
                        "FFmpeg produced no output before the startup timeout".to_string()
                    } else {
                        diagnostic
                    },
                })
            }
            None => Ok(ProcessPoll::Alive { stable: false }),
        }
    }

    pub fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }

    fn diagnostic(&self) -> String {
        self.stderr
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

impl Drop for FfmpegProcess {
    fn drop(&mut self) {
        self.stop();
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

fn drain_progress(pipe: impl std::io::Read + Send + 'static, has_output: Arc<AtomicBool>) {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let produced_output = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|value| value > 0);
            if produced_output {
                has_output.store(true, Ordering::Release);
            }
        }
    });
}
