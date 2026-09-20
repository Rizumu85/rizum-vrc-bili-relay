//! Feature-gated local observations, never linked into the shipped worker.
//! Exercises the actual session rollback owners and measures rendered pixels.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use crate::bilibili::BilibiliClient;
use crate::danmaku::{render_ass, DanmakuEvent, DanmakuKind, DanmakuOverlay};
use crate::media_session::MediaSessionStore;
use crate::*;

pub fn run(args: &[String]) -> Result<Value, String> {
    match args.first().map(String::as_str) {
        Some("session") if args.len() == 6 => session(&args[1], &args[2], &args[3], &args[4], &args[5]),
        Some("capture") if args.len() == 3 => capture(&args[1], &args[2]),
        _ => Err("Expected ass-clock session FFmpeg source ingest directory rate, or capture FFmpeg file".into()),
    }
}

fn local(url: &str, scheme: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.host_str() != Some("127.0.0.1") || parsed.scheme() != scheme {
        return Err("Observation endpoints must be loopback only".into());
    }
    Ok(())
}

fn resolved(url: &str) -> ResolvedSource {
    ResolvedSource {
        input: Some(MediaInput { video_url: url.into(), audio: MediaAudio::Embedded,
            referer: String::new(), is_live: false, requires_bilibili_headers: false, danmaku_source: None }),
        resolution: SourceResolution {
            kind: SourceKind::Media, source_id: "local-clock".into(), canonical_url: url.into(),
            title: "Synthetic source-clock marker".into(), parts: vec![], selected_part: None,
            duration_seconds: Some(45), collection: None, live_status: None,
            routing: RouteDecision { kind: RouteKind::RelayWithFfmpeg, reason: RouteReason::RequiresHeaders,
                media_format: Some(MediaFormat::Mp4), quality: None, estimated_bitrate: None, has_separate_audio: false },
            playback_url: None, session_id: None, session_expires_in_seconds: None,
        },
    }
}

fn overlay(path: PathBuf, origin: f64) -> Result<DanmakuOverlay, String> {
    let mut settings = DanmakuSettings::default();
    settings.enabled = true; settings.opacity = 100; settings.font = DanmakuFont::NotoSansSc;
    let event = DanmakuEvent { id: 1, offset_seconds: 31.0, kind: DanmakuKind::Bottom,
        color: 0xFFFFFF, text: "SOURCE CLOCK 31".into() };
    let (ass, count) = render_ass(&[event], &settings, origin);
    fs::write(&path, ass).map_err(|e| e.to_string())?;
    Ok(DanmakuOverlay::video(path, count, origin))
}

fn until(store: &mut MediaSessionStore, id: &str, client: &BilibiliClient, position: f64) -> Result<RelayStatus, String> {
    let start = Instant::now();
    loop {
        let status = store.status(id, client).map_err(|e| format!("{}: {}", e.code, e.message))?;
        if matches!(status.stage, RelayStage::Failed | RelayStage::Stopped | RelayStage::Completed) {
            return Err(format!("Unexpected relay state: {:?}", status.stage));
        }
        if matches!(status.stage, RelayStage::Running) && status.position_seconds.unwrap_or(0.0) >= position { return Ok(status); }
        if start.elapsed() > Duration::from_secs(30) { return Err("Source-clock observation deadline".into()); }
        thread::sleep(Duration::from_millis(50));
    }
}

fn session(ffmpeg: &str, source: &str, ingest: &str, directory: &str, rate: &str) -> Result<Value, String> {
    local(source, "http")?; local(ingest, "rtmp")?;
    let rate = match rate { "1" => PlaybackRate::Normal, "2" => PlaybackRate::Double, "0.5" => PlaybackRate::Half,
        _ => return Err("Unsupported observation rate".into()) };
    let root = Path::new(directory).join("O'Brien,[clock];");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let old_path = root.join("origin-20.ass");
    let old = overlay(old_path.clone(), 20.0)?;
    let mut store = MediaSessionStore::new();
    let id = store.prepare(resolved(source)).session_id.ok_or("Missing source session")?;
    let client = BilibiliClient::new(BilibiliAccessMode::Guest);
    let target = |start| RelayTarget { ingest_server: ingest.trim_end_matches("/measurement").into(),
        stream_key: "measurement".into(), playback_url: "http://127.0.0.1/measurement.flv".into(), start_seconds: start };
    let mut rows = Vec::new();
    let operation = (|| -> Result<(), String> {
        let started = Instant::now();
        let status = store.start(&id, target(20.0), Some(ffmpeg), Some(old), false, rate, OutputResolution::P720).map_err(|e|e.message)?;
        rows.push(json!({"action":"start", "wall_ms":started.elapsed().as_secs_f64()*1000.0,"status":status}));
        let before = until(&mut store, &id, &client, 24.0)?;
        // Deterministic failure of the proposed producer, after the current one
        // has advanced. The production rate owner performs the rollback itself.
        let invalid_path = root.join("invalid-new-overlay.ass");
        fs::write(&invalid_path, "not an ASS document").map_err(|e|e.to_string())?;
        let proposed = DanmakuOverlay::video(invalid_path.clone(), 1, before.position_seconds.unwrap_or(24.0));
        let started = Instant::now();
        let changed = store.set_playback_rate(&id, before.position_seconds.unwrap_or(24.0), Some(proposed), PlaybackRate::ThreeHalves);
        let status = store.status(&id, &client).map_err(|e|e.message)?;
        rows.push(json!({"action":"rate_failure_and_rollback", "wall_ms":started.elapsed().as_secs_f64()*1000.0,
            "returned_error":changed.err().map(|e|e.code),"before":before,"status":status,
            "original_resource_exists":old_path.exists(),"proposed_resource_exists":invalid_path.exists()}));
        let before = until(&mut store, &id, &client, 26.0)?;
        // Exercise the real cross-session failure path, not a direct process
        // switch followed by hand-written recovery in this observation adapter.
        let next = store.prepare(resolved(&format!("{source}/missing"))).session_id.ok_or("Missing proposed session")?;
        let started = Instant::now();
        let changed = store.switch(&id, &next, target(0.0), None, false, rate);
        let status = store.status(&id, &client).map_err(|e|e.message)?;
        rows.push(json!({"action":"retarget_failure_and_rollback", "wall_ms":started.elapsed().as_secs_f64()*1000.0,
            "returned_error":changed.err().map(|e|e.code),"before":before,"status":status,"original_resource_exists":old_path.exists()}));
        let position = status.position_seconds.unwrap_or(26.0);
        let redundant_path = root.join("unused-repeated-resume.ass");
        let redundant = overlay(redundant_path.clone(), position)?;
        let status = store.set_paused(&id, false, position, Some(redundant), rate).map_err(|e|e.message)?;
        rows.push(json!({"action":"repeated_resume", "status":status,"original_resource_exists":old_path.exists(),
            "unused_resource_exists":redundant_path.exists()}));
        rows.push(json!({"action":"after_event", "status":until(&mut store, &id, &client, 40.0)?}));
        Ok(())
    })();
    let stopped = store.stop(&id).map_err(|e|e.message);
    Ok(json!({"rate":rate.factor(),"ass_origin_seconds":20.0,"event_source_seconds":31.0,
        "event_duration_source_seconds":4.0,"operations":rows,"error":operation.err(),
        "stop_error":stopped.err(),"resource_exists_after_stop":old_path.exists()}))
}

// The 320x180 input is centered without upscaling in the production 1280x720
// frame. Its top stripe encodes source time: x=floor(source_seconds*6), width=4.
// Caption timing is read from that same frame, independent of progress logs,
// downstream buffering, mux offsets, or when a command acknowledgement arrived.
fn capture(ffmpeg: &str, path: &str) -> Result<Value, String> {
    let mut child = Command::new(ffmpeg).args(["-hide_banner","-loglevel","warning","-i",path,
        "-vf","fps=10","-pix_fmt","gray","-f","rawvideo","pipe:1"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("Missing decoder stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing decoder stderr")?;
    let reader = thread::spawn(move || { let mut bytes=Vec::new(); let _=stderr.read_to_end(&mut bytes); String::from_utf8_lossy(&bytes).into_owned() });
    let mut frame = vec![0_u8;1280*720]; let mut rows=Vec::new(); let mut frames=0_usize;
    let mut first=None; let mut last=None; let mut visible=0_usize; let mut marker_frames=0_usize;
    while stdout.read_exact(&mut frame).is_ok() {
        let mut xmin=800_usize; let mut xmax=0_usize;
        for y in 279..293 { for x in 480..800 {
            if frame[y*1280+x] > 180 { xmin=xmin.min(x); xmax=xmax.max(x); }
        }}
        let source_time = (xmin<=xmax).then(|| ((xmin+xmax) as f64/2.0-480.0-1.5)/6.0);
        if source_time.is_some() { marker_frames+=1; }
        let mut ink=0_usize;
        for y in 630..718 { for x in 200..1080 { if frame[y*1280+x]>180 {ink+=1;} }}
        if ink>10 {
            visible+=1;
            if let Some(time)=source_time {
                if first.is_none() {first=Some(time);}
                last=Some(time);
            }
            rows.push(json!({"frame":frames,"source_time_from_pixels":source_time,"caption_pixels":ink}));
        }
        frames+=1;
    }
    drop(stdout);
    let status=child.wait().map_err(|e|e.to_string())?;
    let stderr=reader.join().map_err(|_|"Decoder stderr reader failed")?;
    Ok(json!({"decoder_exit":status.code(),"stderr":stderr,"frames":frames,"marker_frames":marker_frames,
        "visible_frames":visible,"first_caption_source_seconds":first,"last_caption_source_seconds":last,
        "marker_quantization_seconds":1.0/6.0,"samples":rows}))
}
