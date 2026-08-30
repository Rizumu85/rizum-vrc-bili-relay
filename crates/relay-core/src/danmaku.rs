use std::collections::{HashMap, VecDeque};
use std::env;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, COOKIE, REFERER};

use crate::live_danmaku::{LiveDanmakuOverlay, LiveDanmakuService, LiveDanmakuSource};
use crate::{
    DanmakuArea, DanmakuFilter, DanmakuFont, DanmakuOutline, DanmakuSettings, DanmakuSize,
    DanmakuSpeed, DanmakuWeight, RelayError,
};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const SEGMENT_SECONDS: u64 = 6 * 60;
const MAX_SEGMENTS: u64 = 720;
const MAX_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 60_000;
const MAX_TEXT_CHARS: usize = 300;
const MAX_ASS_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHED_VIDEOS: usize = 4;
pub(crate) const OUTPUT_WIDTH: u32 = 1280;
pub(crate) const OUTPUT_HEIGHT: u32 = 720;
pub(crate) const OUTPUT_FPS: u32 = 30;
pub(crate) const VIDEO_BITRATE_KBPS: u32 = 3500;
pub(crate) const AUDIO_BITRATE_KBPS: u32 = 160;

#[derive(Debug, Clone)]
pub(crate) struct VideoDanmakuSource {
    pub cid: u64,
    pub duration_seconds: u64,
    pub referer: String,
    pub cookie: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum DanmakuSource {
    Video(VideoDanmakuSource),
    Live(LiveDanmakuSource),
}

impl DanmakuSource {
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Live(_))
    }
}

pub(crate) struct DanmakuOverlay {
    kind: DanmakuOverlayKind,
}

enum DanmakuOverlayKind {
    Video { path: PathBuf, event_count: u64 },
    Live(LiveDanmakuOverlay),
}

impl DanmakuOverlay {
    fn video(path: PathBuf, event_count: u64) -> Self {
        Self {
            kind: DanmakuOverlayKind::Video { path, event_count },
        }
    }

    pub fn ass_path(&self) -> Option<&Path> {
        match &self.kind {
            DanmakuOverlayKind::Video { path, .. } => Some(path),
            DanmakuOverlayKind::Live(_) => None,
        }
    }

    pub fn live_filter_graph(&self) -> Option<&str> {
        match &self.kind {
            DanmakuOverlayKind::Video { .. } => None,
            DanmakuOverlayKind::Live(overlay) => Some(overlay.filter_graph()),
        }
    }

    pub fn start(&mut self) -> Result<(), RelayError> {
        match &mut self.kind {
            DanmakuOverlayKind::Video { .. } => Ok(()),
            DanmakuOverlayKind::Live(overlay) => overlay.start(),
        }
    }

    pub fn event_count(&self) -> u64 {
        match &self.kind {
            DanmakuOverlayKind::Video { event_count, .. } => *event_count,
            DanmakuOverlayKind::Live(overlay) => overlay.rendered_count(),
        }
    }
}

impl Drop for DanmakuOverlay {
    fn drop(&mut self) {
        if let DanmakuOverlayKind::Video { path, .. } = &self.kind {
            let _ = fs::remove_file(path);
        }
    }
}

pub(crate) struct DanmakuService {
    http: Client,
    live: LiveDanmakuService,
    runtime_root: PathBuf,
    next_id: u64,
    video_cache: HashMap<u64, CachedVideoDanmaku>,
    video_cache_order: VecDeque<u64>,
}

struct CachedVideoDanmaku {
    from_seconds: f64,
    segment_count: u64,
    events: Vec<DanmakuEvent>,
}

impl DanmakuService {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(BROWSER_USER_AGENT)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            live: LiveDanmakuService::new(http.clone()),
            http,
            runtime_root: runtime_root(),
            next_id: 1,
            video_cache: HashMap::new(),
            video_cache_order: VecDeque::new(),
        }
    }

    pub fn prepare(
        &mut self,
        source: &DanmakuSource,
        settings: &DanmakuSettings,
        start_seconds: f64,
    ) -> Result<Option<DanmakuOverlay>, RelayError> {
        if !settings.enabled {
            return Ok(None);
        }
        match source {
            DanmakuSource::Video(source) => self.prepare_video(source, settings, start_seconds),
            DanmakuSource::Live(source) => self.live.prepare(source, settings).map(|overlay| {
                Some(DanmakuOverlay {
                    kind: DanmakuOverlayKind::Live(overlay),
                })
            }),
        }
    }

    fn prepare_video(
        &mut self,
        source: &VideoDanmakuSource,
        settings: &DanmakuSettings,
        start_seconds: f64,
    ) -> Result<Option<DanmakuOverlay>, RelayError> {
        let events = self.fetch(source, start_seconds)?;
        if events.is_empty() {
            return Ok(None);
        }
        let (ass, event_count) = render_ass(&events, settings, start_seconds);
        if event_count == 0 {
            return Ok(None);
        }
        if ass.len() > MAX_ASS_BYTES {
            return Err(RelayError::new(
                "danmaku_too_large",
                "Rendered danmaku exceeded the safety limit",
            ));
        }
        fs::create_dir_all(&self.runtime_root).map_err(|error| {
            RelayError::new(
                "danmaku_storage_failed",
                format!("Danmaku runtime directory could not be created: {error}"),
            )
        })?;
        let epoch_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let identifier = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let path = self.runtime_root.join(format!(
            "{epoch_millis:x}-{}-{identifier:x}.ass",
            process::id()
        ));
        let temporary = path.with_extension("ass.tmp");
        let result = (|| {
            let mut file = File::create(&temporary).map_err(|error| {
                RelayError::new(
                    "danmaku_storage_failed",
                    format!("Temporary danmaku file could not be created: {error}"),
                )
            })?;
            file.write_all(&[0xEF, 0xBB, 0xBF])
                .and_then(|()| file.write_all(ass.as_bytes()))
                .and_then(|()| file.sync_all())
                .map_err(|error| {
                    RelayError::new(
                        "danmaku_storage_failed",
                        format!("Danmaku file could not be saved: {error}"),
                    )
                })?;
            fs::rename(&temporary, &path).map_err(|error| {
                RelayError::new(
                    "danmaku_storage_failed",
                    format!("Danmaku file could not be activated: {error}"),
                )
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&path);
        }
        result?;
        Ok(Some(DanmakuOverlay::video(path, event_count)))
    }

    fn fetch(
        &mut self,
        source: &VideoDanmakuSource,
        start_seconds: f64,
    ) -> Result<Vec<DanmakuEvent>, RelayError> {
        let start_seconds = start_seconds.max(0.0);
        let segment_count = source
            .duration_seconds
            .max(1)
            .div_ceil(SEGMENT_SECONDS)
            .clamp(1, MAX_SEGMENTS);
        if let Some(cached) = self.video_cache.get(&source.cid)
            && cached.segment_count == segment_count
            && cached.from_seconds <= start_seconds + 0.001
        {
            return Ok(cached.events.clone());
        }
        let first_segment = ((start_seconds as u64) / SEGMENT_SECONDS + 1).clamp(1, segment_count);
        let mut events = Vec::new();
        for segment in first_segment..=segment_count {
            let endpoint = format!(
                "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={}&segment_index={segment}",
                source.cid
            );
            let mut request = self
                .http
                .get(endpoint)
                .header(ACCEPT, "application/octet-stream")
                .header(REFERER, &source.referer);
            if let Some(cookie) = source.cookie.as_deref() {
                request = request.header(COOKIE, cookie);
            }
            let response = request.send().map_err(|error| {
                RelayError::new(
                    "danmaku_fetch_failed",
                    format!("Danmaku segment {segment} could not be downloaded: {error}"),
                )
            })?;
            if !response.status().is_success() {
                return Err(RelayError::new(
                    "danmaku_fetch_failed",
                    format!(
                        "Danmaku segment {segment} returned HTTP {}",
                        response.status().as_u16()
                    ),
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_SEGMENT_BYTES)
            {
                return Err(RelayError::new(
                    "danmaku_too_large",
                    "Bilibili returned an oversized danmaku segment",
                ));
            }
            let mut payload = Vec::new();
            response
                .take(MAX_SEGMENT_BYTES + 1)
                .read_to_end(&mut payload)
                .map_err(|error| {
                    RelayError::new(
                        "danmaku_fetch_failed",
                        format!("Danmaku segment {segment} could not be read: {error}"),
                    )
                })?;
            if payload.len() as u64 > MAX_SEGMENT_BYTES {
                return Err(RelayError::new(
                    "danmaku_too_large",
                    "Bilibili returned an oversized danmaku segment",
                ));
            }
            for event in parse_segment(&payload)? {
                if event.offset_seconds + 0.001 >= start_seconds {
                    events.push(event);
                    if events.len() >= MAX_EVENTS {
                        break;
                    }
                }
            }
            if events.len() >= MAX_EVENTS {
                break;
            }
        }
        events.sort_by(|left, right| {
            left.offset_seconds
                .total_cmp(&right.offset_seconds)
                .then(left.id.cmp(&right.id))
        });
        if !self.video_cache.contains_key(&source.cid)
            && self.video_cache.len() >= MAX_CACHED_VIDEOS
            && let Some(expired_cid) = self.video_cache_order.pop_front()
        {
            self.video_cache.remove(&expired_cid);
        }
        self.video_cache_order.retain(|cid| *cid != source.cid);
        self.video_cache_order.push_back(source.cid);
        self.video_cache.insert(
            source.cid,
            CachedVideoDanmaku {
                from_seconds: start_seconds,
                segment_count,
                events: events.clone(),
            },
        );
        Ok(events)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum DanmakuKind {
    Rolling,
    Bottom,
    Top,
    Reverse,
    Advanced,
}

#[derive(Clone)]
pub(crate) struct DanmakuEvent {
    pub id: u64,
    pub offset_seconds: f64,
    pub kind: DanmakuKind,
    pub color: u32,
    pub text: String,
}

fn parse_segment(payload: &[u8]) -> Result<Vec<DanmakuEvent>, RelayError> {
    let mut reader = ProtobufReader::new(payload);
    let mut events = Vec::new();
    while let Some((field, wire)) = reader.read_field()? {
        if field == 1 && wire == 2 {
            if let Some(event) = parse_element(reader.read_length_delimited()?)? {
                events.push(event);
            }
        } else {
            reader.skip(wire)?;
        }
    }
    Ok(events)
}

fn parse_element(payload: &[u8]) -> Result<Option<DanmakuEvent>, RelayError> {
    let mut reader = ProtobufReader::new(payload);
    let mut id = 0_u64;
    let mut progress_ms = 0_u64;
    let mut mode = 1_u64;
    let mut color = 0xFF_FFFF_u32;
    let mut pool = 0_u64;
    let mut text = String::new();
    while let Some((field, wire)) = reader.read_field()? {
        match (field, wire) {
            (1, 0) => id = reader.read_varint()?,
            (2, 0) => progress_ms = reader.read_varint()?,
            (3, 0) => mode = reader.read_varint()?,
            (5, 0) => color = (reader.read_varint()? as u32) & 0xFF_FFFF,
            (7, 2) => {
                let value = reader.read_length_delimited()?;
                let decoded = std::str::from_utf8(value).map_err(|_| invalid_protobuf())?;
                text = decoded.trim().chars().take(MAX_TEXT_CHARS).collect();
            }
            (11, 0) => pool = reader.read_varint()?,
            _ => reader.skip(wire)?,
        }
    }
    if text.is_empty() {
        return Ok(None);
    }
    let kind = if pool == 2 || mode >= 7 {
        DanmakuKind::Advanced
    } else {
        match mode {
            4 => DanmakuKind::Bottom,
            5 => DanmakuKind::Top,
            6 => DanmakuKind::Reverse,
            _ => DanmakuKind::Rolling,
        }
    };
    Ok(Some(DanmakuEvent {
        id,
        offset_seconds: progress_ms as f64 / 1000.0,
        kind,
        color,
        text,
    }))
}

struct ProtobufReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> ProtobufReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn read_field(&mut self) -> Result<Option<(u32, u8)>, RelayError> {
        if self.position >= self.bytes.len() {
            return Ok(None);
        }
        let key = self.read_varint()?;
        let field = u32::try_from(key >> 3).map_err(|_| invalid_protobuf())?;
        let wire = u8::try_from(key & 7).map_err(|_| invalid_protobuf())?;
        if field == 0 {
            return Err(invalid_protobuf());
        }
        Ok(Some((field, wire)))
    }

    fn read_varint(&mut self) -> Result<u64, RelayError> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let current = *self.bytes.get(self.position).ok_or_else(invalid_protobuf)?;
            self.position += 1;
            value |= u64::from(current & 0x7F) << shift;
            if current & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(invalid_protobuf())
    }

    fn read_length_delimited(&mut self) -> Result<&'a [u8], RelayError> {
        let length = usize::try_from(self.read_varint()?).map_err(|_| invalid_protobuf())?;
        let end = self
            .position
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(invalid_protobuf)?;
        let value = &self.bytes[self.position..end];
        self.position = end;
        Ok(value)
    }

    fn skip(&mut self, wire: u8) -> Result<(), RelayError> {
        match wire {
            0 => {
                self.read_varint()?;
            }
            1 => self.advance(8)?,
            2 => {
                let length =
                    usize::try_from(self.read_varint()?).map_err(|_| invalid_protobuf())?;
                self.advance(length)?;
            }
            5 => self.advance(4)?,
            _ => return Err(invalid_protobuf()),
        }
        Ok(())
    }

    fn advance(&mut self, count: usize) -> Result<(), RelayError> {
        self.position = self
            .position
            .checked_add(count)
            .filter(|position| *position <= self.bytes.len())
            .ok_or_else(invalid_protobuf)?;
        Ok(())
    }
}

fn invalid_protobuf() -> RelayError {
    RelayError::new(
        "danmaku_invalid_data",
        "Bilibili returned malformed danmaku data",
    )
}

fn render_ass(
    events: &[DanmakuEvent],
    settings: &DanmakuSettings,
    start_seconds: f64,
) -> (String, u64) {
    let font_size = match settings.size {
        DanmakuSize::Small => 28,
        DanmakuSize::Medium => 36,
        DanmakuSize::Large => 44,
    };
    let line_height = (font_size + 8).max((f64::from(font_size) * 1.22).round() as i32);
    let area_ratio = match settings.area {
        DanmakuArea::Quarter => 0.25,
        DanmakuArea::Half => 0.50,
        DanmakuArea::Full => 0.90,
    };
    let lane_count = ((f64::from(OUTPUT_HEIGHT) * area_ratio / f64::from(line_height)).floor()
        as usize)
        .clamp(1, 64);
    let rolling_duration = match settings.speed {
        DanmakuSpeed::Slow => 12.0,
        DanmakuSpeed::Normal => 8.0,
        DanmakuSpeed::Fast => 6.0,
    };
    let opacity = settings.opacity.clamp(20, 100);
    let alpha = ((100 - u32::from(opacity)) * 255 / 100) as u8;
    let mut rolling_lanes = vec![0.0_f64; lane_count];
    let mut top_lanes = vec![0.0_f64; lane_count];
    let mut bottom_lanes = vec![0.0_f64; lane_count];
    let mut output = String::with_capacity(events.len().saturating_mul(120).min(MAX_ASS_BYTES));
    append_header(&mut output, settings, font_size);
    let mut rendered = 0_u64;

    for event in events {
        if event.offset_seconds < start_seconds || should_hide(event, settings) {
            continue;
        }
        let start = event.offset_seconds - start_seconds;
        let duration = if matches!(event.kind, DanmakuKind::Top | DanmakuKind::Bottom) {
            4.0
        } else {
            rolling_duration
        };
        let end = start + duration;
        let lane = match event.kind {
            DanmakuKind::Top => acquire_lane(&mut top_lanes, start, end),
            DanmakuKind::Bottom => acquire_lane(&mut bottom_lanes, start, end),
            _ => acquire_lane(&mut rolling_lanes, start, end),
        };
        let Some(lane) = lane else {
            continue;
        };
        let y = 12 + lane as i32 * line_height;
        let movement = match event.kind {
            DanmakuKind::Top => format!(r"\an8\pos({},{y})", OUTPUT_WIDTH / 2),
            DanmakuKind::Bottom => format!(
                r"\an2\pos({},{})",
                OUTPUT_WIDTH / 2,
                OUTPUT_HEIGHT as i32 - 18 - lane as i32 * line_height
            ),
            DanmakuKind::Reverse => {
                format!(r"\an7\move(-20,{y},{},{y})", OUTPUT_WIDTH + 20)
            }
            _ => format!(r"\an7\move({},{y},-20,{y})", OUTPUT_WIDTH + 20),
        };
        let text = escape_text(&event.text);
        if text.is_empty() {
            continue;
        }
        let _ = writeln!(
            output,
            "Dialogue: 0,{},{},Danmaku,,0,0,0,,{{\\1a&H{alpha:02X}&\\c&H{}&{movement}}}{text}",
            format_time(start),
            format_time(end),
            ass_color(event.color),
        );
        rendered += 1;
        if output.len() > MAX_ASS_BYTES {
            break;
        }
    }
    (output, rendered)
}

fn append_header(output: &mut String, settings: &DanmakuSettings, font_size: i32) {
    let font = match settings.font {
        DanmakuFont::MicrosoftYahei => "Microsoft YaHei",
        DanmakuFont::NotoSansSc => "Noto Sans SC",
        DanmakuFont::SourceHanSans => "Source Han Sans SC",
        DanmakuFont::Simhei => "SimHei",
    };
    let bold = if matches!(settings.weight, DanmakuWeight::Bold) {
        -1
    } else {
        0
    };
    let (outline, shadow) = match settings.outline {
        DanmakuOutline::Heavy => (3, 0),
        DanmakuOutline::Outline => (2, 0),
        DanmakuOutline::Shadow => (1, 3),
    };
    let _ = writeln!(
        output,
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {OUTPUT_WIDTH}\nPlayResY: {OUTPUT_HEIGHT}\nWrapStyle: 2\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Danmaku,{font},{font_size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,{bold},0,0,0,100,100,0,0,1,{outline},{shadow},7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    );
}

pub(crate) fn should_hide(event: &DanmakuEvent, settings: &DanmakuSettings) -> bool {
    if event.color != 0xFF_FFFF && settings.hidden_types.contains(&DanmakuFilter::Colored) {
        return true;
    }
    match event.kind {
        DanmakuKind::Top | DanmakuKind::Bottom => {
            settings.hidden_types.contains(&DanmakuFilter::Fixed)
        }
        DanmakuKind::Advanced => settings.hidden_types.contains(&DanmakuFilter::Advanced),
        _ => settings.hidden_types.contains(&DanmakuFilter::Rolling),
    }
}

pub(crate) fn acquire_lane(lanes: &mut [f64], start: f64, end: f64) -> Option<usize> {
    for (index, available_at) in lanes.iter_mut().enumerate() {
        if *available_at > start {
            continue;
        }
        *available_at = end;
        return Some(index);
    }
    None
}

fn ass_color(rgb: u32) -> String {
    let red = rgb >> 16 & 0xFF;
    let green = rgb >> 8 & 0xFF;
    let blue = rgb & 0xFF;
    format!("{blue:02X}{green:02X}{red:02X}")
}

fn escape_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str(r"\\"),
            '{' => escaped.push('｛'),
            '}' => escaped.push('｝'),
            '\r' => {}
            '\n' => escaped.push_str(r"\N"),
            value if value.is_control() => {}
            value => escaped.push(value),
        }
    }
    escaped
}

fn format_time(seconds: f64) -> String {
    let centiseconds = (seconds.max(0.0) * 100.0).round() as u64;
    let hours = centiseconds / 360_000;
    let minutes = centiseconds / 6_000 % 60;
    let seconds = centiseconds / 100 % 60;
    let fraction = centiseconds % 100;
    format!("{hours}:{minutes:02}:{seconds:02}.{fraction:02}")
}

fn runtime_root() -> PathBuf {
    env::var_os("VRC_BILI_RELAY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .unwrap_or_else(env::temp_dir)
        .join("VRC Bili Relay")
        .join("runtime")
        .join("danmaku")
}
