//! Per-command network budgets.
//!
//! The UI kills the worker when a dispatched command outlives its deadline
//! (see `src/relay/worker-rpc.ts`), which also stops any running publisher.
//! Every network-bound step of a command therefore draws its request timeout
//! from one command-level budget, so the command fails on its own well before
//! the UI deadline instead of accumulating sequential per-request timeouts.
use std::time::{Duration, Instant};

use crate::RelayError;

/// Longest single HTTP exchange, matching the clients' default timeout.
pub(crate) const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Below this, starting another request cannot finish meaningfully.
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Deadline(Instant);

impl Deadline {
    pub fn after(budget: Duration) -> Self {
        Self(Instant::now() + budget)
    }

    /// Time left for one request, capped at the normal request timeout.
    pub fn request_timeout(&self) -> Option<Duration> {
        self.0
            .checked_duration_since(Instant::now())
            .filter(|remaining| *remaining >= MIN_REQUEST_TIMEOUT)
            .map(|remaining| remaining.min(MAX_REQUEST_TIMEOUT))
    }

    pub fn require(&self, code: &'static str, context: &str) -> Result<Duration, RelayError> {
        self.request_timeout().ok_or_else(|| {
            RelayError::new(code, format!("{context}: the command's network time budget was exhausted"))
        })
    }
}
