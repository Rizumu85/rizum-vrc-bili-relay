import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createTestRoot } from "@gpuix/react/testing";

import { AppSurface, sceneWindowHeight, sceneWindowWidth } from "../src/app";

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

const requestedViewport = {
  width: sceneWindowWidth("ready-vod"),
  height: sceneWindowHeight("ready-vod"),
};
const { render, renderer, unmount } = createTestRoot(requestedViewport);
const actualViewport = renderer.getWindowSize();

async function measureSurface(key: string, scene: "ready-vod" | "danmaku") {
  const mountStarted = performance.now();
  render(<AppSurface key={key} initialScene={scene} initialAppearance="light" />);
  const mountMs = performance.now() - mountStarted;

  for (let index = 0; index < WARMUP_FRAMES; index += 1) renderer.flush();

  const frames: number[] = [];
  for (let index = 0; index < SAMPLE_FRAMES; index += 1) {
    const started = performance.now();
    renderer.flush();
    frames.push(performance.now() - started);
  }
  return { mountMs, frames: summarize(frames) };
}

const readyVod = await measureSurface("ready-vod", "ready-vod");

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

const danmaku = await measureSurface("danmaku", "danmaku");

console.log(
  JSON.stringify(
    {
      benchmark: "vrc-bili-relay-ready-vod-render",
      gpuix: "0.5.1",
      requestedViewport,
      actualViewport,
      surfaces: {
        readyVod,
        danmakuPreview: danmaku,
      },
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
