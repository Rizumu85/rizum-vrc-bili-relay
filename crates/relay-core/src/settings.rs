use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    ProductSettings, RelayError, RelayTarget, SettingsUpdate, StreamKeyStatus, ThemePreference,
    windows_secret,
};

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_VERSION: u32 = 2;
const MAX_SETTINGS_BYTES: u64 = 128 * 1024;
const MAX_PROTECTED_KEY_BYTES: usize = 32 * 1024;
const LEGACY_PLAYBACK_PREFIX: &str = "https://stream.vrcdn.live/play/";

pub(crate) struct SettingsStore {
    path: PathBuf,
}

#[derive(Clone)]
enum StreamKeySecret {
    Missing,
    Available {
        plaintext: String,
        protected: String,
    },
    Unavailable {
        protected: String,
    },
}

impl StreamKeySecret {
    fn from_plaintext(mut plaintext: String) -> Result<Self, RelayError> {
        plaintext = plaintext.trim().to_string();
        validate_field("stream key", &plaintext, 8 * 1024)?;
        if plaintext.is_empty() {
            return Ok(Self::Missing);
        }
        let protected = windows_secret::protect_stream_key(&plaintext)?;
        Ok(Self::Available {
            plaintext,
            protected,
        })
    }

    fn from_protected(protected: String) -> Self {
        match windows_secret::unprotect_stream_key(&protected) {
            Ok(plaintext) if validate_stream_key(&plaintext).is_ok() && !plaintext.is_empty() => {
                Self::Available {
                    plaintext,
                    protected,
                }
            }
            _ => Self::Unavailable { protected },
        }
    }

    fn status(&self) -> StreamKeyStatus {
        match self {
            Self::Missing => StreamKeyStatus::Missing,
            Self::Available { .. } => StreamKeyStatus::Available,
            Self::Unavailable { .. } => StreamKeyStatus::Unavailable,
        }
    }

    fn protected(&self) -> Option<&str> {
        match self {
            Self::Missing => None,
            Self::Available { protected, .. } | Self::Unavailable { protected } => Some(protected),
        }
    }

    fn plaintext(&self) -> Result<&str, RelayError> {
        match self {
            Self::Missing => Err(RelayError::new(
                "invalid_stream_key",
                "The VRCDN stream key is not configured",
            )),
            Self::Available { plaintext, .. } => Ok(plaintext),
            Self::Unavailable { .. } => Err(RelayError::new(
                "settings_secret_unavailable",
                "The saved stream key cannot be decrypted by the current Windows user",
            )),
        }
    }
}

#[derive(Clone)]
struct StoredSettings {
    host: String,
    stream_key: StreamKeySecret,
    playback_url: String,
    theme: ThemePreference,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            host: "vrcdn.live".to_string(),
            stream_key: StreamKeySecret::Missing,
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
            stream_key_status: self.stream_key.status(),
        }
    }

    fn relay_target(&self, start_seconds: f64) -> Result<RelayTarget, RelayError> {
        Ok(RelayTarget {
            ingest_server: self.host.clone(),
            stream_key: self.stream_key.plaintext()?.to_string(),
            playback_url: self.playback_url.clone(),
            start_seconds,
        })
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    host: String,
    key: Option<String>,
    protected_key: Option<String>,
    #[serde(alias = "playbackPrefix", alias = "playback_prefix")]
    playback_url: String,
    theme: ThemePreference,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            version: 0,
            host: "vrcdn.live".to_string(),
            key: None,
            protected_key: None,
            playback_url: String::new(),
            theme: ThemePreference::System,
        }
    }
}

struct LoadedSettings {
    settings: StoredSettings,
    needs_rewrite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDocument<'a> {
    version: u32,
    host: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    protected_key: Option<&'a str>,
    playback_url: &'a str,
    theme: ThemePreference,
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

    pub fn reveal_stream_key(&self) -> Result<String, RelayError> {
        self.load_private()?
            .stream_key
            .plaintext()
            .map(str::to_string)
    }

    pub fn save(&self, update: SettingsUpdate) -> Result<ProductSettings, RelayError> {
        let stream_key = match update.stream_key {
            Some(key) => StreamKeySecret::from_plaintext(key)?,
            None => self.load_private()?.stream_key,
        };
        let stored = normalize_and_validate(StoredSettings {
            host: update.host,
            stream_key,
            playback_url: update.playback_url,
            theme: update.theme,
        })?;
        self.write(&stored)?;
        Ok(stored.public())
    }

    pub fn relay_target(&self, start_seconds: f64) -> Result<RelayTarget, RelayError> {
        self.load_private()?.relay_target(start_seconds)
    }

    fn load_private(&self) -> Result<StoredSettings, RelayError> {
        let loaded = match read_settings(&self.path) {
            Ok(Some(settings)) => settings,
            Ok(None) => match read_settings(&backup_path(&self.path))? {
                Some(settings) => settings,
                None => return Ok(StoredSettings::default()),
            },
            Err(primary_error) => match read_settings(&backup_path(&self.path)) {
                Ok(Some(settings)) => settings,
                _ => return Err(primary_error),
            },
        };
        if loaded.needs_rewrite {
            self.write(&loaded.settings)?;
        }
        Ok(loaded.settings)
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
            host: &settings.host,
            protected_key: settings.stream_key.protected(),
            playback_url: &settings.playback_url,
            theme: settings.theme,
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

fn read_settings(path: &Path) -> Result<Option<LoadedSettings>, RelayError> {
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
    let file = serde_json::from_slice::<SettingsFile>(&bytes).map_err(|error| {
        RelayError::new(
            "settings_invalid_data",
            format!("The local settings file is invalid: {error}"),
        )
    })?;
    if file.version > SETTINGS_VERSION {
        return Err(RelayError::new(
            "settings_invalid_data",
            "The local settings file was written by a newer app version",
        ));
    }

    let had_legacy_key = file.key.is_some();
    let protected_key = file.protected_key.filter(|value| !value.is_empty());
    if protected_key
        .as_ref()
        .is_some_and(|value| value.len() > MAX_PROTECTED_KEY_BYTES || !value.is_ascii())
    {
        return Err(RelayError::new(
            "settings_too_large",
            "The protected stream key exceeds the local storage limit",
        ));
    }
    let stream_key = match protected_key {
        Some(protected) => StreamKeySecret::from_protected(protected),
        None => StreamKeySecret::from_plaintext(file.key.unwrap_or_default())?,
    };
    let settings = normalize_and_validate(StoredSettings {
        host: file.host,
        stream_key,
        playback_url: file.playback_url,
        theme: file.theme,
    })?;
    Ok(Some(LoadedSettings {
        settings,
        needs_rewrite: file.version < SETTINGS_VERSION || had_legacy_key,
    }))
}

fn normalize_and_validate(mut settings: StoredSettings) -> Result<StoredSettings, RelayError> {
    settings.host = settings.host.trim().to_string();
    settings.playback_url = settings.playback_url.trim().to_string();
    if settings.playback_url == LEGACY_PLAYBACK_PREFIX {
        settings.playback_url.clear();
    }
    validate_field("server", &settings.host, 2 * 1024)?;
    validate_field("playback URL", &settings.playback_url, 16 * 1024)?;
    Ok(settings)
}

fn validate_stream_key(value: &str) -> Result<(), RelayError> {
    validate_field("stream key", value, 8 * 1024)
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
