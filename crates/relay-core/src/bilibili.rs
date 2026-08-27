use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use serde_json::Value;
use url::Url;

use crate::{LiveStatus, RelayError, SourceKind, SourceResolution, VideoPart, inspect_source};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

pub struct BilibiliClient {
    http: Client,
}

impl BilibiliClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(BROWSER_USER_AGENT)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { http }
    }

    pub fn resolve(
        &self,
        source: &str,
        requested_part: Option<u32>,
    ) -> Result<SourceResolution, RelayError> {
        let inspection = inspect_source(source)?;
        match inspection.kind {
            SourceKind::ShortLink => {
                let expanded = self.expand_short_link(source)?;
                let expanded_inspection = inspect_source(expanded.as_str())?;
                if matches!(expanded_inspection.kind, SourceKind::ShortLink) {
                    return Err(RelayError::new(
                        "short_link_not_resolved",
                        "Bilibili short link did not resolve to a video or live room",
                    ));
                }
                self.resolve(expanded.as_str(), requested_part)
            }
            SourceKind::Video => self.resolve_video(source, inspection.source_id, requested_part),
            SourceKind::Live => self.resolve_live(inspection.source_id),
        }
    }

    fn expand_short_link(&self, source: &str) -> Result<Url, RelayError> {
        let response = self.http.get(source.trim()).send().map_err(|error| {
            network_error(
                "short_link_failed",
                "Bilibili short link could not be opened",
                error,
            )
        })?;
        ensure_http_success(&response)?;
        Ok(response.url().clone())
    }

    fn resolve_video(
        &self,
        source: &str,
        source_id: Option<String>,
        requested_part: Option<u32>,
    ) -> Result<SourceResolution, RelayError> {
        let source_id = source_id
            .ok_or_else(|| RelayError::new("invalid_video", "Bilibili video id is missing"))?;
        let query = if source_id.to_ascii_lowercase().starts_with("av") {
            format!("aid={}", &source_id[2..])
        } else {
            format!("bvid={source_id}")
        };
        let endpoint = format!("https://api.bilibili.com/x/web-interface/view?{query}");
        let root = self.get_json(&endpoint, "https://www.bilibili.com/")?;
        let data = api_data(
            &root,
            "video_not_found",
            "Bilibili video metadata is unavailable",
        )?;

        let bvid = string_field(data, "bvid").unwrap_or(source_id);
        let title = string_field(data, "title").unwrap_or_else(|| bvid.clone());
        let pages = data.get("pages").and_then(Value::as_array).ok_or_else(|| {
            RelayError::new("video_has_no_parts", "Bilibili video has no playable parts")
        })?;
        let parts = pages
            .iter()
            .enumerate()
            .map(|(index, page)| {
                let page_number = u32_field(page, "page").unwrap_or(index as u32 + 1);
                VideoPart {
                    page: page_number,
                    cid: u64_field(page, "cid").unwrap_or_default(),
                    title: string_field(page, "part")
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| format!("P{page_number}")),
                    duration_seconds: u64_field(page, "duration").unwrap_or(1).max(1),
                }
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return Err(RelayError::new(
                "video_has_no_parts",
                "Bilibili video has no playable parts",
            ));
        }

        let part_from_source = read_part_from_source(source);
        let selected_part = requested_part
            .or(part_from_source)
            .unwrap_or(1)
            .clamp(1, parts.len() as u32);
        let duration_seconds = parts
            .get(selected_part.saturating_sub(1) as usize)
            .map(|part| part.duration_seconds);

        Ok(SourceResolution {
            kind: SourceKind::Video,
            source_id: bvid.clone(),
            canonical_url: format!("https://www.bilibili.com/video/{bvid}"),
            title,
            parts,
            selected_part: Some(selected_part),
            duration_seconds,
            live_status: None,
        })
    }

    fn resolve_live(&self, source_id: Option<String>) -> Result<SourceResolution, RelayError> {
        let requested_room = source_id.ok_or_else(|| {
            RelayError::new("invalid_live_room", "Bilibili live room id is missing")
        })?;
        let init_endpoint =
            format!("https://api.live.bilibili.com/room/v1/Room/room_init?id={requested_room}");
        let init_root = self.get_json(
            &init_endpoint,
            &format!("https://live.bilibili.com/{requested_room}"),
        )?;
        let init = api_data(
            &init_root,
            "live_room_not_found",
            "Bilibili live room is unavailable",
        )?;
        let canonical_room = u64_field(init, "room_id")
            .map(|value| value.to_string())
            .unwrap_or(requested_room);
        let live_status = match u64_field(init, "live_status").unwrap_or_default() {
            1 => LiveStatus::Live,
            2 => LiveStatus::Replay,
            _ => LiveStatus::Offline,
        };

        let info_endpoint =
            format!("https://api.live.bilibili.com/room/v1/Room/get_info?room_id={canonical_room}");
        let info_root = self.get_json(
            &info_endpoint,
            &format!("https://live.bilibili.com/{canonical_room}"),
        )?;
        let info = api_data(
            &info_root,
            "live_room_not_found",
            "Bilibili live room metadata is unavailable",
        )?;
        let title = string_field(info, "title")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("Bilibili 直播间 {canonical_room}"));

        Ok(SourceResolution {
            kind: SourceKind::Live,
            source_id: canonical_room.clone(),
            canonical_url: format!("https://live.bilibili.com/{canonical_room}"),
            title,
            parts: Vec::new(),
            selected_part: None,
            duration_seconds: None,
            live_status: Some(live_status),
        })
    }

    fn get_json(&self, endpoint: &str, referer: &str) -> Result<Value, RelayError> {
        let response = self
            .http
            .get(endpoint)
            .header(USER_AGENT, BROWSER_USER_AGENT)
            .header(ACCEPT, "application/json")
            .header(REFERER, referer)
            .send()
            .map_err(|error| {
                network_error("bilibili_unavailable", "Bilibili API is unavailable", error)
            })?;
        ensure_http_success(&response)?;
        response.json::<Value>().map_err(|error| {
            network_error(
                "invalid_bilibili_response",
                "Bilibili returned data that could not be read",
                error,
            )
        })
    }
}

fn ensure_http_success(response: &Response) -> Result<(), RelayError> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(RelayError::new(
            "bilibili_http_error",
            format!("Bilibili returned HTTP {}", response.status().as_u16()),
        ))
    }
}

fn api_data<'a>(
    root: &'a Value,
    not_found_code: &'static str,
    fallback: &str,
) -> Result<&'a Value, RelayError> {
    let code = root.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code == 0 {
        return root
            .get("data")
            .ok_or_else(|| RelayError::new("invalid_bilibili_response", fallback));
    }
    let message = root
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback);
    let error_code = match code {
        -404 => not_found_code,
        -10403 => "login_required",
        _ => "bilibili_api_error",
    };
    Err(RelayError::new(error_code, message))
}

fn read_part_from_source(source: &str) -> Option<u32> {
    let url = Url::parse(source.trim()).ok()?;
    url.query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("p"))
        .and_then(|(_, value)| value.parse().ok())
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    value.get(name)?.as_str().map(str::to_owned)
}

fn u64_field(value: &Value, name: &str) -> Option<u64> {
    value.get(name)?.as_u64()
}

fn u32_field(value: &Value, name: &str) -> Option<u32> {
    u64_field(value, name).and_then(|value| u32::try_from(value).ok())
}

fn network_error(code: &'static str, context: &str, error: impl std::fmt::Display) -> RelayError {
    RelayError::new(code, format!("{context}: {error}"))
}
