import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createTestRoot } from "@gpuix/react/testing";

import { AppSurface } from "../src/app";

const WARMUP_FRAMES = 12;
const SAMPLE_FRAMES = 80;

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index] ?? 0;
}

function summarize(values: number[]) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

const { render, renderer, unmount } = createTestRoot({ width: 428, height: 478 });
const actualViewport = renderer.getWindowSize();

const mountStarted = performance.now();
render(<AppSurface initialScene="ready-vod" initialAppearance="light" />);
const mountMs = performance.now() - mountStarted;

for (let index = 0; index < WARMUP_FRAMES; index += 1) renderer.flush();

const frames: number[] = [];
for (let index = 0; index < SAMPLE_FRAMES; index += 1) {
  const started = performance.now();
  renderer.flush();
  frames.push(performance.now() - started);
}

const requestedViewport = { width: 428, height: 478 };
let screenshotPath: string | null = null;
if (
  Math.abs(actualViewport.width - requestedViewport.width) < 0.5 &&
  Math.abs(actualViewport.height - requestedViewport.height) < 0.5
) {
  const artifactDirectory = resolve(import.meta.dir, "../artifacts");
  mkdirSync(artifactDirectory, { recursive: true });
  screenshotPath = resolve(artifactDirectory, "ready-vod-light.png");
  renderer.captureScreenshot(screenshotPath);
}

console.log(
  JSON.stringify(
    {
      benchmark: "vrc-bili-relay-ready-vod-render",
      gpuix: "0.5.1",
      requestedViewport,
      actualViewport,
      mountMs,
      idleFrames: summarize(frames),
      screenshotPath,
      screenshotSkippedReason:
        screenshotPath === null
          ? "GPUIX 0.5.1 ignored the requested Windows offscreen viewport; use tools/capture-window.ps1."
          : null,
    },
    null,
    2,
  ),
);

unmount();
