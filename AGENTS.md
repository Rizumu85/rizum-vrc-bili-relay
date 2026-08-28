# Repository Rules

This repository is the released GPUIX + Rust implementation of VRC Bili Relay.

## Verification policy

- Only benchmark test suites may be executed.
- Do not run unit, integration, end-to-end, snapshot, smoke, acceptance, or visual-regression test suites.
- Do not add or invoke generic `test`, `vitest`, `jest`, `playwright`, or `cargo test` commands.
- Builds, TypeScript type checks, linting, manual application launches, and screenshot capture are permitted verification commands only when they do not invoke a test runner.
- Benchmark entry points must live under `benchmarks/`, use a `.bench.ts` or `.bench.tsx` suffix, and report measurements without disguising functional assertions as benchmarks.

## Release synchronization

- After creating or replacing a GitHub Release asset, copy that exact uploaded ZIP into `release/` and expand it there so the convenient local portable build matches the public artifact.
- Verify the local archive SHA-256 against the uploaded asset. Do not treat `dist/` as the formal local Release, and do not rebuild a second archive with different bytes for `release/`.
- Do not close the user's running formal build while editing, compiling, packaging, uploading, or verifying a replacement. Only after the new uploaded artifact and its checksum are ready, gracefully close the canonical `release/` executable immediately before replacing its files. Allow its relay worker and FFmpeg children to exit, replace from the exact verified archive, then relaunch the formal build if it was running before the update. The user has authorized this narrowly timed interruption even during an active relay; do not create duplicate pending-update folders unless graceful replacement genuinely fails.

## Scope

- Treat `design/reference-contract.json` and the approved images under `design/reference/` as the UI source of truth.
- Do not copy the browser presentation canvas into the product window. The GPUIX window is the product surface.
- GPUIX is pre-1.0. Verify unfamiliar APIs against the pinned `@gpuix/react` dependency instead of inferring them from DOM or GPUI names.

## Product architecture

- React + TypeScript own presentation, interaction state, motion, and Rizum Glass translation only.
- `crates/relay-core` owns source inspection, Bilibili resolution, routing decisions, VRCDN orchestration, danmaku processing, local serving, persistence, and FFmpeg lifecycle as those capabilities are added.
- `crates/relay-worker` is the stdio JSON Lines adapter around the core. Keep stdout protocol-only; diagnostics go to stderr.
- `src/relay/worker-client.ts` is the only UI-side process adapter. React views must not spawn FFmpeg or duplicate Rust decisions.
- FFmpeg remains an external executable managed by Rust. Do not reimplement codecs in TypeScript or Rust.
- Keep the wire interface small and versioned. Prefer adding behaviour behind existing commands over exposing internal Rust modules to the UI.

## UI architecture

- React components own UI structure and state.
- Platform adapters own Windows-only clipboard and native window sizing. Rust worker process integration belongs only in `src/relay/worker-client.ts`.
- Keep design tokens centralized in `src/theme.ts`; do not patch individual component instances with replacement colors or spacing.
- Use native GPUIX inputs and headless controls where available.
- All visible text must set an explicit color because GPUI does not inherit text color.
