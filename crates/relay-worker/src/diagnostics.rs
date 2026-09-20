//! Request timing only. Never format Command with Debug: it may contain secrets.
use std::io::Write;
use std::time::Instant;

use relay_core::{Command, RelayError, Reply};

pub(crate) struct CommandSpan {
    id: u64,
    name: &'static str,
    started: Instant,
}

impl CommandSpan {
    pub fn begin(id: u64, command: &Command) -> Self {
        let span = Self { id, name: command_name(command), started: Instant::now() };
        span.record("command_started", None);
        span
    }

    pub fn finish(self, result: &Result<Reply, RelayError>) {
        let code = match result {
            Ok(_) => "ok",
            Err(error) => error.code,
        };
        self.record("command_finished", Some(code));
    }

    fn record(&self, event: &'static str, code: Option<&'static str>) {
        let entry = serde_json::json!({
            "schema": 1, "kind": "worker_command", "event": event,
            "worker_pid": std::process::id(), "request_id": self.id,
            "command": self.name, "elapsed_ms": self.started.elapsed().as_secs_f64() * 1000.0,
            "code": code,
        });
        // A closed diagnostic pipe must not panic or contaminate stdout.
        let _ = writeln!(std::io::stderr().lock(), "{entry}");
    }
}

fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Health => "health",
        Command::InspectSource { .. } => "inspect_source",
        Command::ResolveSource { .. } => "resolve_source",
        Command::StartRelay { .. } => "start_relay",
        Command::RetargetRelay { .. } => "retarget_relay",
        Command::RelayStatus { .. } => "relay_status",
        Command::SetRelayPaused { .. } => "set_relay_paused",
        Command::SetRelayRate { .. } => "set_relay_rate",
        Command::StopRelay { .. } => "stop_relay",
        Command::EnsureFfmpeg => "ensure_ffmpeg",
        Command::BilibiliAuthStatus => "bilibili_auth_status",
        Command::BeginBilibiliLogin => "begin_bilibili_login",
        Command::PollBilibiliLogin { .. } => "poll_bilibili_login",
        Command::LogoutBilibili => "logout_bilibili",
        Command::ListFavoriteFolders => "list_favorite_folders",
        Command::ListFavoriteResources { .. } => "list_favorite_resources",
        Command::SearchFavoriteResources { .. } => "search_favorite_resources",
        Command::FetchFavoriteCovers { .. } => "fetch_favorite_covers",
        Command::ListWatchLater => "list_watch_later",
        Command::ListHistory { .. } => "list_history",
        Command::GetSettings => "get_settings",
        Command::RevealStreamKey => "reveal_stream_key",
        Command::SaveSettings { .. } => "save_settings",
        Command::Shutdown => "shutdown",
    }
}
