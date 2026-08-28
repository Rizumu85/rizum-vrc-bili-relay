# Repository Rules

This repository is the released GPUIX + Rust implementation of VRC Bili Relay.
The architecture began as an isolated experiment, and its UI feasibility gate was
accepted on 2026-08-27. The existing WinUI/C# solution remains a reference and
fallback; it is not a runtime dependency of this repository.

## Verification policy

- Only benchmark test suites may be executed.
- Do not run unit, integration, end-to-end, snapshot, smoke, acceptance, or visual-regression test suites.
- Do not add or invoke generic `test`, `vitest`, `jest`, `playwright`, `cargo test`, or `dotnet test` commands.
- Builds, TypeScript type checks, linting, manual application launches, and screenshot capture are permitted verification commands only when they do not invoke a test runner.
- Benchmark entry points must live under `benchmarks/`, use a `.bench.ts` or `.bench.tsx` suffix, and report measurements without disguising functional assertions as benchmarks.

## Scope

- Keep this repository independent from the existing WinUI solution.
- Treat `design/reference-contract.json` and the approved images under `design/reference/` as the UI source of truth.
- Do not copy the browser presentation canvas into the product window. The GPUIX window is the product surface.
- Do not import or invoke the C# product services. New product logic belongs in the Rust core.
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
