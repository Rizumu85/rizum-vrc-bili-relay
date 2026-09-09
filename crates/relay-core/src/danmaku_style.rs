//! Typography shared by the live (drawtext) and video (libass) renderers.
use std::path::PathBuf;

use crate::{DanmakuFont, DanmakuOutline, DanmakuSettings, DanmakuSize, DanmakuWeight};

pub(crate) fn font_directory() -> Option<PathBuf> {
    let packaged = std::env::current_exe()
        .ok()?
        .parent()?
        .join("assets/fonts/danmaku");
    // Cargo-built workers also run directly from target/{debug,release}.
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts/danmaku");
    [packaged, development].into_iter().find(|path| {
        path.join("NotoSansSC-Regular.otf").is_file() && path.join("NotoSansSC-Bold.otf").is_file()
    })
}

pub(crate) fn font_size(size: DanmakuSize) -> i32 {
    match size {
        DanmakuSize::Small => 28,
        DanmakuSize::Medium => 36,
        DanmakuSize::Large => 44,
    }
}

pub(crate) fn opacity(settings: &DanmakuSettings) -> f64 {
    f64::from(settings.opacity.clamp(20, 100)) / 100.0
}

pub(crate) fn ass_alpha(opacity: f64) -> u8 {
    ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8
}

/// Border widths scale with the glyphs, rather than overwhelming smaller text.
pub(crate) fn outline(settings: &DanmakuSettings) -> (u8, u8) {
    let scale = f64::from(font_size(settings.size)) / 44.0;
    // drawtext accepts integer pixel widths; use the same rounded values in
    // libass so changing source type doesn't change the chosen outline style.
    let pixels = |value: f64| (value * scale).round().max(1.0) as u8;
    match settings.outline {
        DanmakuOutline::Heavy => (pixels(2.0), 0),
        DanmakuOutline::Outline => (1, 0),
        DanmakuOutline::Shadow => (1, pixels(2.0)),
    }
}

pub(crate) struct ResolvedFont {
    pub file: PathBuf,
    pub family: &'static str,
    pub drawtext_scale: f64,
}

pub(crate) fn resolve_font(settings: &DanmakuSettings) -> ResolvedFont {
    let bold = matches!(settings.weight, DanmakuWeight::Bold);
    if matches!(settings.font, DanmakuFont::NotoSansSc)
        && let Some(directory) = font_directory()
    {
        // Explicit static 400/700 faces: drawtext otherwise opens the variable
        // font's default axis (100/Thin), even when the UI requests bold.
        return ResolvedFont {
            file: directory.join(if bold {
                "NotoSansSC-Bold.otf"
            } else {
                "NotoSansSC-Regular.otf"
            }),
            family: "Noto Sans SC",
            // Both pinned faces: UPM=1000, ascender=1160, descender=-288.
            // libass sizes the full line; drawtext sizes the em. Match visual
            // size while leaving logical lane spacing unchanged.
            drawtext_scale: 1000.0 / 1448.0,
        };
    }
    let windows = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("Fonts");
    let (filename, family) = match settings.font {
        DanmakuFont::SourceHanSans => (
            if bold {
                "SourceHanSansSC-Bold.otf"
            } else {
                "SourceHanSansSC-Regular.otf"
            },
            "Source Han Sans SC",
        ),
        DanmakuFont::Simhei => ("simhei.ttf", "SimHei"),
        _ => (
            if bold { "msyhbd.ttc" } else { "msyh.ttc" },
            "Microsoft YaHei",
        ),
    };
    let requested = windows.join(filename);
    if requested.is_file() {
        ResolvedFont {
            file: requested,
            family,
            drawtext_scale: 1.0,
        }
    } else {
        ResolvedFont {
            file: windows.join(if bold { "msyhbd.ttc" } else { "msyh.ttc" }),
            family: "Microsoft YaHei",
            drawtext_scale: 1.0,
        }
    }
}
