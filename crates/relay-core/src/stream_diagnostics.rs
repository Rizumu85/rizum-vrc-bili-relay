//! Bounded, local-only telemetry. Never persist command lines or upstream URLs.
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{Mutex, OnceLock, mpsc};
use std::sync::atomic::{AtomicU64, Ordering};

static DROPPED_RECORDS: AtomicU64 = AtomicU64::new(0);
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub(crate) struct Progress {
    pub values: BTreeMap<String, f64>,
    pub updated: Option<Instant>,
    pub warnings: BTreeMap<&'static str, u64>,
}

impl Progress {
    pub fn line(&mut self, line: &str) {
        let Some((key, value)) = line.split_once('=') else {
            return;
        };
        if key == "progress" {
            self.updated = Some(Instant::now());
        }
        if !matches!(
            key,
            "frame" | "fps" | "total_size" | "out_time_us" | "dup_frames" | "drop_frames" | "speed"
        ) {
            return;
        }
        if let Ok(value) = value.trim().trim_end_matches('x').parse::<f64>() {
            if value.is_finite() {
                self.values.insert(key.to_string(), value);
            }
        }
    }

    pub fn warning(&mut self, line: &str) {
        let line = line.to_ascii_lowercase();
        let category = if line.contains("reconnect") {
            "reconnect"
        } else if line.contains("timed out") || line.contains("timeout") {
            "timeout"
        } else if line.contains("http error") || line.contains("server returned") {
            "http_error"
        } else if line.contains("non-monoton") || line.contains("timestamp discontinuity") {
            "timestamp"
        } else if line.contains("circular buffer overrun") {
            "udp_overrun"
        } else if line.contains("corrupt") || line.contains("error while decoding") {
            "corrupt_or_decode"
        } else if line.contains("not a runtime option") {
            "filter_runtime_option"
        } else if line.contains("failed to process command") {
            "filter_command"
        } else if line.contains("no such filter") || line.contains("error parsing") {
            "filter_parse"
        } else if line.contains("broken pipe")
            || line.contains("connection reset")
            || line.contains("error writing")
        {
            "connection_or_write"
        } else {
            "other"
        };
        *self.warnings.entry(category).or_default() += 1;
    }
}

pub(crate) fn record(
    pid: u32,
    role: &'static str,
    event: &'static str,
    elapsed: f64,
    progress: &Mutex<Progress>,
) {
    let Ok(progress) = progress.lock() else {
        return;
    };
    let entry = serde_json::json!({
        "schema": 1, "unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "worker_pid": std::process::id(), "pid": pid, "role": role, "event": event,
        "elapsed_seconds": elapsed,
        "progress_age_seconds": progress.updated.map(|time| time.elapsed().as_secs_f64()),
        "metrics": progress.values, "warning_counts": progress.warnings,
        "dropped_records": DROPPED_RECORDS.load(Ordering::Relaxed),
    });
    // Disk trouble must not block playback or grow an unbounded queue.
    if sender().try_send(entry.to_string()).is_err() {
        DROPPED_RECORDS.fetch_add(1, Ordering::Relaxed);
    }
}

fn sender() -> &'static mpsc::SyncSender<String> {
    static SENDER: OnceLock<mpsc::SyncSender<String>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<String>(128);
        std::thread::spawn(move || {
            let directory = std::env::var_os("VRC_BILI_RELAY_DIAGNOSTICS_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::env::var_os("LOCALAPPDATA")
                    .map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir)
                    .join("VRC Bili Relay").join("runtime").join("diagnostics"));
            if std::fs::create_dir_all(&directory).is_err() {
                return;
            }
            let path = directory.join("relay-health.jsonl");
            let previous = directory.join("relay-health.previous.jsonl");
            for line in rx {
                if std::fs::metadata(&path).is_ok_and(|meta| meta.len() >= 2 * 1024 * 1024) {
                    if previous.exists() && std::fs::remove_file(&previous).is_err() {
                        DROPPED_RECORDS.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    if std::fs::rename(&path, &previous).is_err() {
                        DROPPED_RECORDS.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                {
                    if writeln!(file, "{line}").is_err() { DROPPED_RECORDS.fetch_add(1, Ordering::Relaxed); }
                } else { DROPPED_RECORDS.fetch_add(1, Ordering::Relaxed); }
            }
        });
        tx
    })
}
