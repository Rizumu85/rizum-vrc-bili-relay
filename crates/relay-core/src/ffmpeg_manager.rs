use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::{FfmpegAvailability, FfmpegStatus, RelayError};

const RELEASE_ARCHIVE_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const RELEASE_CHECKSUM_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";
const RELEASE_VERSION_URL: &str = "https://www.gyan.dev/ffmpeg/builds/release-version";
const DOWNLOAD_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 128 * 1024;

pub(crate) struct FfmpegManager {
    system_path: Option<PathBuf>,
    managed_root: PathBuf,
    state: Arc<Mutex<InstallState>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct InstallState {
    stage: InstallStage,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    diagnostic: Option<String>,
    version: Option<String>,
}

#[derive(Default, PartialEq, Eq)]
enum InstallStage {
    #[default]
    Idle,
    Installing,
    Failed,
}

#[derive(Serialize, Deserialize)]
struct InstallMetadata {
    version: String,
    sha256: String,
    source: String,
}

impl FfmpegManager {
    pub fn new() -> Self {
        let managed_root = managed_root();
        let metadata = read_metadata(&managed_root);
        Self {
            system_path: detect_system_ffmpeg(),
            managed_root,
            state: Arc::new(Mutex::new(InstallState {
                version: metadata.map(|metadata| metadata.version),
                ..InstallState::default()
            })),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn status(&self) -> FfmpegStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stage == InstallStage::Installing {
            return FfmpegStatus {
                availability: FfmpegAvailability::Installing,
                path: None,
                version: state.version.clone(),
                downloaded_bytes: Some(state.downloaded_bytes),
                total_bytes: state.total_bytes,
                diagnostic: None,
            };
        }
        if let Some(path) = self.ready_path() {
            let is_system = self.system_path.as_deref() == Some(path.as_path());
            let availability = if is_system {
                FfmpegAvailability::System
            } else {
                FfmpegAvailability::Managed
            };
            return FfmpegStatus {
                availability,
                path: Some(path.to_string_lossy().into_owned()),
                version: if is_system {
                    None
                } else {
                    state.version.clone()
                },
                downloaded_bytes: None,
                total_bytes: None,
                diagnostic: None,
            };
        }
        if state.stage == InstallStage::Failed {
            return FfmpegStatus {
                availability: FfmpegAvailability::Failed,
                path: None,
                version: state.version.clone(),
                downloaded_bytes: Some(state.downloaded_bytes),
                total_bytes: state.total_bytes,
                diagnostic: state.diagnostic.clone(),
            };
        }
        FfmpegStatus {
            availability: FfmpegAvailability::Missing,
            path: None,
            version: None,
            downloaded_bytes: None,
            total_bytes: None,
            diagnostic: None,
        }
    }

    pub fn executable_path(&self) -> Option<String> {
        self.ready_path()
            .map(|path| path.to_string_lossy().into_owned())
    }

    pub fn ensure_installed(&mut self) -> Result<FfmpegStatus, RelayError> {
        if self.ready_path().is_some() {
            return Ok(self.status());
        }
        let already_installing = {
            let mut state = self.state.lock().map_err(|_| {
                RelayError::new(
                    "ffmpeg_install_failed",
                    "FFmpeg installer state is unavailable",
                )
            })?;
            if state.stage == InstallStage::Installing {
                true
            } else {
                state.stage = InstallStage::Installing;
                state.downloaded_bytes = 0;
                state.total_bytes = None;
                state.diagnostic = None;
                state.version = None;
                false
            }
        };
        if already_installing {
            return Ok(self.status());
        }
        self.cancelled.store(false, Ordering::Release);
        let managed_root = self.managed_root.clone();
        let state = Arc::clone(&self.state);
        let worker_state = Arc::clone(&state);
        let cancelled = Arc::clone(&self.cancelled);
        thread::Builder::new()
            .name("ffmpeg-installer".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(|| {
                    install_release(&managed_root, &worker_state, &cancelled)
                })
                .unwrap_or_else(|_| Err("The FFmpeg installer stopped unexpectedly".to_string()));
                let mut install_state = worker_state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                match result {
                    Ok(version) => {
                        install_state.stage = InstallStage::Idle;
                        install_state.version = Some(version);
                        install_state.diagnostic = None;
                    }
                    Err(error) => {
                        install_state.stage = InstallStage::Failed;
                        install_state.diagnostic = Some(error);
                    }
                }
            })
            .map_err(|error| {
                if let Ok(mut install_state) = state.lock() {
                    install_state.stage = InstallStage::Failed;
                    install_state.diagnostic =
                        Some(format!("Cannot start the FFmpeg installer thread: {error}"));
                }
                RelayError::new(
                    "ffmpeg_install_failed",
                    format!("FFmpeg installer could not start: {error}"),
                )
            })?;
        Ok(self.status())
    }

    pub fn shutdown(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn ready_path(&self) -> Option<PathBuf> {
        self.system_path
            .as_ref()
            .filter(|path| path.is_file())
            .cloned()
            .or_else(|| {
                let path = managed_executable(&self.managed_root);
                path.is_file().then_some(path)
            })
    }
}

impl Drop for FfmpegManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn install_release(
    managed_root: &Path,
    state: &Arc<Mutex<InstallState>>,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    fs::create_dir_all(managed_root)
        .map_err(|error| format!("Cannot create the FFmpeg directory: {error}"))?;
    let archive_path = managed_root.join("ffmpeg-release-essentials.zip.part");
    let staged_path = managed_root.join("ffmpeg.exe.new");
    remove_if_present(&archive_path)?;
    remove_if_present(&staged_path)?;

    let result = (|| {
        let client = Client::builder()
            .user_agent("VRC-Bili-Relay/0.1 managed FFmpeg installer")
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(20 * 60))
            .build()
            .map_err(|error| format!("Cannot prepare the FFmpeg download: {error}"))?;
        let expected_checksum = fetch_text(&client, RELEASE_CHECKSUM_URL)?;
        if expected_checksum.len() != 64
            || !expected_checksum
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("The FFmpeg publisher returned an invalid SHA-256 checksum".to_string());
        }
        let version = fetch_text(&client, RELEASE_VERSION_URL)
            .map(|value| normalized_version(&value))
            .unwrap_or_else(|_| "release".to_string());
        if let Ok(mut install_state) = state.lock() {
            install_state.version = Some(version.clone());
        }

        let mut response = client
            .get(RELEASE_ARCHIVE_URL)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("Cannot download FFmpeg: {error}"))?;
        let total_bytes = response.content_length();
        if total_bytes.is_some_and(|total| total > DOWNLOAD_LIMIT_BYTES) {
            return Err("The FFmpeg download is larger than the safety limit".to_string());
        }
        if let Ok(mut install_state) = state.lock() {
            install_state.total_bytes = total_bytes;
        }

        let mut archive = File::create(&archive_path)
            .map_err(|error| format!("Cannot create the FFmpeg download: {error}"))?;
        let mut hasher = Sha256::new();
        let mut downloaded_bytes = 0_u64;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        loop {
            ensure_not_cancelled(cancelled)?;
            let count = response
                .read(&mut buffer)
                .map_err(|error| format!("Cannot read the FFmpeg download: {error}"))?;
            if count == 0 {
                break;
            }
            downloaded_bytes = downloaded_bytes.saturating_add(count as u64);
            if downloaded_bytes > DOWNLOAD_LIMIT_BYTES {
                return Err("The FFmpeg download exceeded the safety limit".to_string());
            }
            archive
                .write_all(&buffer[..count])
                .map_err(|error| format!("Cannot save the FFmpeg download: {error}"))?;
            hasher.update(&buffer[..count]);
            if let Ok(mut install_state) = state.lock() {
                install_state.downloaded_bytes = downloaded_bytes;
            }
        }
        archive
            .sync_all()
            .map_err(|error| format!("Cannot finish the FFmpeg download: {error}"))?;
        let actual_checksum = format!("{:x}", hasher.finalize());
        if !actual_checksum.eq_ignore_ascii_case(expected_checksum.trim()) {
            return Err(
                "FFmpeg failed SHA-256 verification; the download was discarded".to_string(),
            );
        }

        extract_ffmpeg(&archive_path, &staged_path, cancelled)?;
        install_atomically(&staged_path, &managed_executable(managed_root))?;
        let metadata = InstallMetadata {
            version: version.clone(),
            sha256: actual_checksum,
            source: RELEASE_ARCHIVE_URL.to_string(),
        };
        let metadata_bytes = serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("Cannot encode FFmpeg metadata: {error}"))?;
        fs::write(metadata_path(managed_root), metadata_bytes)
            .map_err(|error| format!("Cannot save FFmpeg metadata: {error}"))?;
        Ok(version)
    })();

    let _ = remove_if_present(&archive_path);
    let _ = remove_if_present(&staged_path);
    result
}

fn fetch_text(client: &Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::text)
        .map(|text| text.trim().to_string())
        .map_err(|error| format!("Cannot read FFmpeg release information: {error}"))
}

fn extract_ffmpeg(
    archive_path: &Path,
    target: &Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let archive = File::open(archive_path)
        .map_err(|error| format!("Cannot open the FFmpeg archive: {error}"))?;
    let mut zip = ZipArchive::new(archive)
        .map_err(|error| format!("Cannot read the FFmpeg archive: {error}"))?;
    let index = (0..zip.len())
        .find(|index| {
            zip.by_index(*index)
                .map(|entry| {
                    entry
                        .name()
                        .replace('\\', "/")
                        .to_ascii_lowercase()
                        .ends_with("/bin/ffmpeg.exe")
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| "The FFmpeg archive does not contain bin/ffmpeg.exe".to_string())?;
    let mut entry = zip
        .by_index(index)
        .map_err(|error| format!("Cannot open FFmpeg in the archive: {error}"))?;
    if entry.size() > DOWNLOAD_LIMIT_BYTES {
        return Err("The extracted FFmpeg file is larger than the safety limit".to_string());
    }
    let mut output = File::create(target)
        .map_err(|error| format!("Cannot create the managed FFmpeg executable: {error}"))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut extracted_bytes = 0_u64;
    loop {
        ensure_not_cancelled(cancelled)?;
        let count = entry
            .read(&mut buffer)
            .map_err(|error| format!("Cannot extract FFmpeg: {error}"))?;
        if count == 0 {
            break;
        }
        extracted_bytes = extracted_bytes.saturating_add(count as u64);
        if extracted_bytes > DOWNLOAD_LIMIT_BYTES {
            return Err("The extracted FFmpeg file exceeded the safety limit".to_string());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Cannot save the managed FFmpeg executable: {error}"))?;
    }
    output
        .sync_all()
        .map_err(|error| format!("Cannot finish the managed FFmpeg executable: {error}"))?;
    let mut signature = [0_u8; 2];
    File::open(target)
        .and_then(|mut file| file.read_exact(&mut signature))
        .map_err(|error| format!("Cannot validate the managed FFmpeg executable: {error}"))?;
    if signature != *b"MZ" {
        return Err("The extracted FFmpeg file is not a Windows executable".to_string());
    }
    Ok(())
}

fn install_atomically(staged: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension("exe.old");
    remove_if_present(&backup)?;
    let had_existing = target.is_file();
    if had_existing {
        fs::rename(target, &backup)
            .map_err(|error| format!("Cannot prepare the existing FFmpeg installation: {error}"))?;
    }
    if let Err(error) = fs::rename(staged, target) {
        if had_existing {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!(
            "Cannot activate the managed FFmpeg executable: {error}"
        ));
    }
    let _ = remove_if_present(&backup);
    Ok(())
}

fn normalized_version(value: &str) -> String {
    let normalized: String = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        .take(32)
        .collect();
    if normalized.is_empty() {
        "release".to_string()
    } else {
        normalized
    }
}

fn ensure_not_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("FFmpeg download was cancelled".to_string())
    } else {
        Ok(())
    }
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove {}: {error}", path.display())),
    }
}

fn managed_root() -> PathBuf {
    env::var_os("VRC_BILI_RELAY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .unwrap_or_else(env::temp_dir)
        .join("VRC Bili Relay")
        .join("media")
        .join("ffmpeg")
}

fn managed_executable(root: &Path) -> PathBuf {
    root.join("ffmpeg.exe")
}

fn metadata_path(root: &Path) -> PathBuf {
    root.join("source.json")
}

fn read_metadata(root: &Path) -> Option<InstallMetadata> {
    let bytes = fs::read(metadata_path(root)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn detect_system_ffmpeg() -> Option<PathBuf> {
    if env::var("VRC_BILI_RELAY_IGNORE_SYSTEM_FFMPEG").as_deref() == Ok("1") {
        return None;
    }
    let executable_names: &[&str] = if cfg!(windows) {
        &["ffmpeg.exe", "ffmpeg"]
    } else {
        &["ffmpeg"]
    };
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .flat_map(|directory| {
                executable_names
                    .iter()
                    .map(move |name| directory.join(name))
            })
            .find(|candidate| candidate.is_file())
    })
}
