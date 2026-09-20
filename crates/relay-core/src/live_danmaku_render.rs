//! Live overlay geometry and slot ownership, separate from network transport.
use std::time::{Duration, Instant};

use crate::danmaku::{DanmakuEvent, DanmakuKind, OUTPUT_HEIGHT};
use crate::danmaku_style::{font_size, opacity, outline, resolve_font};
use crate::filter_syntax::{graph_path, graph_value, option_value};
use crate::{DanmakuArea, DanmakuSettings, DanmakuSpeed};

pub(crate) const FILTER_SLOT_COUNT: usize = 24;

pub(crate) fn filter_graph(port: u16, settings: &DanmakuSettings) -> String {
    let font = resolve_font(settings);
    let font_file = graph_path(&font.file);
    let size = scaled_size(settings);
    let opacity = opacity(settings);
    let shadow_opacity = opacity * 0.6;
    let (border_width, shadow) = outline(settings);
    let mut filters = Vec::with_capacity(FILTER_SLOT_COUNT + 1);
    filters.push(format!("zmq=b={}", graph_value(&format!("tcp://127.0.0.1:{port}"))));
    for index in 0..FILTER_SLOT_COUNT {
        filters.push(format!(
            "drawtext@dm{index}=fontfile={font_file}:text=:expansion=none:fontsize={size}:\
             fontcolor=white@{opacity:.2}:borderw={border_width}:bordercolor=0x101010@{opacity:.2}:\
             shadowcolor=0x101010@{shadow_opacity:.2}:shadowx={shadow}:shadowy={shadow}:x=0:y=0"
        ));
    }
    filters.join(",")
}

/// Each parsed expression has its own register bank. `reinit` reparses it.
/// Capture the first actual frame timestamp, not the renderer thread's wall
/// clock or an assumed progress offset. +1 keeps timestamp zero distinguishable
/// from an uninitialized register. setpts upstream guarantees nonnegative t.
fn frame_elapsed() -> &'static str {
    "(t+1-st(0,if(eq(ld(0),0),t+1,ld(0))))"
}

pub(crate) fn reinit_argument(
    event: &DanmakuEvent,
    settings: &DanmakuSettings,
    lane: usize,
) -> String {
    let line_height = line_height(settings);
    let duration = event_duration(event.kind, settings.speed);
    let elapsed = frame_elapsed();
    let y = match event.kind {
        // drawtext's y anchors the top, unlike ASS's bottom-aligned \an2.
        DanmakuKind::Bottom => format!(
            "h-h*{}/{OUTPUT_HEIGHT}-text_h", 18 + lane as i32 * line_height
        ),
        _ => format!("h*{}/{OUTPUT_HEIGHT}", 12 + lane as i32 * line_height),
    };
    let x = match event.kind {
        DanmakuKind::Top | DanmakuKind::Bottom => "(w-text_w)/2".to_string(),
        DanmakuKind::Reverse => format!("-text_w+(w+text_w)*{elapsed}/{duration:.3}"),
        _ => format!("w-(w+text_w)*{elapsed}/{duration:.3}"),
    };
    let opacity = opacity(settings);
    let shadow_opacity = opacity * 0.6;
    let (border_width, shadow) = outline(settings);
    let text: String = event.text.chars().filter(|c| !c.is_control()).take(200).collect();
    // Self-expiry is evaluated in frame time, so a lost clear acknowledgement
    // cannot leave a fixed comment visible forever. Rust retains the slot until
    // an explicit clear succeeds; an unknown command outcome is not a free slot.
    let alpha = format!("lt({elapsed},{duration:.3})");
    format!(
        "text={}:expansion=none:fontsize={}:fontcolor=0x{:06X}@{opacity:.2}:\
         borderw={border_width}:bordercolor=0x101010@{opacity:.2}:\
         shadowcolor=0x101010@{shadow_opacity:.2}:shadowx={shadow}:shadowy={shadow}:\
         x={}:y={}:alpha={}",
        option_value(&text), scaled_size(settings), event.color,
        option_value(&x), option_value(&y), option_value(&alpha),
    )
}

fn scaled_size(settings: &DanmakuSettings) -> String {
    let logical = f64::from(font_size(settings.size)) * resolve_font(settings).drawtext_scale;
    format!("h*{logical:.6}/{OUTPUT_HEIGHT}")
}

fn line_height(settings: &DanmakuSettings) -> i32 {
    let size = font_size(settings.size);
    ((f64::from(size) * 1.22).round() as i32).max(size + 8)
}

pub(crate) fn event_duration(kind: DanmakuKind, speed: DanmakuSpeed) -> f64 {
    if matches!(kind, DanmakuKind::Top | DanmakuKind::Bottom) { return 4.0; }
    match speed { DanmakuSpeed::Slow => 12.0, DanmakuSpeed::Normal => 8.0, DanmakuSpeed::Fast => 6.0 }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaneGroup { Rolling, Top, Bottom }
impl From<DanmakuKind> for LaneGroup {
    fn from(kind: DanmakuKind) -> Self {
        match kind { DanmakuKind::Top => Self::Top, DanmakuKind::Bottom => Self::Bottom, _ => Self::Rolling }
    }
}

pub(crate) struct Reservation {
    pub slot: usize,
    pub lane: usize,
    group: LaneGroup,
}
struct ActiveSlot { lane: usize, group: LaneGroup, expires_at: Instant }

pub(crate) struct LiveSlots {
    slots: Vec<Option<ActiveSlot>>,
    lane_count: usize,
}
impl LiveSlots {
    pub fn new(settings: &DanmakuSettings) -> Self {
        let ratio = match settings.area { DanmakuArea::Quarter => 0.25, DanmakuArea::Half => 0.5, DanmakuArea::Full => 0.9 };
        let lane_count = ((f64::from(OUTPUT_HEIGHT) * ratio / f64::from(line_height(settings))).floor() as usize).clamp(1, 64);
        Self { slots: (0..FILTER_SLOT_COUNT).map(|_| None).collect(), lane_count }
    }
    pub fn reserve(&self, kind: DanmakuKind) -> Option<Reservation> {
        let slot = self.slots.iter().position(Option::is_none)?;
        let group = LaneGroup::from(kind);
        let lane = (0..self.lane_count).find(|lane| !self.slots.iter().flatten().any(|active| active.group == group && active.lane == *lane))?;
        Some(Reservation { slot, lane, group })
    }
    pub fn commit(&mut self, reservation: Reservation, lifetime: Duration) {
        self.slots[reservation.slot] = Some(ActiveSlot { lane: reservation.lane, group: reservation.group, expires_at: Instant::now() + lifetime });
    }
    pub fn expired(&self, now: Instant) -> Vec<usize> {
        self.slots.iter().enumerate().filter_map(|(slot, active)| active.as_ref().filter(|active| active.expires_at <= now).map(|_| slot)).collect()
    }
    pub fn clear_confirmed(&mut self, slot: usize) { self.slots[slot] = None; }
    pub fn active_count(&self) -> usize { self.slots.iter().flatten().count() }
}
