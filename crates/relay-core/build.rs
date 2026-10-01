// The product is versioned by package.json; expose that version to the core
// so the worker handshake reports the same version as the release.
fn main() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let version = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|root| root.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    println!("cargo:rustc-env=VRC_BILI_RELAY_VERSION={version}");
}
