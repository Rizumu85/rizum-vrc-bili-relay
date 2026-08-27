# Repository Rules

This repository is an isolated GPUIX feasibility spike for VRC Bili Relay.

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
- Preserve product services outside this spike until the UI feasibility gate is passed.
- GPUIX is pre-1.0. Verify unfamiliar APIs against the pinned `@gpuix/react` dependency instead of inferring them from DOM or GPUI names.

## UI architecture

- React components own UI structure and state.
- Platform adapters own Windows-only clipboard and future process integration.
- Keep design tokens centralized in `src/theme.ts`; do not patch individual component instances with replacement colors or spacing.
- Use native GPUIX inputs and headless controls where available.
- All visible text must set an explicit color because GPUI does not inherit text color.

