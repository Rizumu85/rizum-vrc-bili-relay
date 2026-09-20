"""One-shot, baseline-checked patch applicator for the isolated repair branch.
Removed from the final release tree; never executed by the application.
"""
from pathlib import Path
import hashlib

EXPECTED = {
    'crates/relay-core/src/danmaku.rs': '4ba54c5501887fdf9a0d084eb714f908a896f660',
    'crates/relay-core/src/ffmpeg.rs': '594ef911cfecb57ddd7fa44eea0499933e37490d',
    'crates/relay-core/src/media_measurements.rs': 'e99c955d392b4883c0226bf49b23fef3c99b1572',
    'crates/relay-core/src/lib.rs': '27ed5b5dac568b9ccf1aa3872a60775be906fce3',
}
files = {}
for name, expected in EXPECTED.items():
    raw = Path(name).read_bytes().replace(b'\r\n', b'\n')
    actual = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if actual != expected:
        raise SystemExit(f'Refusing to patch changed baseline: {name} {actual}')
    files[name] = raw.decode('utf-8')

def replace(name, old, new):
    if files[name].count(old) != 1:
        raise SystemExit(f'Expected exactly one patch context in {name}: {old[:100]!r}')
    files[name] = files[name].replace(old, new, 1)

d = 'crates/relay-core/src/danmaku.rs'
replace(d, '    Video { path: PathBuf, event_count: u64 },', '''    Video {
        path: PathBuf,
        event_count: u64,
        // Immutable origin used by render_ass. Resource reuse must preserve it.
        source_origin_seconds: f64,
    },''')
replace(d, '''impl DanmakuOverlay {
    pub(crate) fn video(path: PathBuf, event_count: u64) -> Self {
        Self {
            kind: DanmakuOverlayKind::Video { path, event_count },
        }
    }

    pub fn ass_path(&self) -> Option<&Path> {
        match &self.kind {
            DanmakuOverlayKind::Video { path, .. } => Some(path),
            DanmakuOverlayKind::Live(_) => None,
        }
    }''', '''/// A subtitle resource bound to one producer's source-clock origin.
/// ASS event time = source time - source_origin_seconds. This binding belongs
/// to the borrowed resource, not to a mutable global offset or a UI command.
pub(crate) struct VideoDanmakuBinding<'a> {
    pub path: &'a Path,
    pub source_origin_seconds: f64,
    pub source_start_seconds: f64,
}

impl VideoDanmakuBinding<'_> {
    pub fn offset_seconds(&self) -> f64 {
        self.source_start_seconds - self.source_origin_seconds
    }
}

impl DanmakuOverlay {
    pub(crate) fn video(path: PathBuf, event_count: u64, source_origin_seconds: f64) -> Self {
        Self {
            kind: DanmakuOverlayKind::Video { path, event_count, source_origin_seconds },
        }
    }

    // Deliberately no unbound ass_path accessor: every consumer must supply
    // its actual producer start, including pause fallback and failed rollback.
    pub fn ass_binding(&self, source_start_seconds: f64) -> Option<VideoDanmakuBinding<'_>> {
        match &self.kind {
            DanmakuOverlayKind::Video { path, source_origin_seconds, .. } => Some(VideoDanmakuBinding {
                path,
                source_origin_seconds: *source_origin_seconds,
                source_start_seconds,
            }),
            DanmakuOverlayKind::Live(_) => None,
        }
    }''')
replace(d, 'Ok(Some(DanmakuOverlay::video(path, event_count)))', 'Ok(Some(DanmakuOverlay::video(path, event_count, start_seconds)))')

f = 'crates/relay-core/src/ffmpeg.rs'
replace(f, 'add_standard_transcode(&mut command, overlay, playback_rate, output_resolution, !input.is_live);', 'add_standard_transcode(&mut command, overlay, playback_rate, output_resolution, !input.is_live, start_seconds);')
replace(f, '''    pad_audio: bool,
) {
    let filter = content_video_filter(overlay, playback_rate, output_resolution);''', '''    pad_audio: bool,
    source_start_seconds: f64,
) {
    let filter = content_video_filter(overlay, playback_rate, output_resolution, source_start_seconds);''')
replace(f, '''    output_resolution: OutputResolution,
) -> String {
    let (width, height) = output_resolution.dimensions();''', '''    output_resolution: OutputResolution,
    source_start_seconds: f64,
) -> String {
    let (width, height) = output_resolution.dimensions();''')
replace(f, '''    if let Some(path) = overlay.and_then(DanmakuOverlay::ass_path) {
        filter.push_str(&format!(",ass=filename={}", graph_path(path)));
        if let Some(fonts) = crate::danmaku_style::font_directory() {
            filter.push_str(&format!(":fontsdir={}", graph_path(&fonts)));
        }
    }''', '''    if let Some(binding) = overlay.and_then(|value| value.ass_binding(source_start_seconds)) {
        // Convert producer-relative frames into this immutable ASS resource's
        // clock only while rasterizing it, then restore the producer clock.
        // Rate scaling remains downstream; audio and the bridge are untouched.
        let offset = binding.offset_seconds();
        filter.push_str(&format!(",setpts=PTS+({offset:.9})/TB,ass=filename={}", graph_path(binding.path)));
        if let Some(fonts) = crate::danmaku_style::font_directory() {
            filter.push_str(&format!(":fontsdir={}", graph_path(&fonts)));
        }
        filter.push_str(",setpts=PTS-STARTPTS");
    }''')
replace(f, '''    ManagedChild::spawn(
        command,
        redactions,
        "ffmpeg_start_failed",
        "FFmpeg media producer",
    )
}''', '''    let producer = ManagedChild::spawn(
        command,
        redactions,
        "ffmpeg_start_failed",
        "FFmpeg media producer",
    )?;
    if let Some(binding) = overlay.and_then(|value| value.ass_binding(start_seconds)) {
        if let Ok(mut health) = producer.health.lock() {
            health.values.insert("ass_origin_seconds".into(), binding.source_origin_seconds);
            health.values.insert("ass_source_start_seconds".into(), binding.source_start_seconds);
            health.values.insert("ass_offset_seconds".into(), binding.offset_seconds());
        }
        producer.record_health("ass_bound");
    }
    Ok(producer)
}''')

m = 'crates/relay-core/src/media_measurements.rs'
replace(m, '''        "render" if args.len() == 5 => render(&args[1], &args[2], &args[3], &args[4]),''', '''        "render" if args.len() == 5 => render(&args[1], &args[2], &args[3], &args[4]),
        "ass-clock" => crate::ass_clock_measurements::run(&args[1..]),''')
replace(m, 'DanmakuOverlay::video(path,count)', 'DanmakuOverlay::video(path,count,30.0)')
replace(m, 'content_video_filter(overlay.as_ref(),PlaybackRate::Normal,resolution)', 'content_video_filter(overlay.as_ref(),PlaybackRate::Normal,resolution,30.0)')
l = 'crates/relay-core/src/lib.rs'
replace(l, '''pub mod media_measurements;
mod filter_syntax;''', '''pub mod media_measurements;
#[cfg(feature = "media-measurements")]
mod ass_clock_measurements;
mod filter_syntax;''')
for name, content in files.items():
    Path(name).write_bytes(content.encode('utf-8'))
print('Applied baseline-checked ASS resource/producer clock binding patch.')
