# Vendored GPUIX runtime

The Windows release uses a patched GPUIX runtime so part menus can be real
owned popup windows with per-pixel transparency instead of rectangular helper
windows clipped in application code.

- GPUIX source: <https://github.com/Rizumu85/gpuix/tree/windows-anchored-popup>
- GPUIX commit: `03845a0`
- GPUI/GPUI Windows source: <https://github.com/Rizumu85/zed/tree/gpuix-windows-anchored-popup>
- GPUI/GPUI commit: `a11fd34736`

The runtime is distributed under Apache-2.0. The original license is included
beside each vendored package. The checked-in native binary keeps ordinary app
builds reproducible without requiring every contributor to compile the full
GPUI/GPUIX Rust dependency tree.
