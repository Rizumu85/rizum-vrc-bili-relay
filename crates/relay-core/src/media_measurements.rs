//! Opt-in observation adapter for the benchmark entry point. No production wire
//! commands and no functional assertions. Uses real private media implementations.
use std::fs::{self, File};
use std::io::Read;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::{Duration, Instant};
use serde_json::{Value, json};
use crate::danmaku::{DanmakuEvent, DanmakuKind, DanmakuOverlay, render_ass};
use crate::ffmpeg::{FfmpegProcess, ProcessPoll};
use crate::{DanmakuFont, DanmakuSettings, DanmakuSpeed, MediaAudio, MediaInput, OutputResolution, PlaybackRate};

pub fn run(args: &[String]) -> Result<Value, String> {
    if args.len() < 2 { return Err("Expected mode and FFmpeg path".into()); }
    match args[0].as_str() {
        "pipeline" if args.len() == 5 => pipeline(&args[1], &args[2], &args[3], &args[4]),
        "render" if args.len() == 5 => render(&args[1], &args[2], &args[3], &args[4]),
        _ => Err("Unknown observation mode/arguments".into()),
    }
}
fn loopback(url: &str, scheme: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.host_str() != Some("127.0.0.1") || parsed.scheme() != scheme {
        return Err("Measurement inputs and output must be loopback only".into());
    }
    Ok(())
}
fn input(url: &str, audio: MediaAudio) -> MediaInput {
    MediaInput { video_url: url.into(), audio, referer: String::new(), is_live: false,
        requires_bilibili_headers: false, danmaku_source: None }
}
fn snapshot(process: &FfmpegProcess, action: &str, started: Instant, outcome: Option<&str>) -> Value {
    json!({"action": action, "elapsed_ms": started.elapsed().as_secs_f64()*1000.0,
        "outcome": outcome, "metrics": process.timeline_metrics().values})
}
fn pump(process: &mut FfmpegProcess, input: &MediaInput, seconds: f64) -> Result<String, String> {
    let end = Instant::now() + Duration::from_secs_f64(seconds);
    let mut state = "starting";
    while Instant::now() < end {
        state = match process.poll(input, None).map_err(|e| format!("{}: {}", e.code, e.message))? {
            ProcessPoll::Alive { stable: true } => "running",
            ProcessPoll::Alive { stable: false } => "starting",
            ProcessPoll::Draining => "draining",
            ProcessPoll::Exited { success, diagnostic, .. } => return Err(format!("exited ({success}): {diagnostic}")),
            ProcessPoll::PauseExpired => "pause_expired",
            ProcessPoll::CompletionExpired => "completion_expired",
        };
        thread::sleep(Duration::from_millis(80));
    }
    Ok(state.into())
}
fn pipeline(ffmpeg: &str, av: &str, silent: &str, ingest: &str) -> Result<Value, String> {
    loopback(av,"http")?; loopback(silent,"http")?; loopback(ingest,"rtmp")?;
    let source = input(av, MediaAudio::Embedded);
    let silent_source = input(silent, MediaAudio::Silence);
    let mut process = FfmpegProcess::spawn(ffmpeg, &source, ingest, "measurement", 0.0, true,
        None, PlaybackRate::Normal, OutputResolution::P720).map_err(|e| e.message)?;
    let mut rows = Vec::new();
    let operation = (|| -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(20) {
            if let ProcessPoll::Alive { stable: true } = process.poll(&source,None).map_err(|e|e.message)? { break; }
            thread::sleep(Duration::from_millis(80));
        }
        rows.push(snapshot(&process,"prepared",started,None));
        let started=Instant::now();
        process.set_paused(false,&source,0.0,None,PlaybackRate::Normal).map_err(|e| e.message)?;
        rows.push(snapshot(&process,"resume",started,None));
        pump(&mut process,&source,1.3)?;
        let started=Instant::now();
        process.set_paused(true,&source,0.0,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        rows.push(snapshot(&process,"pause",started,None));
        pump(&mut process,&source,1.1)?;
        let started=Instant::now();
        process.set_paused(true,&source,0.0,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        rows.push(snapshot(&process,"repeated_pause",started,None));
        let started=Instant::now();
        process.set_paused(false,&source,5.0,None,PlaybackRate::Double).map_err(|e|e.message)?;
        rows.push(snapshot(&process,"resume_double_at_5",started,None));
        pump(&mut process,&source,1.2)?;
        rows.push(snapshot(&process,"double_progress",Instant::now(),None));
        let started=Instant::now();
        process.switch_content(&silent_source,2.0,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        rows.push(snapshot(&process,"switch_video_only",started,None));
        pump(&mut process,&silent_source,1.1)?;
        let previous = process.position_seconds().unwrap_or(2.0);
        let bad = input(&format!("{av}/missing"),MediaAudio::Embedded);
        let started=Instant::now();
        let result=process.switch_content(&bad,0.0,None,PlaybackRate::Normal);
        rows.push(snapshot(&process,"unavailable_source",started,Some(result.as_ref().err().map(|e|e.code).unwrap_or("unexpected_success"))));
        let started=Instant::now();
        process.switch_content(&silent_source,previous,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        rows.push(snapshot(&process,"restore_after_failure",started,None));
        pump(&mut process,&silent_source,0.8)?;
        let started=Instant::now();
        process.switch_content(&silent_source,11.0,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        let state=pump(&mut process,&silent_source,2.8)?;
        rows.push(snapshot(&process,"natural_completion",started,Some(&state)));
        // Finite bytes standing in for a live source: its synthetic audio
        // must not keep the process alive after the real video reaches EOF.
        let mut live_silent = silent_source.clone();
        live_silent.is_live = true;
        let started = Instant::now();
        process.switch_content(&live_silent,0.0,None,PlaybackRate::Normal).map_err(|e|e.message)?;
        let mut outcome = "observation_deadline";
        while started.elapsed() < Duration::from_secs(20) {
            match process.poll(&live_silent,None).map_err(|e|e.message)? {
                ProcessPoll::Exited { success, source_exit, .. } => {
          outcome = if success && source_exit { "source_eof" } else { "unexpected_exit" };
          break;
                }
                _ => thread::sleep(Duration::from_millis(80)),
            }
        }
        rows.push(snapshot(&process,"live_video_only_eof",started,Some(outcome)));
        Ok(())
    })();
    let started=Instant::now(); process.stop();
    rows.push(snapshot(&process,"stop",started,None));
    Ok(json!({"operations": rows, "error": operation.err(),
        "observed_position_clamp": crate::media_session::clamp_position(11.8,Some(12.0)),
        "seek_clamp": crate::media_session::normalize_start(12.0,Some(12.0),false).ok()}))
}
fn render(ffmpeg: &str, directory: &str, mode: &str, height: &str) -> Result<Value,String> {
    let resolution = match height { "720"=>OutputResolution::P720, "1080"=>OutputResolution::P1080, _=>return Err("Unsupported raster".into()) };
    let (width,height)=resolution.dimensions();
    let root=Path::new(directory).join("O'Brien,[notes];");
    fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let raw=root.join(format!("{mode}-{height}.gray"));
    let mut settings=DanmakuSettings::default();
    settings.enabled=true; settings.font=DanmakuFont::NotoSansSc; settings.opacity=100; settings.speed=DanmakuSpeed::Fast;
    let event=DanmakuEvent { id:1,offset_seconds:31.0,kind:DanmakuKind::Bottom,color:0xFFFFFF,
        text:"Clock O'Brien, [x]: 100% 字幕".into() };
    let mut overlay=None;
    let mut graph;
    let mut port=None;
    if mode=="vod" {
        let (ass,count)=render_ass(&[event.clone()],&settings,30.0);
        let path=root.join("captions.ass"); fs::write(&path,ass).map_err(|e|e.to_string())?;
        overlay=Some(DanmakuOverlay::video(path,count));
        graph=crate::ffmpeg::content_video_filter(overlay.as_ref(),PlaybackRate::Normal,resolution);
        graph.push_str(",fps=10");
    } else if mode=="live" {
        let listener=TcpListener::bind("127.0.0.1:0").map_err(|e|e.to_string())?;
        let selected=listener.local_addr().map_err(|e|e.to_string())?.port(); drop(listener);
        port=Some(selected);
        // Deliberately make frame time five seconds ahead of command wall time.
        graph=format!("setpts=PTS+5/TB,{}",crate::live_danmaku_render::filter_graph(selected,&settings));
    } else { return Err("Unsupported render mode".into()); }
    let source=format!("color=black:s={width}x{height}:r=10");
    let mut cmd=Command::new(ffmpeg);
    cmd.args(["-hide_banner","-loglevel","warning","-y"]);
    if mode=="live" {cmd.arg("-re");}
    cmd.args(["-f","lavfi","-i",&source,"-vf",&graph,"-frames:v",if mode=="live" {"65"} else {"35"},
        "-fps_mode","passthrough","-pix_fmt","gray","-f","rawvideo"]).arg(&raw).stdout(Stdio::null()).stderr(Stdio::piped());
    let started=Instant::now(); let child=cmd.spawn().map_err(|e|e.to_string())?;
    let mut acknowledgement=None;
    if let Some(port)=port {
        thread::sleep(Duration::from_millis(700));
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e|e.to_string())?;
        let command=format!("drawtext@dm0 reinit {}",crate::filter_syntax::zmq_argument(
            &crate::live_danmaku_render::reinit_argument(&event,&settings,0)));
        acknowledgement=Some(crate::live_danmaku::send_zmq_command(&runtime,&format!("tcp://127.0.0.1:{port}"),&command,&mut None,&AtomicBool::new(false)));
        // No clear command: observe frame-clock self-expiry, not ACK alone.
    }
    let output=child.wait_with_output().map_err(|e|e.to_string())?;
    let elapsed=started.elapsed().as_secs_f64();
    let stderr=String::from_utf8_lossy(&output.stderr).into_owned();
    let frames=measure_pixels(&raw,width as usize,height as usize).unwrap_or_default();
    let _=fs::remove_file(raw); drop(overlay);
    Ok(json!({"mode":mode,"width":width,"height":height,"wall_seconds":elapsed,"exit_code":output.status.code(),
        "command_accepted":acknowledgement,"stderr":stderr,"frames":frames}))
}
fn measure_pixels(path:&Path,width:usize,height:usize)->Result<Vec<Value>,String> {
    let mut input=File::open(path).map_err(|e|e.to_string())?;
    let mut frame=vec![0_u8;width*height]; let mut rows=Vec::new();
    while input.read_exact(&mut frame).is_ok() {
        let mut count=0_u64; let(mut xmin,mut ymin,mut xmax,mut ymax)=(width,height,0,0);
        for (offset,value) in frame.iter().enumerate() {
            if *value<=32 {continue;}
            let (x,y)=(offset%width,offset/width); count+=1;
            xmin=xmin.min(x);xmax=xmax.max(x);ymin=ymin.min(y);ymax=ymax.max(y);
        }
        rows.push(json!({"frame":rows.len(),"ink_pixels":count,"bbox":if count>0 {Some([xmin,ymin,xmax,ymax])}else{None}}));
    }
    Ok(rows)
}
