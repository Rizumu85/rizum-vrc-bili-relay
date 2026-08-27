use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::{Duration, Instant};

use qrcode::QrCode;
use qrcode::types::Color;
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, COOKIE, REFERER, SET_COOKIE, USER_AGENT};
use serde_json::Value;
use url::Url;

use crate::{BilibiliAuthStage, BilibiliAuthStatus, BilibiliLoginQr, RelayError};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const LOGIN_PAGE: &str = "https://passport.bilibili.com/login";
const QR_GENERATE_ENDPOINT: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_ENDPOINT: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const NAV_ENDPOINT: &str = "https://api.bilibili.com/x/web-interface/nav";
const QR_LIFETIME: Duration = Duration::from_secs(180);
const MAX_COOKIE_BYTES: usize = 32 * 1024;
const COOKIE_NAMES: [&str; 11] = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
    "buvid_fp",
    "CURRENT_FNVAL",
    "CURRENT_QUALITY",
];

pub(crate) struct BilibiliAuthService {
    http: Client,
    credentials: Option<Credentials>,
    pending: Option<PendingLogin>,
    next_login_id: u64,
}

struct Credentials {
    cookie: String,
    display_name: String,
    user_id: u64,
}

struct PendingLogin {
    id: u64,
    key: String,
    expires_at: Instant,
    stage: BilibiliAuthStage,
}

impl BilibiliAuthService {
    pub fn new(http: Client) -> Self {
        Self {
            http,
            credentials: None,
            pending: None,
            next_login_id: 1,
        }
    }

    pub fn cookie(&self) -> Option<&str> {
        self.credentials.as_ref().map(|value| value.cookie.as_str())
    }

    pub fn status(&self) -> BilibiliAuthStatus {
        if let Some(credentials) = &self.credentials {
            return BilibiliAuthStatus {
                stage: BilibiliAuthStage::Authenticated,
                login_id: None,
                display_name: Some(credentials.display_name.clone()),
                user_id: Some(credentials.user_id),
                expires_in_seconds: None,
                qr: None,
            };
        }
        if let Some(pending) = &self.pending {
            return pending_status(pending, None);
        }
        guest_status(BilibiliAuthStage::Guest)
    }

    pub fn begin(&mut self) -> Result<BilibiliAuthStatus, RelayError> {
        let root = self
            .request(QR_GENERATE_ENDPOINT)
            .send()
            .and_then(Response::error_for_status)
            .map_err(|error| auth_error("Cannot create a Bilibili login code", error))?
            .json::<Value>()
            .map_err(|error| auth_error("Bilibili returned an invalid login code", error))?;
        let data = api_data(&root, "Bilibili did not return a login code")?;
        let url = required_string(data, "url", "Bilibili did not return a login URL")?;
        let key = required_string(
            data,
            "qrcode_key",
            "Bilibili did not return a login session key",
        )?;
        let qr = render_qr(&url)?;
        let id = self.next_login_id;
        self.next_login_id = self.next_login_id.wrapping_add(1).max(1);
        self.credentials = None;
        self.pending = Some(PendingLogin {
            id,
            key,
            expires_at: Instant::now() + QR_LIFETIME,
            stage: BilibiliAuthStage::Waiting,
        });
        Ok(pending_status(
            self.pending.as_ref().expect("login session was stored"),
            Some(qr),
        ))
    }

    pub fn poll(&mut self, login_id: u64) -> Result<BilibiliAuthStatus, RelayError> {
        let pending = self.pending.as_ref().ok_or_else(login_session_missing)?;
        if pending.id != login_id {
            return Err(login_session_missing());
        }
        if pending.expires_at <= Instant::now() {
            self.pending = None;
            return Ok(guest_status(BilibiliAuthStage::Expired));
        }
        let key = pending.key.clone();
        let response = self
            .request(QR_POLL_ENDPOINT)
            .query(&[("qrcode_key", key)])
            .send()
            .and_then(Response::error_for_status)
            .map_err(|error| auth_error("Cannot read the Bilibili login state", error))?;
        let headers = response.headers().clone();
        let root = response
            .json::<Value>()
            .map_err(|error| auth_error("Bilibili returned an invalid login state", error))?;
        let data = api_data(&root, "Bilibili did not return a login state")?;
        let state_code = data.get("code").and_then(Value::as_i64).unwrap_or(-1);
        match state_code {
            86101 => self.update_pending_stage(BilibiliAuthStage::Waiting),
            86090 => self.update_pending_stage(BilibiliAuthStage::Scanned),
            86038 => {
                self.pending = None;
                Ok(guest_status(BilibiliAuthStage::Expired))
            }
            0 => {
                let redirect_url = data.get("url").and_then(Value::as_str);
                let cookie = collect_cookies(&headers, redirect_url)?;
                let credentials = self.validate_credentials(cookie)?;
                let status = BilibiliAuthStatus {
                    stage: BilibiliAuthStage::Authenticated,
                    login_id: None,
                    display_name: Some(credentials.display_name.clone()),
                    user_id: Some(credentials.user_id),
                    expires_in_seconds: None,
                    qr: None,
                };
                self.credentials = Some(credentials);
                self.pending = None;
                Ok(status)
            }
            _ => Err(RelayError::new(
                "bilibili_login_failed",
                "Bilibili returned an unknown login state",
            )),
        }
    }

    pub fn logout(&mut self) -> BilibiliAuthStatus {
        self.credentials = None;
        self.pending = None;
        guest_status(BilibiliAuthStage::Guest)
    }

    fn update_pending_stage(
        &mut self,
        stage: BilibiliAuthStage,
    ) -> Result<BilibiliAuthStatus, RelayError> {
        let pending = self.pending.as_mut().ok_or_else(login_session_missing)?;
        pending.stage = stage;
        Ok(pending_status(pending, None))
    }

    fn validate_credentials(&self, cookie: String) -> Result<Credentials, RelayError> {
        let root = self
            .request(NAV_ENDPOINT)
            .header(COOKIE, &cookie)
            .send()
            .and_then(Response::error_for_status)
            .map_err(|error| auth_error("Cannot validate the Bilibili login", error))?
            .json::<Value>()
            .map_err(|error| auth_error("Bilibili returned an invalid account state", error))?;
        let data = api_data(&root, "Bilibili did not return an account state")?;
        if data.get("isLogin").and_then(Value::as_bool) != Some(true) {
            return Err(RelayError::new(
                "bilibili_login_failed",
                "Bilibili did not accept the login session",
            ));
        }
        Ok(Credentials {
            cookie,
            display_name: data
                .get("uname")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Bilibili 用户")
                .chars()
                .take(80)
                .collect(),
            user_id: data.get("mid").and_then(Value::as_u64).unwrap_or_default(),
        })
    }

    fn request(&self, endpoint: &str) -> reqwest::blocking::RequestBuilder {
        self.http
            .get(endpoint)
            .header(USER_AGENT, BROWSER_USER_AGENT)
            .header(ACCEPT, "application/json")
            .header(REFERER, LOGIN_PAGE)
    }
}

fn pending_status(pending: &PendingLogin, qr: Option<BilibiliLoginQr>) -> BilibiliAuthStatus {
    BilibiliAuthStatus {
        stage: pending.stage,
        login_id: Some(pending.id),
        display_name: None,
        user_id: None,
        expires_in_seconds: Some(
            pending
                .expires_at
                .saturating_duration_since(Instant::now())
                .as_secs()
                .max(1),
        ),
        qr,
    }
}

fn guest_status(stage: BilibiliAuthStage) -> BilibiliAuthStatus {
    BilibiliAuthStatus {
        stage,
        login_id: None,
        display_name: None,
        user_id: None,
        expires_in_seconds: None,
        qr: None,
    }
}

fn render_qr(url: &str) -> Result<BilibiliLoginQr, RelayError> {
    let code = QrCode::new(url.as_bytes()).map_err(|error| {
        RelayError::new(
            "bilibili_login_failed",
            format!("Bilibili login code could not be rendered: {error}"),
        )
    })?;
    let size = code.width();
    let colors = code.to_colors();
    let mut path = String::with_capacity(colors.len() * 9);
    for (index, color) in colors.into_iter().enumerate() {
        if color != Color::Dark {
            continue;
        }
        let x = index % size;
        let y = index / size;
        let _ = write!(path, "M{x} {y}h1v1h-1z");
    }
    Ok(BilibiliLoginQr { size, path })
}

fn collect_cookies(
    headers: &reqwest::header::HeaderMap,
    redirect_url: Option<&str>,
) -> Result<String, RelayError> {
    let mut cookies = BTreeMap::<String, String>::new();
    for header in headers.get_all(SET_COOKIE) {
        let Ok(value) = header.to_str() else {
            continue;
        };
        if let Some((name, value)) = cookie_pair(value.split(';').next().unwrap_or_default()) {
            cookies.insert(name, value);
        }
    }
    if let Some(query) = redirect_url
        .and_then(|value| Url::parse(value).ok())
        .and_then(|value| value.query().map(str::to_owned))
    {
        for pair in query.split('&') {
            if let Some((name, value)) = cookie_pair(pair) {
                cookies.entry(name).or_insert(value);
            }
        }
    }
    if !cookies
        .keys()
        .any(|name| name.eq_ignore_ascii_case("SESSDATA"))
    {
        return Err(RelayError::new(
            "bilibili_login_failed",
            "Bilibili login did not return an authenticated session",
        ));
    }
    let cookie = cookies
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.len() > MAX_COOKIE_BYTES {
        return Err(RelayError::new(
            "bilibili_login_failed",
            "Bilibili login returned an oversized session",
        ));
    }
    Ok(cookie)
}

fn cookie_pair(value: &str) -> Option<(String, String)> {
    let (name, value) = value.split_once('=')?;
    let canonical = COOKIE_NAMES
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(name.trim()))?;
    let value = value.trim();
    if value.is_empty() || value.contains(['\r', '\n', ';']) {
        return None;
    }
    Some(((*canonical).to_string(), value.to_string()))
}

fn api_data<'a>(root: &'a Value, fallback: &str) -> Result<&'a Value, RelayError> {
    if root.get("code").and_then(Value::as_i64) == Some(0) {
        return root
            .get("data")
            .ok_or_else(|| RelayError::new("bilibili_login_failed", fallback));
    }
    let message = root
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback);
    Err(RelayError::new("bilibili_login_failed", message))
}

fn required_string(
    value: &Value,
    field: &str,
    message: &'static str,
) -> Result<String, RelayError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RelayError::new("bilibili_login_failed", message))
}

fn auth_error(context: &'static str, error: impl std::fmt::Display) -> RelayError {
    RelayError::new("bilibili_login_unavailable", format!("{context}: {error}"))
}

fn login_session_missing() -> RelayError {
    RelayError::new(
        "bilibili_login_session_not_found",
        "Bilibili login session is no longer available",
    )
}
