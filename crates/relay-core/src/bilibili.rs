use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;
use url::Url;

use crate::bilibili_auth::BilibiliAuthService;
use crate::{
    BilibiliAccessMode, BilibiliAuthStatus, FavoriteFolder, FavoriteResourceItem, LiveStatus,
    MediaFormat, MediaInput, RelayError, ResolvedSource, RouteDecision, RouteKind, RouteReason,
    SourceKind, SourceResolution, VideoCollection, VideoCollectionItem, VideoPart, inspect_source,
    normalize_source_input,
};

pub struct FavoriteResourcePage {
    pub items: Vec<FavoriteResourceItem>,
    pub page: u32,
    pub has_more: bool,
}

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

pub struct BilibiliClient {
    http: Client,
    auth: BilibiliAuthService,
    access_mode: BilibiliAccessMode,
}

impl BilibiliClient {
    pub fn new(access_mode: BilibiliAccessMode) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(BROWSER_USER_AGENT)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            auth: BilibiliAuthService::new(http.clone()),
            http,
            access_mode,
        }
    }

    pub fn set_access_mode(&mut self, access_mode: BilibiliAccessMode) {
        self.access_mode = access_mode;
    }

    pub(crate) fn live_room_status(&self, room_id: &str) -> Result<LiveStatus, RelayError> {
        let room_id = room_id
            .parse::<u64>()
            .map_err(|_| RelayError::new("live_room_invalid", "Invalid live room identifier"))?;
        // End-of-stream confirmation must not re-resolve signed media URLs or
        // hold the worker for the normal 20-second source-resolution timeout.
        let response = self
            .http
            .get(format!(
                "https://api.live.bilibili.com/room/v1/Room/room_init?id={room_id}"
            ))
            .header(REFERER, format!("https://live.bilibili.com/{room_id}"))
            .timeout(Duration::from_secs(4))
            .send()
            .map_err(|error| {
                network_error(
                    "bilibili_unavailable",
                    "Cannot confirm live room status",
                    error,
                )
            })?;
        ensure_http_success(&response)?;
        let root: Value = response.json().map_err(|error| {
            network_error(
                "invalid_bilibili_response",
                "Cannot read live room status",
                error,
            )
        })?;
        let data = api_data(
            &root,
            "live_room_unavailable",
            "Cannot confirm live room status",
        )?;
        match u64_field(data, "live_status") {
            Some(0) => Ok(LiveStatus::Offline),
            Some(1) => Ok(LiveStatus::Live),
            Some(2) => Ok(LiveStatus::Replay),
            _ => Err(RelayError::new(
                "live_status_unknown",
                "Live room status is unknown",
            )),
        }
    }

    pub fn auth_status(&self) -> BilibiliAuthStatus {
        self.auth.status()
    }

    pub fn begin_login(&mut self) -> Result<BilibiliAuthStatus, RelayError> {
        self.auth.begin()
    }

    pub fn poll_login(&mut self, login_id: u64) -> Result<BilibiliAuthStatus, RelayError> {
        self.auth.poll(login_id)
    }

    pub fn logout(&mut self) -> Result<BilibiliAuthStatus, RelayError> {
        self.auth.logout()
    }

    pub fn favorite_folders(&self) -> Result<Vec<FavoriteFolder>, RelayError> {
        let mid = self.auth.status().user_id.ok_or_else(|| RelayError::new("login_required", "请先登录 Bilibili"))?;
        let cookie = self.active_cookie().ok_or_else(|| RelayError::new("login_required", "请先登录 Bilibili"))?;
        let response = self.http.get(format!("https://api.bilibili.com/x/v3/fav/folder/created/list?pn=1&ps=50&up_mid={mid}"))
            .header(COOKIE, cookie).header(REFERER, "https://space.bilibili.com/").send()
            .map_err(|e| network_error("bilibili_unavailable", "无法读取收藏夹", e))?;
        ensure_http_success(&response)?;
        let root: Value = response.json().map_err(|e| network_error("invalid_bilibili_response", "无法读取收藏夹", e))?;
        let data = api_data(&root, "favorites_unavailable", "无法读取收藏夹")?;
        Ok(data.get("list").and_then(Value::as_array).into_iter().flatten().filter_map(|item| Some(FavoriteFolder {
            id: item.get("id")?.as_u64()?, title: item.get("title")?.as_str()?.to_owned(), media_count: item.get("media_count").and_then(Value::as_u64).unwrap_or(0) as u32,
        })).collect())
    }

    pub fn favorite_resources(&self, folder_id: u64, page: u32) -> Result<FavoriteResourcePage, RelayError> {
        self.favorite_resources_endpoint(
            format!("https://api.bilibili.com/x/v3/fav/resource/list?media_id={folder_id}&pn={page}&ps=20&platform=web"),
            page,
        )
    }

    pub fn search_favorite_resources(&self, folder_id: Option<u64>, keyword: &str, page: u32) -> Result<FavoriteResourcePage, RelayError> {
        // Favorites search rides on the resource/list endpoint: `type=0` scopes
        // to `media_id`, `type=1` searches across all of the user's folders but
        // still requires a media_id, so borrow the first folder for that.
        let (media_id, scope_all) = match folder_id {
            Some(id) => (id, false),
            None => {
                let folders = self.favorite_folders()?;
                let first = folders
                    .first()
                    .ok_or_else(|| RelayError::new("favorites_empty", "还没有收藏夹"))?
                    .id;
                (first, true)
            }
        };
        let endpoint = Url::parse_with_params("https://api.bilibili.com/x/v3/fav/resource/list", &[
            ("media_id", media_id.to_string()),
            ("keyword", keyword.trim().to_owned()),
            ("pn", page.to_string()),
            ("ps", 20.to_string()),
            ("platform", "web".to_owned()),
            ("type", if scope_all { "1".to_owned() } else { "0".to_owned() }),
        ])
        .map_err(|error| RelayError::new("invalid_favorite_search", format!("收藏搜索参数无效: {error}")))?;
        self.favorite_resources_endpoint(endpoint.to_string(), page)
    }

    fn favorite_resources_endpoint(&self, endpoint: String, page: u32) -> Result<FavoriteResourcePage, RelayError> {
        let data = self.authenticated_get(&endpoint, "favorites_unavailable", "无法读取收藏内容")?;
        let medias = data.get("medias").and_then(Value::as_array);
        let items = medias.into_iter().flatten().filter_map(read_favorite_resource).collect::<Vec<_>>();
        let has_more = data.get("has_more").and_then(Value::as_bool).unwrap_or(items.len() >= 20);
        Ok(FavoriteResourcePage { items, page, has_more })
    }

    pub fn watch_later(&self) -> Result<FavoriteResourcePage, RelayError> {
        let data = self.authenticated_get(
            "https://api.bilibili.com/x/v2/history/toview",
            "watch_later_unavailable",
            "无法读取稍后再看",
        )?;
        let items = data
            .get("list")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(read_watch_later_item)
            .collect::<Vec<_>>();
        Ok(FavoriteResourcePage { items, page: 1, has_more: false })
    }

    pub fn history(&self, page: u32) -> Result<FavoriteResourcePage, RelayError> {
        let data = self.authenticated_get(
            &format!("https://api.bilibili.com/x/v2/history?pn={page}&ps=20"),
            "history_unavailable",
            "无法读取历史记录",
        )?;
        let items = data
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(read_history_item)
            .collect::<Vec<_>>();
        let has_more = items.len() >= 20;
        Ok(FavoriteResourcePage { items, page, has_more })
    }

    fn authenticated_get(&self, endpoint: &str, code: &'static str, context: &'static str) -> Result<Value, RelayError> {
        let cookie = self.active_cookie().ok_or_else(|| RelayError::new("login_required", "请先登录 Bilibili"))?;
        let response = self.http.get(endpoint)
            .header(COOKIE, cookie).header(REFERER, "https://space.bilibili.com/").send()
            .map_err(|e| network_error("bilibili_unavailable", context, e))?;
        ensure_http_success(&response)?;
        let root: Value = response.json().map_err(|e| network_error("invalid_bilibili_response", context, e))?;
        Ok(api_data(&root, code, context)?.clone())
    }

    fn active_cookie(&self) -> Option<&str> {
        (self.access_mode == BilibiliAccessMode::Account)
            .then(|| self.auth.cookie())
            .flatten()
    }

    pub fn resolve(
        &self,
        source: &str,
        requested_part: Option<u32>,
    ) -> Result<ResolvedSource, RelayError> {
        let source = normalize_source_input(source)?;
        let inspection = inspect_source(&source)?;
        match inspection.kind {
            SourceKind::ShortLink => {
                let expanded = self.expand_short_link(&source)?;
                let expanded_inspection = inspect_source(expanded.as_str())?;
                if matches!(expanded_inspection.kind, SourceKind::ShortLink) {
                    return Err(RelayError::new(
                        "short_link_not_resolved",
                        "Bilibili short link did not resolve to a video or live room",
                    ));
                }
                self.resolve(expanded.as_str(), requested_part)
            }
            SourceKind::Video => self.resolve_video(&source, inspection.source_id, requested_part),
            SourceKind::Live => self.resolve_live(inspection.source_id),
            SourceKind::Media => Err(RelayError::new(
                "invalid_media_source",
                "Generic media sources are resolved by the media source module",
            )),
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
    ) -> Result<ResolvedSource, RelayError> {
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
        let collection = read_video_collection(data, &bvid);
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
        let selected_cid = parts
            .get(selected_part.saturating_sub(1) as usize)
            .map(|part| part.cid)
            .ok_or_else(|| {
                RelayError::new(
                    "video_part_not_found",
                    "Selected Bilibili video part is missing",
                )
            })?;
        let referer = format!("https://www.bilibili.com/video/{bvid}");
        let (routing, input) =
            self.resolve_video_route(&bvid, selected_cid, duration_seconds.unwrap_or(1), &referer)?;

        Ok(ResolvedSource {
            resolution: SourceResolution {
                kind: SourceKind::Video,
                source_id: bvid.clone(),
                canonical_url: referer,
                title,
                parts,
                selected_part: Some(selected_part),
                duration_seconds,
                collection,
                live_status: None,
                routing,
                playback_url: None,
                session_id: None,
                session_expires_in_seconds: None,
            },
            input: Some(input),
        })
    }

    fn resolve_live(&self, source_id: Option<String>) -> Result<ResolvedSource, RelayError> {
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
        let referer = format!("https://live.bilibili.com/{canonical_room}");
        let (routing, input) = match live_status {
            LiveStatus::Live => {
                let (routing, input) = self.resolve_live_route(&canonical_room, &referer)?;
                (routing, Some(input))
            }
            LiveStatus::Replay => (unavailable_route(RouteReason::SourceReplay), None),
            LiveStatus::Offline => (unavailable_route(RouteReason::SourceOffline), None),
        };

        Ok(ResolvedSource {
            resolution: SourceResolution {
                kind: SourceKind::Live,
                source_id: canonical_room,
                canonical_url: referer,
                title,
                parts: Vec::new(),
                selected_part: None,
                duration_seconds: None,
                collection: None,
                live_status: Some(live_status),
                routing,
                playback_url: None,
                session_id: None,
                session_expires_in_seconds: None,
            },
            input,
        })
    }

    fn resolve_video_route(
        &self,
        bvid: &str,
        cid: u64,
        duration_seconds: u64,
        referer: &str,
    ) -> Result<(RouteDecision, MediaInput), RelayError> {
        let endpoint = "https://api.bilibili.com/x/player/playurl".to_string()
            + &format!("?bvid={bvid}&cid={cid}&qn=80&fnval=16&fnver=0&fourk=1");
        let root = self.get_json(&endpoint, &format!("https://www.bilibili.com/video/{bvid}"))?;
        let data = api_data(
            &root,
            "video_stream_not_found",
            "Bilibili video streams are unavailable",
        )?;
        let dash = data.get("dash").ok_or_else(|| {
            RelayError::new(
                "unsupported_video_format",
                "Bilibili returned a legacy video format instead of DASH",
            )
        })?;
        let video_streams = dash.get("video").and_then(Value::as_array).ok_or_else(|| {
            RelayError::new(
                "video_stream_not_found",
                "Bilibili returned no video tracks",
            )
        })?;
        let video = select_dash_video(video_streams).ok_or_else(|| {
            RelayError::new(
                "h264_stream_not_found",
                "Bilibili returned no H.264 video track at or below 1080p",
            )
        })?;
        let audio = dash
            .get("audio")
            .and_then(Value::as_array)
            .and_then(|streams| select_dash_audio(streams));
        let has_separate_audio = audio.is_some();
        let estimated_bitrate = video.bandwidth.checked_add(
            audio
                .as_ref()
                .map(|track| track.bandwidth)
                .unwrap_or_default(),
        );

        Ok((
            RouteDecision {
                kind: RouteKind::RelayWithFfmpeg,
                reason: if has_separate_audio {
                    RouteReason::DashTracks
                } else {
                    RouteReason::RequiresHeaders
                },
                media_format: Some(MediaFormat::Dash),
                quality: Some(video.quality),
                estimated_bitrate,
                has_separate_audio,
            },
            MediaInput {
                video_url: video.url,
                audio: audio.map(|track| crate::MediaAudio::Separate(track.url)).unwrap_or(crate::MediaAudio::Silence),
                referer: referer.to_string(),
                is_live: false,
                requires_bilibili_headers: true,
                danmaku_source: Some(crate::danmaku::DanmakuSource::Video(
                    crate::danmaku::VideoDanmakuSource {
                        cid,
                        duration_seconds: duration_seconds.max(1),
                        referer: referer.to_string(),
                        cookie: self.active_cookie().map(str::to_owned),
                    },
                )),
            },
        ))
    }

    fn resolve_live_route(
        &self,
        room_id: &str,
        referer: &str,
    ) -> Result<(RouteDecision, MediaInput), RelayError> {
        let endpoint = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"
            .to_string()
            + &format!(
                "?room_id={room_id}&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8"
            );
        let root = self.get_json(&endpoint, &format!("https://live.bilibili.com/{room_id}"))?;
        let data = api_data(
            &root,
            "live_stream_not_found",
            "Bilibili live stream is unavailable",
        )?;
        let play_url = data
            .get("playurl_info")
            .and_then(|value| value.get("playurl"))
            .ok_or_else(|| {
                RelayError::new(
                    "live_stream_not_found",
                    "Bilibili returned no live playback information",
                )
            })?;
        let selected = select_live_candidate(play_url).ok_or_else(|| {
            RelayError::new(
                "h264_stream_not_found",
                "Bilibili returned no H.264 FLV or MPEG-TS live stream",
            )
        })?;
        let reason = match selected.format {
            MediaFormat::Flv => RouteReason::FlvContainer,
            MediaFormat::MpegTs => RouteReason::MpegTsContainer,
            MediaFormat::Dash => RouteReason::RequiresHeaders,
            MediaFormat::Hls | MediaFormat::Mp4 => RouteReason::RequiresHeaders,
        };

        Ok((
            RouteDecision {
                kind: RouteKind::RelayWithFfmpeg,
                reason,
                media_format: Some(selected.format),
                quality: Some(selected.quality),
                estimated_bitrate: None,
                has_separate_audio: false,
            },
            MediaInput {
                video_url: selected.url,
                audio: crate::MediaAudio::Embedded,
                referer: referer.to_string(),
                is_live: true,
                requires_bilibili_headers: true,
                danmaku_source: Some(crate::danmaku::DanmakuSource::Live(
                    crate::live_danmaku::LiveDanmakuSource {
                        room_id: room_id.to_string(),
                        referer: referer.to_string(),
                        cookie: self.active_cookie().map(str::to_owned),
                    },
                )),
            },
        ))
    }

    fn get_json(&self, endpoint: &str, referer: &str) -> Result<Value, RelayError> {
        let mut request = self
            .http
            .get(endpoint)
            .header(USER_AGENT, BROWSER_USER_AGENT)
            .header(ACCEPT, "application/json")
            .header(REFERER, referer);
        if let Some(cookie) = self.active_cookie() {
            request = request.header(COOKIE, cookie);
        }
        let response = request.send().map_err(|error| {
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

fn read_video_collection(data: &Value, current_bvid: &str) -> Option<VideoCollection> {
    let season = data.get("ugc_season")?;
    let id = u64_field(season, "id")?;
    let title = string_field(season, "title")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "合集".to_string());
    let items = season
        .get("sections")?
        .as_array()?
        .iter()
        .filter_map(|section| section.get("episodes").and_then(Value::as_array))
        .flatten()
        .filter_map(|episode| {
            let source_id = string_field(episode, "bvid")?;
            let title = string_field(episode, "title")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| source_id.clone());
            let duration_seconds = episode
                .get("arc")
                .and_then(|arc| u64_field(arc, "duration"))
                .or_else(|| {
                    episode
                        .get("pages")
                        .and_then(Value::as_array)
                        .and_then(|pages| pages.first())
                        .and_then(|page| u64_field(page, "duration"))
                })
                .unwrap_or(1)
                .max(1);
            Some((source_id, title, duration_seconds))
        })
        .enumerate()
        .map(
            |(index, (source_id, title, duration_seconds))| VideoCollectionItem {
                index: index as u32 + 1,
                canonical_url: format!("https://www.bilibili.com/video/{source_id}"),
                source_id,
                title,
                duration_seconds,
            },
        )
        .collect::<Vec<_>>();
    if items.len() <= 1 {
        return None;
    }
    let selected_item = items
        .iter()
        .position(|item| item.source_id.eq_ignore_ascii_case(current_bvid))?
        as u32
        + 1;
    Some(VideoCollection {
        id,
        title,
        selected_item,
        items,
    })
}

struct DashTrack {
    url: String,
    quality: u32,
    bandwidth: u64,
}

struct LiveCandidate {
    url: String,
    format: MediaFormat,
    quality: u32,
    score: (u8, u8, u8),
}

fn select_dash_video(streams: &[Value]) -> Option<DashTrack> {
    streams
        .iter()
        .filter_map(|stream| {
            let codec_id = u64_field(stream, "codecid").unwrap_or_default();
            let codecs = string_field(stream, "codecs").unwrap_or_default();
            if codec_id != 7 && !codecs.to_ascii_lowercase().starts_with("avc") {
                return None;
            }
            let quality = u32_field(stream, "id").unwrap_or_default();
            let url = read_media_url(stream)?;
            if quality > 80 {
                return None;
            }
            Some(DashTrack {
                url: url.to_string(),
                quality,
                bandwidth: u64_field(stream, "bandwidth").unwrap_or_default(),
            })
        })
        .max_by_key(|track| track.quality)
}

fn select_dash_audio(streams: &[Value]) -> Option<DashTrack> {
    streams
        .iter()
        .filter_map(|stream| {
            let url = read_media_url(stream)?;
            Some(DashTrack {
                url: url.to_string(),
                quality: u32_field(stream, "id").unwrap_or_default(),
                bandwidth: u64_field(stream, "bandwidth").unwrap_or_default(),
            })
        })
        .max_by_key(|track| track.bandwidth)
}

fn select_live_candidate(play_url: &Value) -> Option<LiveCandidate> {
    let streams = play_url.get("stream")?.as_array()?;
    streams
        .iter()
        .flat_map(|stream| {
            let protocol = string_field(stream, "protocol_name").unwrap_or_default();
            let protocol_score = u8::from(protocol != "http_stream");
            stream
                .get("format")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(move |format| {
                    let format_name = string_field(format, "format_name").unwrap_or_default();
                    let media_format = match format_name.as_str() {
                        "flv" => Some((MediaFormat::Flv, 0)),
                        "ts" => Some((MediaFormat::MpegTs, 1)),
                        _ => None,
                    };
                    format
                        .get("codec")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(move |codec| {
                            if !string_field(codec, "codec_name")
                                .is_some_and(|value| value.eq_ignore_ascii_case("avc"))
                            {
                                return None;
                            }
                            let (media_format, format_score) = media_format?;
                            let url_info = codec.get("url_info")?.as_array()?;
                            let selected_url = url_info.iter().find_map(|info| {
                                let host = string_field(info, "host").unwrap_or_default();
                                let base = string_field(codec, "base_url").unwrap_or_default();
                                let extra = string_field(info, "extra").unwrap_or_default();
                                Url::parse(&(host + &base + &extra))
                                    .ok()
                                    .filter(|url| matches!(url.scheme(), "http" | "https"))
                            });
                            let selected_url = selected_url?;
                            let uses_mcdn = url_info.iter().any(|info| {
                                string_field(info, "host")
                                    .is_some_and(|host| host.to_ascii_lowercase().contains("mcdn"))
                            });
                            Some(LiveCandidate {
                                url: selected_url.to_string(),
                                format: media_format,
                                quality: u32_field(codec, "current_qn").unwrap_or_default(),
                                score: (protocol_score, format_score, u8::from(uses_mcdn)),
                            })
                        })
                })
        })
        .min_by(|left, right| {
            left.score
                .cmp(&right.score)
                .then_with(|| right.quality.cmp(&left.quality))
        })
}

fn read_media_url(stream: &Value) -> Option<Url> {
    let value = string_field(stream, "baseUrl").or_else(|| string_field(stream, "base_url"))?;
    Url::parse(&value)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
}

fn unavailable_route(reason: RouteReason) -> RouteDecision {
    RouteDecision {
        kind: RouteKind::Unavailable,
        reason,
        media_format: None,
        quality: None,
        estimated_bitrate: None,
        has_separate_audio: false,
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
        -101 | -10403 => "login_required",
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

fn normalize_cover_url(cover: String) -> String {
    if let Some(rest) = cover.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        cover.replacen("http://", "https://", 1)
    }
}

fn read_favorite_resource(item: &Value) -> Option<FavoriteResourceItem> {
    let bvid = string_field(item, "bvid")?;
    let title = string_field(item, "title")?
        .replace("<em class=\"keyword\">", "")
        .replace("</em>", "");
    let cover_url = normalize_cover_url(string_field(item, "cover").unwrap_or_default());
    Some(FavoriteResourceItem {
        bvid,
        title,
        duration_seconds: u64_field(item, "duration").unwrap_or(0),
        owner_name: item
            .get("upper")
            .and_then(|upper| string_field(upper, "name"))
            .unwrap_or_default(),
        cover_url,
        folder_title: string_field(item, "folder_title")
            .or_else(|| item.get("folder").and_then(|folder| string_field(folder, "title"))),
    })
}

fn read_watch_later_item(item: &Value) -> Option<FavoriteResourceItem> {
    Some(FavoriteResourceItem {
        bvid: string_field(item, "bvid")?,
        title: string_field(item, "title")?,
        duration_seconds: u64_field(item, "duration").unwrap_or(0),
        owner_name: item
            .get("owner")
            .and_then(|owner| string_field(owner, "name"))
            .unwrap_or_default(),
        cover_url: normalize_cover_url(string_field(item, "pic").unwrap_or_default()),
        folder_title: None,
    })
}

fn read_history_item(item: &Value) -> Option<FavoriteResourceItem> {
    Some(FavoriteResourceItem {
        bvid: string_field(item, "bvid")?,
        title: string_field(item, "title")?,
        duration_seconds: u64_field(item, "duration").unwrap_or(0),
        owner_name: item
            .get("owner")
            .and_then(|owner| string_field(owner, "name"))
            .unwrap_or_default(),
        cover_url: normalize_cover_url(string_field(item, "cover43").unwrap_or_default()),
        folder_title: None,
    })
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
