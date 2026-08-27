use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{RelayError, windows_secret};

const SESSION_FILE: &str = "bilibili-session.json";
const SESSION_VERSION: u32 = 1;
const MAX_SESSION_FILE_BYTES: u64 = 128 * 1024;
const MAX_PROTECTED_SESSION_BYTES: usize = 96 * 1024;
const MAX_COOKIE_BYTES: usize = 32 * 1024;
const MAX_DISPLAY_NAME_BYTES: usize = 320;

pub(crate) struct BilibiliSessionStore {
    path: PathBuf,
}

pub(crate) enum StoredSessionLoad {
    Missing,
    Available(StoredBilibiliSession),
    Unavailable,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredBilibiliSession {
    pub cookie: String,
    pub display_name: String,
    pub user_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDocument {
    version: u32,
    protected_session: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDocumentRef<'a> {
    version: u32,
    protected_session: &'a str,
}

impl BilibiliSessionStore {
    pub fn new() -> Self {
        Self {
            path: session_path(),
        }
    }

    pub fn load(&self) -> StoredSessionLoad {
        match read_session(&self.path) {
            Ok(Some(session)) => StoredSessionLoad::Available(session),
            Ok(None) => match read_session(&backup_path(&self.path)) {
                Ok(Some(session)) => StoredSessionLoad::Available(session),
                Ok(None) => StoredSessionLoad::Missing,
                Err(_) => StoredSessionLoad::Unavailable,
            },
            Err(_) => match read_session(&backup_path(&self.path)) {
                Ok(Some(session)) => StoredSessionLoad::Available(session),
                _ => StoredSessionLoad::Unavailable,
            },
        }
    }

    pub fn save(&self, session: &StoredBilibiliSession) -> Result<(), RelayError> {
        validate_session(session)?;
        let mut payload = serde_json::to_vec(session).map_err(session_write_error)?;
        let protected_result = windows_secret::protect_bilibili_session(&payload);
        payload.fill(0);
        let protected = protected_result?;
        if protected.len() > MAX_PROTECTED_SESSION_BYTES {
            return Err(RelayError::new(
                "bilibili_session_storage_failed",
                "The protected Bilibili session exceeds the local storage limit",
            ));
        }
        let document = SessionDocumentRef {
            version: SESSION_VERSION,
            protected_session: &protected,
        };
        let encoded = serde_json::to_vec_pretty(&document).map_err(session_write_error)?;
        if encoded.len() as u64 > MAX_SESSION_FILE_BYTES {
            return Err(RelayError::new(
                "bilibili_session_storage_failed",
                "The Bilibili session exceeds the local storage limit",
            ));
        }
        self.write(&encoded)
    }

    pub fn clear(&self) -> Result<(), RelayError> {
        remove_if_present(&sibling_path(&self.path, ".tmp"))?;
        remove_if_present(&backup_path(&self.path))?;
        remove_if_present(&self.path)
    }

    fn write(&self, encoded: &[u8]) -> Result<(), RelayError> {
        let parent = self.path.parent().ok_or_else(|| {
            RelayError::new(
                "bilibili_session_storage_failed",
                "The Bilibili session path does not have a parent directory",
            )
        })?;
        fs::create_dir_all(parent).map_err(session_write_error)?;

        let temporary = sibling_path(&self.path, ".tmp");
        let backup = backup_path(&self.path);
        let _ = fs::remove_file(&temporary);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(session_write_error)?;
        let write_result = file
            .write_all(encoded)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all());
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(session_write_error(error));
        }
        drop(file);

        let had_previous = self.path.exists();
        if had_previous {
            let _ = fs::remove_file(&backup);
            fs::rename(&self.path, &backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                session_write_error(error)
            })?;
        }
        if let Err(error) = fs::rename(&temporary, &self.path) {
            if had_previous {
                let _ = fs::rename(&backup, &self.path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(session_write_error(error));
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    }
}

fn read_session(path: &Path) -> Result<Option<StoredBilibiliSession>, RelayError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(session_read_error(error)),
    };
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err(RelayError::new(
            "bilibili_session_invalid",
            "The saved Bilibili session exceeds the local storage limit",
        ));
    }
    let bytes = fs::read(path).map_err(session_read_error)?;
    let document = serde_json::from_slice::<SessionDocument>(&bytes).map_err(session_read_error)?;
    if document.version > SESSION_VERSION
        || document.protected_session.is_empty()
        || document.protected_session.len() > MAX_PROTECTED_SESSION_BYTES
        || !document.protected_session.is_ascii()
    {
        return Err(RelayError::new(
            "bilibili_session_invalid",
            "The saved Bilibili session has an unsupported format",
        ));
    }
    let mut payload = windows_secret::unprotect_bilibili_session(&document.protected_session)
        .map_err(|_| {
            RelayError::new(
                "bilibili_session_invalid",
                "The saved Bilibili session cannot be decrypted by this Windows user",
            )
        })?;
    let decoded =
        serde_json::from_slice::<StoredBilibiliSession>(&payload).map_err(session_read_error);
    payload.fill(0);
    let session = decoded?;
    validate_session(&session)?;
    Ok(Some(session))
}

fn validate_session(session: &StoredBilibiliSession) -> Result<(), RelayError> {
    let cookie = session.cookie.trim();
    let has_session_cookie = cookie.split(';').any(|pair| {
        pair.trim()
            .split_once('=')
            .is_some_and(|(name, value)| name == "SESSDATA" && !value.is_empty())
    });
    if cookie.is_empty()
        || cookie.len() > MAX_COOKIE_BYTES
        || cookie.contains(['\r', '\n', '\0'])
        || !has_session_cookie
    {
        return Err(RelayError::new(
            "bilibili_session_invalid",
            "The saved Bilibili session cookie is invalid",
        ));
    }
    let display_name = session.display_name.trim();
    if display_name.is_empty()
        || display_name.len() > MAX_DISPLAY_NAME_BYTES
        || display_name.contains(['\r', '\n', '\0'])
    {
        return Err(RelayError::new(
            "bilibili_session_invalid",
            "The saved Bilibili account name is invalid",
        ));
    }
    Ok(())
}

fn session_path() -> PathBuf {
    if let Some(path) = env::var_os("VRC_BILI_RELAY_AUTH").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("VRC Bili Relay")
        .join(SESSION_FILE)
}

fn remove_if_present(path: &Path) -> Result<(), RelayError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(session_write_error(error)),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    sibling_path(path, ".backup")
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| SESSION_FILE.to_string());
    path.parent()
        .map(|parent| parent.join(format!("{name}{suffix}")))
        .unwrap_or_else(|| PathBuf::from(format!("{name}{suffix}")))
}

fn session_read_error(error: impl std::fmt::Display) -> RelayError {
    RelayError::new(
        "bilibili_session_invalid",
        format!("The saved Bilibili session could not be read: {error}"),
    )
}

fn session_write_error(error: impl std::fmt::Display) -> RelayError {
    RelayError::new(
        "bilibili_session_storage_failed",
        format!("The Bilibili session could not be saved: {error}"),
    )
}
