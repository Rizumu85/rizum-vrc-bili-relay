use std::collections::BTreeMap;
use std::io::{Cursor, ErrorKind, Read};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use brotli::Decompressor;
use flate2::read::ZlibDecoder;
use md5::{Digest, Md5};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, COOKIE, REFERER};
use serde_json::{Value, json};
use tokio::runtime::Builder as RuntimeBuilder;
use tokio::time::timeout;
use tungstenite::http::Uri;
use tungstenite::{ClientRequestBuilder, Error as WebSocketError, Message, client_tls};
use zeromq::{ReqSocket, Socket, SocketRecv, SocketSend};

use crate::danmaku::{DanmakuEvent, DanmakuKind, OUTPUT_HEIGHT, acquire_lane, should_hide};
use crate::{
    DanmakuArea, DanmakuFont, DanmakuOutline, DanmakuSettings, DanmakuSize, DanmakuSpeed,
    DanmakuWeight, RelayError,
};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const PACKET_HEADER_BYTES: usize = 16;
const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACKET_DEPTH: usize = 4;
const EVENT_QUEUE_CAPACITY: usize = 256;
const FILTER_SLOT_COUNT: usize = 24;
const MAX_LIVE_TEXT_CHARS: usize = 200;
const SOCKET_READ_TIMEOUT: Duration = Duration::from_millis(750);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const SOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const ZMQ_COMMAND_TIMEOUT: Duration = Duration::from_millis(900);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const MIXIN_KEY_ORDER: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Debug, Clone)]
pub(crate) struct LiveDanmakuSource {
    pub room_id: String,
    pub referer: String,
}

#[derive(Clone)]
struct GuestIdentity {
    buvid3: String,
    cookie: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct LiveEndpoint {
    websocket_url: String,
    token: String,
    room_id: String,
    buvid3: String,
    cookie: String,
}

pub(crate) struct LiveDanmakuService {
    http: Client,
    identity: Option<GuestIdentity>,
    mixin_key: Option<(String, Instant)>,
}

impl LiveDanmakuService {
    pub fn new(http: Client) -> Self {
        Self {
            http,
            identity: None,
            mixin_key: None,
        }
    }

    pub fn prepare(
        &mut self,
        source: &LiveDanmakuSource,
        settings: &DanmakuSettings,
    ) -> Result<LiveDanmakuOverlay, RelayError> {
        let identity = self.guest_identity()?;
        let endpoint = self.live_endpoint(source, &identity)?;
        LiveDanmakuOverlay::new(endpoint, settings.clone())
    }

    fn guest_identity(&mut self) -> Result<GuestIdentity, RelayError> {
        if let Some(identity) = self
            .identity
            .as_ref()
            .filter(|identity| identity.expires_at > Instant::now())
        {
            return Ok(identity.clone());
        }
        let root = self
            .http
            .get("https://api.bilibili.com/x/frontend/finger/spi")
            .header(ACCEPT, "application/json")
            .header(REFERER, "https://www.bilibili.com/")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| live_error("Cannot establish a Bilibili guest session", error))?
            .json::<Value>()
            .map_err(|error| live_error("Bilibili returned an invalid guest session", error))?;
        let data = api_data(&root, "Bilibili did not return a guest session")?;
        let buvid3 = data
            .get("b_3")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| live_protocol_error("Bilibili did not return a guest identifier"))?
            .to_string();
        let buvid4 = data
            .get("b_4")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let cookie = match buvid4 {
            Some(buvid4) => format!("buvid3={buvid3}; buvid4={buvid4}"),
            None => format!("buvid3={buvid3}"),
        };
        let identity = GuestIdentity {
            buvid3,
            cookie,
            expires_at: Instant::now() + Duration::from_secs(12 * 60 * 60),
        };
        self.identity = Some(identity.clone());
        Ok(identity)
    }

    fn live_endpoint(
        &mut self,
        source: &LiveDanmakuSource,
        identity: &GuestIdentity,
    ) -> Result<LiveEndpoint, RelayError> {
        if let Ok(signed_url) = self.signed_danmaku_url(&source.room_id, &identity.cookie)
            && let Ok(primary) = self.fetch_endpoint_response(&signed_url, source, identity)
            && let Some(endpoint) =
                parse_live_endpoint(&primary, "host_list", &source.room_id, identity)
        {
            return Ok(endpoint);
        }

        let fallback_url = format!(
            "https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id={}&platform=pc&player=web",
            source.room_id
        );
        let fallback = self.fetch_endpoint_response(&fallback_url, source, identity)?;
        parse_live_endpoint(&fallback, "host_server_list", &source.room_id, identity).ok_or_else(
            || live_protocol_error("Bilibili did not return live danmaku connection data"),
        )
    }

    fn fetch_endpoint_response(
        &self,
        url: &str,
        source: &LiveDanmakuSource,
        identity: &GuestIdentity,
    ) -> Result<Value, RelayError> {
        self.http
            .get(url)
            .header(ACCEPT, "application/json")
            .header(REFERER, &source.referer)
            .header(COOKIE, &identity.cookie)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| {
                live_error("Cannot read Bilibili live danmaku connection data", error)
            })?
            .json::<Value>()
            .map_err(|error| {
                live_error(
                    "Bilibili returned invalid live danmaku connection data",
                    error,
                )
            })
    }

    fn signed_danmaku_url(&mut self, room_id: &str, cookie: &str) -> Result<String, RelayError> {
        let mixin_key = self.mixin_key(cookie)?;
        let mut parameters = BTreeMap::from([
            ("id".to_string(), room_id.to_string()),
            ("type".to_string(), "0".to_string()),
            ("web_location".to_string(), "444.8".to_string()),
        ]);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        parameters.insert("wts".to_string(), timestamp.to_string());
        let query = parameters
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    encode_query(key),
                    encode_query(&sanitize_wbi(value))
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let digest = Md5::digest(format!("{query}{mixin_key}").as_bytes());
        let digest = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(format!(
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?{query}&w_rid={digest}"
        ))
    }

    fn mixin_key(&mut self, cookie: &str) -> Result<String, RelayError> {
        if let Some((key, _)) = self
            .mixin_key
            .as_ref()
            .filter(|(_, expires_at)| *expires_at > Instant::now())
        {
            return Ok(key.clone());
        }
        let root = self
            .http
            .get("https://api.bilibili.com/x/web-interface/nav")
            .header(ACCEPT, "application/json")
            .header(REFERER, "https://www.bilibili.com/")
            .header(COOKIE, cookie)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| live_error("Cannot obtain the Bilibili request signature", error))?
            .json::<Value>()
            .map_err(|error| live_error("Bilibili returned an invalid request signature", error))?;
        let data = api_data(&root, "Bilibili did not return request signature data")?;
        let wbi = data
            .get("wbi_img")
            .ok_or_else(|| live_protocol_error("Bilibili did not return Wbi image data"))?;
        let image_key = wbi
            .get("img_url")
            .and_then(Value::as_str)
            .and_then(url_file_stem)
            .ok_or_else(|| live_protocol_error("Bilibili returned an invalid Wbi image URL"))?;
        let sub_key = wbi
            .get("sub_url")
            .and_then(Value::as_str)
            .and_then(url_file_stem)
            .ok_or_else(|| live_protocol_error("Bilibili returned an invalid Wbi sub-image URL"))?;
        let source = format!("{image_key}{sub_key}");
        if source.len() < 64 || !source.is_ascii() {
            return Err(live_protocol_error("Bilibili returned an invalid Wbi key"));
        }
        let bytes = source.as_bytes();
        let key = MIXIN_KEY_ORDER
            .iter()
            .take(32)
            .map(|index| char::from(bytes[*index]))
            .collect::<String>();
        self.mixin_key = Some((
            key.clone(),
            Instant::now() + Duration::from_secs(6 * 60 * 60),
        ));
        Ok(key)
    }
}

pub(crate) struct LiveDanmakuOverlay {
    endpoint: LiveEndpoint,
    settings: DanmakuSettings,
    port: u16,
    filter_graph: String,
    cancel: Arc<AtomicBool>,
    rendered: Arc<AtomicU64>,
    socket_interrupt: Arc<Mutex<Option<TcpStream>>>,
    started: bool,
    threads: Vec<JoinHandle<()>>,
}

impl LiveDanmakuOverlay {
    fn new(endpoint: LiveEndpoint, settings: DanmakuSettings) -> Result<Self, RelayError> {
        let port = available_loopback_port()?;
        let filter_graph = live_filter_graph(port, &settings);
        Ok(Self {
            endpoint,
            settings,
            port,
            filter_graph,
            cancel: Arc::new(AtomicBool::new(false)),
            rendered: Arc::new(AtomicU64::new(0)),
            socket_interrupt: Arc::new(Mutex::new(None)),
            started: false,
            threads: Vec::new(),
        })
    }

    pub fn filter_graph(&self) -> &str {
        &self.filter_graph
    }

    pub fn rendered_count(&self) -> u64 {
        self.rendered.load(Ordering::Acquire)
    }

    pub fn start(&mut self) -> Result<(), RelayError> {
        if self.started {
            return Ok(());
        }
        self.cancel.store(false, Ordering::Release);
        let (sender, receiver) = sync_channel(EVENT_QUEUE_CAPACITY);
        let receiver_endpoint = self.endpoint.clone();
        let receiver_settings = self.settings.clone();
        let receiver_cancel = Arc::clone(&self.cancel);
        let socket_interrupt = Arc::clone(&self.socket_interrupt);
        let receiver_thread = thread::Builder::new()
            .name("live-danmaku-receiver".to_string())
            .spawn(move || {
                receive_loop(
                    receiver_endpoint,
                    receiver_settings,
                    sender,
                    receiver_cancel,
                    socket_interrupt,
                );
            })
            .map_err(|error| {
                RelayError::new(
                    "live_danmaku_start_failed",
                    format!("Live danmaku receiver could not start: {error}"),
                )
            })?;

        let render_settings = self.settings.clone();
        let render_cancel = Arc::clone(&self.cancel);
        let rendered = Arc::clone(&self.rendered);
        let port = self.port;
        let render_thread = match thread::Builder::new()
            .name("live-danmaku-renderer".to_string())
            .spawn(move || render_loop(receiver, port, render_settings, render_cancel, rendered))
        {
            Ok(thread) => thread,
            Err(error) => {
                self.cancel.store(true, Ordering::Release);
                let _ = receiver_thread.join();
                return Err(RelayError::new(
                    "live_danmaku_start_failed",
                    format!("Live danmaku renderer could not start: {error}"),
                ));
            }
        };
        self.threads.push(receiver_thread);
        self.threads.push(render_thread);
        self.started = true;
        Ok(())
    }
}

impl Drop for LiveDanmakuOverlay {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(stream) = self
            .socket_interrupt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = stream.shutdown(Shutdown::Both);
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn receive_loop(
    endpoint: LiveEndpoint,
    settings: DanmakuSettings,
    sender: SyncSender<DanmakuEvent>,
    cancel: Arc<AtomicBool>,
    socket_interrupt: Arc<Mutex<Option<TcpStream>>>,
) {
    let mut retry_delay = Duration::from_secs(1);
    while !cancel.load(Ordering::Acquire) {
        let result = receive_connection(&endpoint, &settings, &sender, &cancel, &socket_interrupt);
        socket_interrupt
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        match result {
            Ok(()) if cancel.load(Ordering::Acquire) => break,
            Ok(()) | Err(_) => {
                sleep_cancelled(retry_delay, &cancel);
                retry_delay = (retry_delay * 2).min(Duration::from_secs(15));
            }
        }
    }
}

fn receive_connection(
    endpoint: &LiveEndpoint,
    settings: &DanmakuSettings,
    sender: &SyncSender<DanmakuEvent>,
    cancel: &AtomicBool,
    socket_interrupt: &Mutex<Option<TcpStream>>,
) -> Result<(), String> {
    let mut socket = connect_websocket(endpoint, cancel, socket_interrupt)?;
    let auth = json!({
        "uid": 0,
        "roomid": endpoint.room_id.parse::<u64>().unwrap_or_default(),
        "protover": 3,
        "buvid": endpoint.buvid3,
        "platform": "web",
        "type": 2,
        "key": endpoint.token,
    });
    socket
        .send(Message::Binary(
            build_packet(7, 1, auth.to_string().as_bytes()).into(),
        ))
        .map_err(|error| format!("Cannot authenticate live danmaku websocket: {error}"))?;
    let mut heartbeat_at = Instant::now() + HEARTBEAT_INTERVAL;
    let mut event_id = 1_u64;
    while !cancel.load(Ordering::Acquire) {
        match socket.read() {
            Ok(Message::Binary(payload)) => {
                let mut events = Vec::new();
                parse_packet_sequence(&payload, &mut events, 0)?;
                for mut event in events {
                    event.id = event_id;
                    event_id = event_id.wrapping_add(1).max(1);
                    if should_hide(&event, settings) {
                        continue;
                    }
                    match sender.try_send(event) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Disconnected(_)) => return Ok(()),
                    }
                }
            }
            Ok(Message::Close(_)) => return Err("Live danmaku websocket closed".to_string()),
            Ok(Message::Ping(_)) => {
                let _ = socket.flush();
            }
            Ok(_) => {}
            Err(WebSocketError::Io(error))
                if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => {
                return Err("Live danmaku websocket disconnected".to_string());
            }
            Err(error) => return Err(format!("Cannot read live danmaku websocket: {error}")),
        }
        if Instant::now() >= heartbeat_at {
            socket
                .send(Message::Binary(
                    build_packet(2, 1, b"[object Object]").into(),
                ))
                .map_err(|error| format!("Cannot send live danmaku heartbeat: {error}"))?;
            heartbeat_at = Instant::now() + HEARTBEAT_INTERVAL;
        }
    }
    let _ = socket.close(None);
    Ok(())
}

fn connect_websocket(
    endpoint: &LiveEndpoint,
    cancel: &AtomicBool,
    socket_interrupt: &Mutex<Option<TcpStream>>,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>, String> {
    let uri = endpoint
        .websocket_url
        .parse::<Uri>()
        .map_err(|error| format!("Invalid live danmaku websocket URL: {error}"))?;
    let host = uri
        .host()
        .ok_or_else(|| "Live danmaku websocket URL has no host".to_string())?;
    let port = uri.port_u16().unwrap_or(443);
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Cannot resolve live danmaku host: {error}"))?;
    let mut last_error = None;
    for address in addresses.take(4) {
        if cancel.load(Ordering::Acquire) {
            return Err("Live danmaku connection was cancelled".to_string());
        }
        match TcpStream::connect_timeout(&address, SOCKET_CONNECT_TIMEOUT) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(SOCKET_READ_TIMEOUT))
                    .map_err(|error| format!("Cannot set websocket read timeout: {error}"))?;
                stream
                    .set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))
                    .map_err(|error| format!("Cannot set websocket write timeout: {error}"))?;
                let interrupt = stream
                    .try_clone()
                    .map_err(|error| format!("Cannot prepare websocket cancellation: {error}"))?;
                *socket_interrupt
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(interrupt);
                let request = ClientRequestBuilder::new(uri.clone())
                    .with_header("Origin", "https://live.bilibili.com")
                    .with_header("User-Agent", BROWSER_USER_AGENT)
                    .with_header("Cookie", &endpoint.cookie);
                return client_tls(request, stream)
                    .map(|(socket, _)| socket)
                    .map_err(|error| format!("Cannot connect live danmaku websocket: {error}"));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "Cannot connect live danmaku host: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no address was available".to_string())
    ))
}

fn render_loop(
    receiver: Receiver<DanmakuEvent>,
    port: u16,
    settings: DanmakuSettings,
    cancel: Arc<AtomicBool>,
    rendered: Arc<AtomicU64>,
) {
    let Ok(runtime) = RuntimeBuilder::new_current_thread().enable_all().build() else {
        return;
    };
    let font_size = font_size(settings.size);
    let line_height = ((f64::from(font_size) * 1.22).round() as i32).max(font_size + 8);
    let area_ratio = match settings.area {
        DanmakuArea::Quarter => 0.25,
        DanmakuArea::Half => 0.50,
        DanmakuArea::Full => 0.90,
    };
    let lane_count = ((f64::from(OUTPUT_HEIGHT) * area_ratio / f64::from(line_height)).floor()
        as usize)
        .clamp(1, 64);
    let mut rolling_lanes = vec![0.0_f64; lane_count];
    let mut top_lanes = vec![0.0_f64; lane_count];
    let mut bottom_lanes = vec![0.0_f64; lane_count];
    let mut slots = vec![0.0_f64; FILTER_SLOT_COUNT];
    let mut active_slots = [false; FILTER_SLOT_COUNT];
    let started_at = Instant::now();
    let endpoint = format!("tcp://127.0.0.1:{port}");
    let mut socket = None;
    while !cancel.load(Ordering::Acquire) {
        clear_expired_slots(
            &runtime,
            &endpoint,
            &mut socket,
            &cancel,
            &slots,
            &mut active_slots,
            started_at.elapsed().as_secs_f64() + 0.10,
        );
        let event = match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let now = started_at.elapsed().as_secs_f64() + 0.10;
        let duration = event_duration(event.kind, settings.speed);
        let lanes = match event.kind {
            DanmakuKind::Top => &mut top_lanes,
            DanmakuKind::Bottom => &mut bottom_lanes,
            _ => &mut rolling_lanes,
        };
        let Some(lane) = acquire_lane(lanes, now, now + duration) else {
            continue;
        };
        let Some(slot) = acquire_lane(&mut slots, now, now + duration) else {
            lanes[lane] = now;
            continue;
        };
        let command = format!(
            "drawtext@dm{slot} reinit {}",
            reinit_argument(&event, &settings, lane, now)
        );
        if send_zmq_command(&runtime, &endpoint, &command, &mut socket, &cancel) {
            active_slots[slot] = true;
            rendered.fetch_add(1, Ordering::AcqRel);
        } else {
            slots[slot] = now;
            active_slots[slot] = false;
            lanes[lane] = now;
        }
    }
}

fn clear_expired_slots(
    runtime: &tokio::runtime::Runtime,
    endpoint: &str,
    socket: &mut Option<ReqSocket>,
    cancel: &AtomicBool,
    slots: &[f64],
    active_slots: &mut [bool; FILTER_SLOT_COUNT],
    now: f64,
) {
    for (slot, active) in active_slots.iter_mut().enumerate() {
        if !*active || slots[slot] > now {
            continue;
        }
        let command = format!("drawtext@dm{slot} reinit text=''");
        let _ = send_zmq_command(runtime, endpoint, &command, socket, cancel);
        *active = false;
    }
}

fn send_zmq_command(
    runtime: &tokio::runtime::Runtime,
    endpoint: &str,
    command: &str,
    socket: &mut Option<ReqSocket>,
    cancel: &AtomicBool,
) -> bool {
    for _ in 0..2 {
        if cancel.load(Ordering::Acquire) {
            return false;
        }
        if socket.is_none() {
            let mut candidate = ReqSocket::new();
            let connected = runtime
                .block_on(async { timeout(ZMQ_COMMAND_TIMEOUT, candidate.connect(endpoint)).await })
                .is_ok_and(|result| result.is_ok());
            if !connected {
                sleep_cancelled(Duration::from_millis(150), cancel);
                continue;
            }
            *socket = Some(candidate);
        }
        let exchange = runtime.block_on(async {
            timeout(ZMQ_COMMAND_TIMEOUT, async {
                let active = socket.as_mut().expect("ZMQ socket was initialized");
                active.send(command.into()).await?;
                active.recv().await
            })
            .await
        });
        let accepted = exchange
            .ok()
            .and_then(Result::ok)
            .and_then(|message| String::try_from(message).ok())
            .is_some_and(|response| response.starts_with("0 "));
        if accepted {
            return true;
        }
        *socket = None;
        sleep_cancelled(Duration::from_millis(150), cancel);
    }
    false
}

fn parse_packet_sequence(
    payload: &[u8],
    output: &mut Vec<DanmakuEvent>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_PACKET_DEPTH {
        return Err("Live danmaku packet nesting exceeded the safety limit".to_string());
    }
    let mut offset = 0_usize;
    while offset.saturating_add(PACKET_HEADER_BYTES) <= payload.len() {
        let packet_length = read_u32(payload, offset)? as usize;
        let header_length = usize::from(read_u16(payload, offset + 4)?);
        let protocol_version = read_u16(payload, offset + 6)?;
        let operation = read_u32(payload, offset + 8)?;
        let packet_end = offset
            .checked_add(packet_length)
            .filter(|end| *end <= payload.len())
            .ok_or_else(|| "Live danmaku packet length is invalid".to_string())?;
        if packet_length > MAX_PACKET_BYTES
            || header_length < PACKET_HEADER_BYTES
            || header_length > packet_length
        {
            return Err("Live danmaku packet exceeded the safety limit".to_string());
        }
        let body = &payload[offset + header_length..packet_end];
        if operation == 5 {
            match protocol_version {
                2 => {
                    let decompressed = decompress_zlib(body)?;
                    parse_packet_sequence(&decompressed, output, depth + 1)?;
                }
                3 => {
                    let decompressed = decompress_brotli(body)?;
                    parse_packet_sequence(&decompressed, output, depth + 1)?;
                }
                _ => {
                    if let Some(event) = parse_command(trim_trailing_zero(body)) {
                        output.push(event);
                    }
                }
            }
        }
        offset = packet_end;
    }
    Ok(())
}

fn parse_command(payload: &[u8]) -> Option<DanmakuEvent> {
    let root = serde_json::from_slice::<Value>(payload).ok()?;
    let command = root.get("cmd")?.as_str()?;
    if !command.starts_with("DANMU_MSG") {
        return None;
    }
    let info = root.get("info")?.as_array()?;
    let metadata = info.first()?.as_array()?;
    let text = info
        .get(1)?
        .as_str()?
        .trim()
        .chars()
        .take(MAX_LIVE_TEXT_CHARS)
        .collect::<String>();
    if text.is_empty() {
        return None;
    }
    let mode = metadata.get(1).and_then(Value::as_u64).unwrap_or(1);
    let color = metadata.get(3).and_then(Value::as_u64).unwrap_or(0xFF_FFFF) as u32 & 0xFF_FFFF;
    let pool = metadata.get(11).and_then(Value::as_u64).unwrap_or(0);
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
    Some(DanmakuEvent {
        id: 0,
        offset_seconds: 0.0,
        kind,
        color,
        text,
    })
}

fn build_packet(operation: u32, protocol_version: u16, body: &[u8]) -> Vec<u8> {
    let packet_length = PACKET_HEADER_BYTES.saturating_add(body.len());
    let mut packet = Vec::with_capacity(packet_length);
    packet.extend_from_slice(&(packet_length as u32).to_be_bytes());
    packet.extend_from_slice(&(PACKET_HEADER_BYTES as u16).to_be_bytes());
    packet.extend_from_slice(&protocol_version.to_be_bytes());
    packet.extend_from_slice(&operation.to_be_bytes());
    packet.extend_from_slice(&1_u32.to_be_bytes());
    packet.extend_from_slice(body);
    packet
}

fn decompress_zlib(payload: &[u8]) -> Result<Vec<u8>, String> {
    read_decompressed(ZlibDecoder::new(Cursor::new(payload)))
}

fn decompress_brotli(payload: &[u8]) -> Result<Vec<u8>, String> {
    read_decompressed(Decompressor::new(Cursor::new(payload), 32 * 1024))
}

fn read_decompressed(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    reader
        .take((MAX_PACKET_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|error| format!("Cannot decompress live danmaku packet: {error}"))?;
    if output.len() > MAX_PACKET_BYTES {
        return Err("Decompressed live danmaku packet exceeded the safety limit".to_string());
    }
    Ok(output)
}

fn read_u16(payload: &[u8], offset: usize) -> Result<u16, String> {
    let bytes = payload
        .get(offset..offset + 2)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| "Live danmaku packet header is incomplete".to_string())?;
    Ok(u16::from_be_bytes(bytes))
}

fn read_u32(payload: &[u8], offset: usize) -> Result<u32, String> {
    let bytes = payload
        .get(offset..offset + 4)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| "Live danmaku packet header is incomplete".to_string())?;
    Ok(u32::from_be_bytes(bytes))
}

fn live_filter_graph(port: u16, settings: &DanmakuSettings) -> String {
    let font_file = filter_font_file(settings.font, settings.weight);
    let font_size = font_size(settings.size);
    let opacity = f64::from(settings.opacity.clamp(20, 100)) / 100.0;
    let (border_width, shadow_x, shadow_y) = outline(settings.outline);
    let mut filters = Vec::with_capacity(FILTER_SLOT_COUNT + 1);
    filters.push(format!(r"zmq=b=tcp\\://127.0.0.1\\:{port}"));
    for index in 0..FILTER_SLOT_COUNT {
        filters.push(format!(
            "drawtext@dm{index}=fontfile='{font_file}':text=:expansion=none:fontsize={font_size}:\
             fontcolor=white@{opacity:.2}:borderw={border_width}:bordercolor=0x101010:\
             shadowx={shadow_x}:shadowy={shadow_y}:x=0:y=0"
        ));
    }
    filters.join(",")
}

fn reinit_argument(
    event: &DanmakuEvent,
    settings: &DanmakuSettings,
    lane: usize,
    start_seconds: f64,
) -> String {
    let size = font_size(settings.size);
    let line_height = ((f64::from(size) * 1.22).round() as i32).max(size + 8);
    let duration = event_duration(event.kind, settings.speed);
    let y = match event.kind {
        DanmakuKind::Bottom => OUTPUT_HEIGHT as i32 - 18 - lane as i32 * line_height,
        _ => 12 + lane as i32 * line_height,
    };
    let x = match event.kind {
        DanmakuKind::Top | DanmakuKind::Bottom => "(w-text_w)/2".to_string(),
        DanmakuKind::Reverse => format!("-text_w+(w+text_w)*(t-{start_seconds:.3})/{duration:.3}"),
        _ => format!("w-(w+text_w)*(t-{start_seconds:.3})/{duration:.3}"),
    };
    let opacity = f64::from(settings.opacity.clamp(20, 100)) / 100.0;
    let (border_width, shadow_x, shadow_y) = outline(settings.outline);
    format!(
        "text='{}':fontsize={size}:fontcolor=0x{:06X}@{opacity:.2}:\
         borderw={border_width}:bordercolor=0x101010:shadowx={shadow_x}:shadowy={shadow_y}:\
         x={x}:y={y}",
        escape_drawtext(&event.text),
        event.color,
    )
}

fn event_duration(kind: DanmakuKind, speed: DanmakuSpeed) -> f64 {
    if matches!(kind, DanmakuKind::Top | DanmakuKind::Bottom) {
        return 4.0;
    }
    match speed {
        DanmakuSpeed::Slow => 12.0,
        DanmakuSpeed::Normal => 8.0,
        DanmakuSpeed::Fast => 6.0,
    }
}

fn font_size(size: DanmakuSize) -> i32 {
    match size {
        DanmakuSize::Small => 28,
        DanmakuSize::Medium => 36,
        DanmakuSize::Large => 44,
    }
}

fn outline(outline: DanmakuOutline) -> (u8, u8, u8) {
    match outline {
        DanmakuOutline::Heavy => (3, 0, 0),
        DanmakuOutline::Outline => (2, 0, 0),
        DanmakuOutline::Shadow => (1, 3, 3),
    }
}

fn filter_font_file(font: DanmakuFont, weight: DanmakuWeight) -> String {
    let windows = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let requested = match font {
        DanmakuFont::MicrosoftYahei if matches!(weight, DanmakuWeight::Bold) => "msyhbd.ttc",
        DanmakuFont::MicrosoftYahei => "msyh.ttc",
        DanmakuFont::NotoSansSc => "NotoSansSC-VF.ttf",
        DanmakuFont::SourceHanSans => "SourceHanSansSC-Regular.otf",
        DanmakuFont::Simhei => "simhei.ttf",
    };
    let requested = windows.join("Fonts").join(requested);
    let fallback = windows
        .join("Fonts")
        .join(if matches!(weight, DanmakuWeight::Bold) {
            "msyhbd.ttc"
        } else {
            "msyh.ttc"
        });
    escape_filter_path(if requested.is_file() {
        &requested
    } else {
        &fallback
    })
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', r"\:")
        .replace('\'', r"\'")
        .replace('[', r"\[")
        .replace(']', r"\]")
        .replace(',', r"\,")
}

fn escape_drawtext(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .take(MAX_LIVE_TEXT_CHARS)
        .collect::<String>()
        .replace('\\', r"\\")
        .replace('\'', r"\'")
        .replace(':', r"\:")
}

fn available_loopback_port() -> Result<u16, RelayError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        RelayError::new(
            "live_danmaku_start_failed",
            format!("No local port is available for live danmaku: {error}"),
        )
    })?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| {
            RelayError::new(
                "live_danmaku_start_failed",
                format!("Live danmaku port could not be read: {error}"),
            )
        })
}

fn parse_live_endpoint(
    root: &Value,
    host_field: &str,
    room_id: &str,
    identity: &GuestIdentity,
) -> Option<LiveEndpoint> {
    if root.get("code")?.as_i64()? != 0 {
        return None;
    }
    let data = root.get("data")?;
    let token = data
        .get("token")?
        .as_str()
        .filter(|value| !value.trim().is_empty())?;
    let host = data
        .get(host_field)
        .and_then(Value::as_array)
        .and_then(|hosts| {
            hosts.iter().find_map(|host| {
                let name = host.get("host")?.as_str()?;
                let port = host.get("wss_port").and_then(Value::as_u64).unwrap_or(443);
                Some(format!("wss://{name}:{port}/sub"))
            })
        })
        .unwrap_or_else(|| "wss://broadcastlv.chat.bilibili.com:443/sub".to_string());
    Some(LiveEndpoint {
        websocket_url: host,
        token: token.to_string(),
        room_id: room_id.to_string(),
        buvid3: identity.buvid3.clone(),
        cookie: identity.cookie.clone(),
    })
}

fn api_data<'a>(root: &'a Value, message: &'static str) -> Result<&'a Value, RelayError> {
    if root.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(live_protocol_error(message));
    }
    root.get("data").ok_or_else(|| live_protocol_error(message))
}

fn url_file_stem(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let file = url.path_segments()?.next_back()?;
    file.rsplit_once('.').map(|(stem, _)| stem.to_string())
}

fn sanitize_wbi(value: &str) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, '!' | '\'' | '(' | ')' | '*'))
        .collect()
}

fn encode_query(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn trim_trailing_zero(mut value: &[u8]) -> &[u8] {
    while value.last() == Some(&0) {
        value = &value[..value.len() - 1];
    }
    value
}

fn sleep_cancelled(duration: Duration, cancel: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while !cancel.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn live_protocol_error(message: impl Into<String>) -> RelayError {
    RelayError::new("live_danmaku_unavailable", message)
}

fn live_error(message: &'static str, error: impl std::fmt::Display) -> RelayError {
    RelayError::new("live_danmaku_unavailable", format!("{message}: {error}"))
}
