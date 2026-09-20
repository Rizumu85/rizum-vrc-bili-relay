use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::REFERER;
use sha2::{Digest, Sha256};
use url::Url;
use crate::FavoriteCover;

const MAX_COVERS: usize = 300;
const MAX_COVER_BYTES: u64 = 2 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
static TEMPORARY_ID: AtomicU64 = AtomicU64::new(0);

/// Bounded downloads; unavailable thumbnails never prevent successful results.
/// Numeric failure categories go to diagnostics, not URLs or response bodies.
pub fn fetch_covers(urls: Vec<String>) -> Vec<FavoriteCover> {
    let started = Instant::now();
    let Some(dir) = covers_dir() else {
        record_failure("storage", started, 0);
        return Vec::new();
    };
    let client = match Client::builder().timeout(Duration::from_secs(10)).user_agent(USER_AGENT).build() {
        Ok(client) => client,
        Err(_) => { record_failure("client", started, 0); return Vec::new(); }
    };
    // Several original URLs can normalize to one thumbnail. Fetch each file
    // once, but preserve every original key for the UI's result correlation.
    let mut unique = HashSet::new();
    let mut downloads: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for raw in urls {
        let url = raw.trim();
        if unique.len() >= 40 { break; }
        if !unique.insert(url.to_owned()) { continue; }
        match sized_cover_url(url) {
            Some(sized) => downloads.entry(sized).or_default().push(url.to_owned()),
            None => record_failure("invalid_url", started, 0),
        }
    }
    let covers = std::thread::scope(|scope| {
        let handles: Vec<_> = downloads.iter().map(|(download, originals)| {
            let (client, dir) = (&client, &dir);
            scope.spawn(move || {
                let at = Instant::now();
                match fetch_one(client, dir, download) {
                    Ok((path, bytes)) => {
                        record_success(at, bytes);
                        originals.iter().map(|url| FavoriteCover {
                            url: url.clone(), path: path.to_string_lossy().into_owned(),
                        }).collect::<Vec<_>>()
                    }
                    Err(category) => { record_failure(category, at, 0); Vec::new() }
                }
            })
        }).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).flatten().collect::<Vec<_>>()
    });
    let protected = covers.iter().map(|cover| PathBuf::from(&cover.path)).collect();
    prune_covers(&dir, &protected);
    covers
}

fn fetch_one(client: &Client, dir: &Path, url: &str) -> Result<(PathBuf, u64), &'static str> {
    let file_name = file_name_for(url);
    let path = dir.join(&file_name);
    if path.is_file() { return Ok((path, 0)); }
    let response = client.get(url).header(REFERER, "https://www.bilibili.com/").send()
        .map_err(|error| if error.is_timeout() { "timeout" } else { "network" })?;
    if !response.status().is_success() { return Err("http_status"); }
    if response.content_length().is_some_and(|length| length > MAX_COVER_BYTES) { return Err("too_large"); }
    let mut bytes = Vec::new();
    response.take(MAX_COVER_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "body_read")?;
    if bytes.len() as u64 > MAX_COVER_BYTES { return Err("too_large"); }
    if bytes.is_empty() { return Err("empty_body"); }
    let id = TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!("{file_name}.{}.{id}.tmp", std::process::id()));
    let result = (|| {
        fs::write(&temporary, &bytes).map_err(|_| "storage_write")?;
        if let Err(_) = fs::rename(&temporary, &path) {
            // Another app instance may have committed the same cache key.
            if !path.is_file() { return Err("storage_rename"); }
        }
        Ok((path, bytes.len() as u64))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn sized_cover_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() { return None; }
    let host = url.host_str()?;
    if (host == "hdslb.com" || host.ends_with(".hdslb.com")) && !url.path().contains('@') {
        url.set_path(&format!("{}@224w_140h.jpg", url.path()));
    }
    url.set_fragment(None);
    Some(url.to_string())
}
fn file_name_for(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    let extension = url.split(['?', '#']).next().and_then(|path| path.rsplit('.').next())
        .filter(|ext| ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("jpg");
    format!("{:x}.{extension}", &digest[..12].iter().fold(0u128, |acc, byte| (acc << 8) | u128::from(*byte)))
}
fn covers_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("VRC Bili Relay").join("covers");
    fs::create_dir_all(&dir).ok().map(|_| dir)
}
fn prune_covers(dir: &Path, protected: &HashSet<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|entry| {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "tmp") || !path.is_file() { return None; }
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        Some((path, modified))
    }).collect();
    let excess = entries.len().saturating_sub(MAX_COVERS);
    entries.sort_by_key(|(_, modified)| *modified);
    for (path, _) in entries.into_iter().filter(|(path, _)| !protected.contains(path)).take(excess) {
        let _ = fs::remove_file(path);
    }
}
fn record_failure(category: &'static str, started: Instant, bytes: u64) {
    let mut progress = crate::stream_diagnostics::Progress::default();
    progress.values.insert("bytes".into(), bytes as f64);
    progress.warnings.insert(category, 1);
    crate::stream_diagnostics::record(std::process::id(), "Cover download", "cover_failed",
        started.elapsed().as_secs_f64(), &Mutex::new(progress));
}
fn record_success(started: Instant, bytes: u64) {
    let mut progress = crate::stream_diagnostics::Progress::default();
    progress.values.insert("bytes".into(), bytes as f64);
    crate::stream_diagnostics::record(std::process::id(), "Cover download", "cover_ready",
        started.elapsed().as_secs_f64(), &Mutex::new(progress));
}
