use std::io::Read;
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use url::Url;

use crate::{
    MediaFormat, MediaInput, NextStep, RelayError, ResolvedSource, RouteDecision, RouteKind,
    RouteReason, SourceInspection, SourceKind, SourceResolution,
};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const EXPIRING_QUERY_NAMES: &[&str] = &[
    "expire",
    "expires",
    "deadline",
    "token",
    "sign",
    "signature",
    "auth_key",
    "wssecret",
    "wstime",
    "txsecret",
    "txtime",
    "key",
];

pub(crate) fn inspect(url: &Url) -> Option<SourceInspection> {
    let descriptor = MediaDescriptor::from_url(url)?;
    Some(SourceInspection {
        kind: SourceKind::Media,
        source_id: None,
        canonical_url: Some(descriptor.url.to_string()),
        requires_network_resolution: true,
        next_step: NextStep::ProbeMedia,
    })
}

pub(crate) fn resolve(source: &str, ffprobe_path: &str) -> Result<ResolvedSource, RelayError> {
    let url = Url::parse(source.trim()).map_err(|_| {
        RelayError::new(
            "invalid_media_source",
            "Media source is not a valid absolute URL",
        )
    })?;
    let descriptor = MediaDescriptor::from_url(&url).ok_or_else(|| {
        RelayError::new(
            "unsupported_media_source",
            "Only HTTP(S) MP4, HLS, MPEG-TS, and FLV media URLs are supported",
        )
    })?;
    let probe = probe_media(ffprobe_path, &descriptor)?;
    if !probe.is_vrchat_codec_compatible() {
        return Err(RelayError::new(
            "unsupported_video_format",
            format!(
                "Media requires transcoding before VRChat playback (video: {}, audio: {})",
                probe.video_codec,
                probe.audio_codec.as_deref().unwrap_or("none")
            ),
        ));
    }

    let direct = descriptor.is_stable_direct_candidate;
    let reason = if direct {
        RouteReason::DirectCompatible
    } else if descriptor.requires_bilibili_headers {
        RouteReason::RequiresHeaders
    } else if descriptor.has_expiring_query {
        RouteReason::ExpiringUrl
    } else {
        match descriptor.format {
            MediaFormat::Flv => RouteReason::FlvContainer,
            MediaFormat::MpegTs => RouteReason::MpegTsContainer,
            _ => RouteReason::RequiresHeaders,
        }
    };
    let title = descriptor
        .url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
        .filter(|value| !value.is_empty())
        .unwrap_or("媒体链接")
        .to_string();
    let duration_seconds = probe
        .duration_seconds
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| duration.round() as u64);
    let input = (!direct).then(|| MediaInput {
        video_url: descriptor.url.to_string(),
        audio_url: None,
        referer: descriptor.referer.clone(),
        is_live: duration_seconds.is_none(),
        requires_bilibili_headers: descriptor.requires_bilibili_headers,
        danmaku_source: None,
    });

    Ok(ResolvedSource {
        resolution: SourceResolution {
            kind: SourceKind::Media,
            source_id: descriptor.url.host_str().unwrap_or("media").to_string(),
            canonical_url: descriptor.url.to_string(),
            title,
            parts: Vec::new(),
            selected_part: None,
            duration_seconds,
            live_status: None,
            routing: RouteDecision {
                kind: if direct {
                    RouteKind::Direct
                } else {
                    RouteKind::RelayWithFfmpeg
                },
                reason,
                media_format: Some(descriptor.format),
                quality: None,
                estimated_bitrate: probe.bit_rate,
                has_separate_audio: false,
            },
            playback_url: direct.then(|| descriptor.url.to_string()),
            session_id: None,
            session_expires_in_seconds: None,
        },
        input,
    })
}

struct MediaDescriptor {
    url: Url,
    format: MediaFormat,
    referer: String,
    requires_bilibili_headers: bool,
    has_expiring_query: bool,
    is_stable_direct_candidate: bool,
}

impl MediaDescriptor {
    fn from_url(url: &Url) -> Option<Self> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let path = url.path().to_ascii_lowercase();
        let format = if path.ends_with(".m3u8") {
            MediaFormat::Hls
        } else if path.ends_with(".ts") {
            MediaFormat::MpegTs
        } else if path.ends_with(".mp4") {
            MediaFormat::Mp4
        } else if path.ends_with(".flv") {
            MediaFormat::Flv
        } else {
            return None;
        };
        let host = url.host_str()?.to_ascii_lowercase();
        let requires_bilibili_headers = is_bilibili_media_host(&host);
        let has_expiring_query = url.query_pairs().any(|(name, _)| {
            EXPIRING_QUERY_NAMES
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
        });
        let referer = if requires_bilibili_headers {
            "https://www.bilibili.com/".to_string()
        } else {
            format!("{}://{host}/", url.scheme())
        };
        let is_stable_direct_candidate = !requires_bilibili_headers
            && !matches!(format, MediaFormat::Flv)
            && !has_expiring_query
            && is_publicly_reachable_host(url);
        Some(Self {
            url: url.clone(),
            format,
            referer,
            requires_bilibili_headers,
            has_expiring_query,
            is_stable_direct_candidate,
        })
    }
}

struct MediaProbe {
    video_codec: String,
    audio_codec: Option<String>,
    bit_rate: Option<u64>,
    duration_seconds: Option<f64>,
}

impl MediaProbe {
    fn is_vrchat_codec_compatible(&self) -> bool {
        self.video_codec.eq_ignore_ascii_case("h264")
            && self
                .audio_codec
                .as_deref()
                .is_none_or(|codec| codec.eq_ignore_ascii_case("aac"))
    }
}

fn probe_media(path: &str, descriptor: &MediaDescriptor) -> Result<MediaProbe, RelayError> {
    let mut command = Command::new(path);
    command.args([
        "-v",
        "error",
        "-rw_timeout",
        "12000000",
        "-analyzeduration",
        "3000000",
        "-probesize",
        "3000000",
    ]);
    if descriptor.requires_bilibili_headers {
        command.args([
            "-user_agent",
            BROWSER_USER_AGENT,
            "-referer",
            &descriptor.referer,
        ]);
    }
    command.args([
        "-show_entries",
        "format=format_name,bit_rate,duration:stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate",
        "-of",
        "json",
        "-i",
        descriptor.url.as_str(),
    ]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        RelayError::new(
            "ffprobe_start_failed",
            format!("FFprobe could not be started: {error}"),
        )
    })?;
    let stdout = child.stdout.take().map(drain_pipe);
    let stderr = child.stderr.take().map(drain_pipe);
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            RelayError::new(
                "ffprobe_status_failed",
                format!("FFprobe status could not be read: {error}"),
            )
        })? {
            break status;
        }
        if started.elapsed() >= PROBE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RelayError::new(
                "media_probe_timeout",
                "Media analysis timed out",
            ));
        }
        thread::sleep(Duration::from_millis(40));
    };
    let output = stdout
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let _diagnostic = stderr
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if !status.success() {
        return Err(RelayError::new(
            "media_probe_failed",
            "Media URL could not be analyzed or is temporarily unavailable",
        ));
    }
    parse_probe(&output)
}

fn drain_pipe(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

fn parse_probe(bytes: &[u8]) -> Result<MediaProbe, RelayError> {
    let root: Value = serde_json::from_slice(bytes).map_err(|_| {
        RelayError::new(
            "media_probe_failed",
            "FFprobe returned invalid media information",
        )
    })?;
    let streams = root
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| RelayError::new("media_probe_failed", "Media has no readable streams"))?;
    let video = streams
        .iter()
        .find(|stream| string_field(stream, "codec_type").as_deref() == Some("video"))
        .ok_or_else(|| RelayError::new("media_probe_failed", "Media has no video stream"))?;
    let audio = streams
        .iter()
        .find(|stream| string_field(stream, "codec_type").as_deref() == Some("audio"));
    let format = root.get("format");
    Ok(MediaProbe {
        video_codec: string_field(video, "codec_name").unwrap_or_else(|| "unknown".to_string()),
        audio_codec: audio.and_then(|stream| string_field(stream, "codec_name")),
        bit_rate: format
            .and_then(|value| unsigned_field(value, "bit_rate"))
            .or_else(|| unsigned_field(video, "bit_rate")),
        duration_seconds: format.and_then(|value| float_field(value, "duration")),
    })
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    value.get(name)?.as_str().map(str::to_string)
}

fn unsigned_field(value: &Value, name: &str) -> Option<u64> {
    let field = value.get(name)?;
    field
        .as_u64()
        .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
}

fn float_field(value: &Value, name: &str) -> Option<f64> {
    let field = value.get(name)?;
    field
        .as_f64()
        .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
}

fn is_bilibili_media_host(host: &str) -> bool {
    host == "bilivideo.com"
        || host.ends_with(".bilivideo.com")
        || host == "bilibili.com"
        || host.ends_with(".bilibili.com")
}

fn is_publicly_reachable_host(url: &Url) -> bool {
    if url.cannot_be_a_base() || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".local") {
        return false;
    }
    let Ok(address) = host.parse::<IpAddr>() else {
        return true;
    };
    match address {
        IpAddr::V4(address) => {
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified())
        }
        IpAddr::V6(address) => {
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local())
        }
    }
}
