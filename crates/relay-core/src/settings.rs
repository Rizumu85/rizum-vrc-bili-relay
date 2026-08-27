use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{ProductSettings, RelayError, RelayTarget, SettingsUpdate, ThemePreference};

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_VERSION: u32 = 1;
const MAX_SETTINGS_BYTES: u64 = 128 * 1024;
const LEGACY_PLAYBACK_PREFIX: &str = "https://stream.vrcdn.live/play/";

pub(crate) struct SettingsStore {
    path: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredSettings {
    host: String,
    key: String,
    #[serde(alias = "playbackPrefix", alias = "playback_prefix")]
    playback_url: String,
    theme: ThemePreference,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            host: "vrcdn.live".to_string(),
            key: String::new(),
            playback_url: String::new(),
            theme: ThemePreference::System,
        }
    }
}

impl StoredSettings {
    fn public(&self) -> ProductSettings {
        ProductSettings {
            host: self.host.clone(),
            playback_url: self.playback_url.clone(),
            theme: self.theme,
            stream_key_configured: !self.key.is_empty(),
        }
    }

    fn relay_target(&self, start_seconds: f64) -> RelayTarget {
        RelayTarget {
            ingest_server: self.host.clone(),
            stream_key: self.key.clone(),
            playback_url: self.playback_url.clone(),
            start_seconds,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDocument<'a> {
    version: u32,
    #[serde(flatten)]
    settings: &'a StoredSettings,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            path: settings_path(),
        }
    }

    pub fn load(&self) -> Result<ProductSettings, RelayError> {
        self.load_private().map(|settings| settings.public())
    }

    pub fn save(&self, update: SettingsUpdate) -> Result<ProductSettings, RelayError> {
        let key = match update.stream_key {
            Some(key) => key,
            None => self.load_private()?.key,
        };
        let stored = normalize_and_validate(StoredSettings {
            host: update.host,
            key,
            playback_url: update.playback_url,
            theme: update.theme,
        })?;
        self.write(&stored)?;
        Ok(stored.public())
    }

    pub fn relay_target(&self, start_seconds: f64) -> Result<RelayTarget, RelayError> {
        Ok(self.load_private()?.relay_target(start_seconds))
    }

    fn load_private(&self) -> Result<StoredSettings, RelayError> {
        match read_settings(&self.path) {
            Ok(Some(settings)) => Ok(settings),
            Ok(None) => self.load_backup_or_default(),
            Err(primary_error) => match read_settings(&backup_path(&self.path)) {
                Ok(Some(settings)) => Ok(settings),
                _ => Err(primary_error),
            },
        }
    }

    fn load_backup_or_default(&self) -> Result<StoredSettings, RelayError> {
        match read_settings(&backup_path(&self.path))? {
            Some(settings) => Ok(settings),
            None => Ok(StoredSettings::default()),
        }
    }

    fn write(&self, settings: &StoredSettings) -> Result<(), RelayError> {
        let parent = self.path.parent().ok_or_else(|| {
            RelayError::new(
                "settings_write_failed",
                "The settings path does not have a parent directory",
            )
        })?;
        fs::create_dir_all(parent).map_err(settings_write_error)?;

        let temporary = sibling_path(&self.path, ".tmp");
        let backup = backup_path(&self.path);
        let document = SettingsDocument {
            version: SETTINGS_VERSION,
            settings,
        };
        let encoded = serde_json::to_vec_pretty(&document).map_err(|error| {
            RelayError::new(
                "settings_write_failed",
                format!("Settings could not be encoded: {error}"),
            )
        })?;
        if encoded.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(RelayError::new(
                "settings_too_large",
                "Settings exceed the local storage limit",
            ));
        }

        let _ = fs::remove_file(&temporary);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(settings_write_error)?;
        let write_result = file
            .write_all(&encoded)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all());
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(settings_write_error(error));
        }
        drop(file);

        let had_previous = self.path.exists();
        if had_previous {
            let _ = fs::remove_file(&backup);
            fs::rename(&self.path, &backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                settings_write_error(error)
            })?;
        }
        if let Err(error) = fs::rename(&temporary, &self.path) {
            if had_previous {
                let _ = fs::rename(&backup, &self.path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(settings_write_error(error));
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    }
}

fn read_settings(path: &Path) -> Result<Option<StoredSettings>, RelayError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(settings_read_error(error)),
    };
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err(RelayError::new(
            "settings_too_large",
            "The local settings file exceeds the supported size",
        ));
    }
    let bytes = fs::read(path).map_err(settings_read_error)?;
    let settings = serde_json::from_slice::<StoredSettings>(&bytes).map_err(|error| {
        RelayError::new(
            "settings_invalid_data",
            format!("The local settings file is invalid: {error}"),
        )
    })?;
    normalize_and_validate(settings).map(Some)
}

fn normalize_and_validate(mut settings: StoredSettings) -> Result<StoredSettings, RelayError> {
    settings.host = settings.host.trim().to_string();
    settings.key = settings.key.trim().to_string();
    settings.playback_url = settings.playback_url.trim().to_string();
    if settings.playback_url == LEGACY_PLAYBACK_PREFIX {
        settings.playback_url.clear();
    }
    validate_field("server", &settings.host, 2 * 1024)?;
    validate_field("stream key", &settings.key, 8 * 1024)?;
    validate_field("playback URL", &settings.playback_url, 16 * 1024)?;
    Ok(settings)
}

fn validate_field(label: &str, value: &str, maximum: usize) -> Result<(), RelayError> {
    if value.len() > maximum {
        return Err(RelayError::new(
            "settings_too_large",
            format!("The {label} exceeds the local storage limit"),
        ));
    }
    if value.contains(['\0', '\r', '\n']) {
        return Err(RelayError::new(
            "settings_invalid_data",
            format!("The {label} contains unsupported control characters"),
        ));
    }
    Ok(())
}

fn settings_path() -> PathBuf {
    if let Some(path) = env::var_os("VRC_BILI_RELAY_SETTINGS").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("VRC Bili Relay")
        .join(SETTINGS_FILE)
}

fn backup_path(path: &Path) -> PathBuf {
    sibling_path(path, ".backup")
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| SETTINGS_FILE.to_string());
    path.parent()
        .map(|parent| parent.join(format!("{name}{suffix}")))
        .unwrap_or_else(|| PathBuf::from(format!("{name}{suffix}")))
}

fn settings_read_error(error: impl std::fmt::Display) -> RelayError {
    RelayError::new(
        "settings_read_failed",
        format!("Local settings could not be read: {error}"),
    )
}

fn settings_write_error(error: impl std::fmt::Display) -> RelayError {
    RelayError::new(
        "settings_write_failed",
        format!("Local settings could not be saved: {error}"),
    )
}
