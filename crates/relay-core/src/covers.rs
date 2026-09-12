use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::REFERER;
use sha2::{Digest, Sha256};

use crate::FavoriteCover;

const MAX_COVERS: usize = 300;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/// Downloads favorite-video covers into the local cache directory and returns
/// the covers that are available as local files. Individual failures are
/// skipped so a missing cover never blocks the list itself.
pub fn fetch_covers(urls: Vec<String>) -> Vec<FavoriteCover> {
    let Some(dir) = covers_dir() else {
        return Vec::new();
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_else(|_| Client::new());

    let mut unique: Vec<&str> = Vec::new();
    for url in &urls {
        let url = url.trim();
        if url.starts_with("https://") && !unique.contains(&url) {
            unique.push(url);
        }
    }
    unique.truncate(40);

    let covers = std::thread::scope(|scope| {
        let handles: Vec<_> = unique
            .iter()
            .map(|url| scope.spawn(|| fetch_one(&client, &dir, url)))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok().flatten())
            .collect::<Vec<_>>()
    });
    prune_covers(&dir);
    covers
}

fn fetch_one(client: &Client, dir: &Path, url: &str) -> Option<FavoriteCover> {
    let path = dir.join(file_name_for(url));
    if !path.exists() {
        let response = client
            .get(url)
            .header(REFERER, "https://www.bilibili.com/")
            .send()
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().ok()?;
        let tmp = dir.join(format!("{}.tmp", std::process::id()));
        fs::write(&tmp, &bytes).ok()?;
        fs::rename(&tmp, &path).ok()?;
    }
    Some(FavoriteCover {
        url: url.to_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

fn file_name_for(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    let extension = url
        .split(['?', '#'])
        .next()
        .and_then(|path| path.rsplit('.').next())
        .filter(|ext| ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("jpg");
    format!(
        "{:x}.{extension}",
        &digest[..12]
            .iter()
            .fold(0u128, |acc, byte| (acc << 8) | u128::from(*byte))
    )
}

fn covers_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("VRC Bili Relay")
        .join("covers");
    fs::create_dir_all(&dir).ok().map(|_| dir)
}

fn prune_covers(dir: &Path) {
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "tmp") {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            Some((path, modified))
        })
        .collect();
    if entries.len() <= MAX_COVERS {
        return;
    }
    entries.sort_by_key(|(_, modified)| *modified);
    let excess = entries.len() - MAX_COVERS;
    for (path, _) in entries.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}
