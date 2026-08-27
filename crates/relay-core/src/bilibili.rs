use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;
use url::Url;

use crate::bilibili_auth::BilibiliAuthService;
use crate::{
    BilibiliAuthStatus, LiveStatus, MediaFormat, MediaInput, RelayError, ResolvedSource,
    RouteDecision, RouteKind, RouteReason, SourceKind, SourceResolution, VideoPart, inspect_source,
};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

pub struct BilibiliClient {
    http: Client,
    auth: BilibiliAuthService,
}

impl BilibiliClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(BROWSER_USER_AGENT)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            auth: BilibiliAuthService::new(http.clone()),
            http,
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

    pub fn logout(&mut self) -> BilibiliAuthStatus {
        self.auth.logout()
    }

    pub fn resolve(
        &self,
        source: &str,
        requested_part: Option<u32>,
    ) -> Result<ResolvedSource, RelayError> {
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
                audio_url: audio.map(|track| track.url),
                referer: referer.to_string(),
                is_live: false,
                requires_bilibili_headers: true,
                danmaku_source: Some(crate::danmaku::DanmakuSource::Video(
                    crate::danmaku::VideoDanmakuSource {
                        cid,
                        duration_seconds: duration_seconds.max(1),
                        referer: referer.to_string(),
                        cookie: self.auth.cookie().map(str::to_owned),
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
                audio_url: None,
                referer: referer.to_string(),
                is_live: true,
                requires_bilibili_headers: true,
                danmaku_source: Some(crate::danmaku::DanmakuSource::Live(
                    crate::live_danmaku::LiveDanmakuSource {
                        room_id: room_id.to_string(),
                        referer: referer.to_string(),
                        cookie: self.auth.cookie().map(str::to_owned),
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
        if let Some(cookie) = self.auth.cookie() {
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

fn u64_field(value: &Value, name: &str) -> Option<u64> {
    value.get(name)?.as_u64()
}

fn u32_field(value: &Value, name: &str) -> Option<u32> {
    u64_field(value, name).and_then(|value| u32::try_from(value).ok())
}

fn network_error(code: &'static str, context: &str, error: impl std::fmt::Display) -> RelayError {
    RelayError::new(code, format!("{context}: {error}"))
}
