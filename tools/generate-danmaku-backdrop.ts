import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const width = 784;
const height = 148;
const output = resolve(import.meta.dir, "..", "assets", "danmaku-preview-backdrop.png");

type Rgb = readonly [number, number, number];

const ARC_SHELL = {
  coralEdge: [236, 103, 101],
  coral: [227, 154, 157],
  warmNeutral: [203, 196, 184],
  teal: [137, 229, 223],
  tealEdge: [79, 218, 211],
} as const satisfies Record<string, Rgb>;

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const mixColor = (from: Rgb, to: Rgb, amount: number): Rgb => [
  mix(from[0], to[0], amount),
  mix(from[1], to[1], amount),
  mix(from[2], to[2], amount),
];
const composite = (base: Rgb, overlay: Rgb, alpha: number): Rgb => mixColor(base, overlay, alpha);
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
};

function radialAlpha(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  strength: number,
): number {
  const distance = Math.sqrt(
    ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2,
  );
  return smoothstep(1, 0, distance) * strength;
}

function hash(x: number, y: number): number {
  let value = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x7f4a, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function pixel(x: number, y: number): Rgb {
  const nx = x / (width - 1);
  const ny = y / (height - 1);
  const diagonal = Math.max(0, Math.min(1, nx * 0.68 + ny * 0.32));
  let color = diagonal < 0.5
    ? mixColor(ARC_SHELL.coral, ARC_SHELL.warmNeutral, diagonal / 0.5)
    : mixColor(ARC_SHELL.warmNeutral, ARC_SHELL.teal, (diagonal - 0.5) / 0.5);

  const rose = radialAlpha(x, y, width * 0.1, -height * 0.12, width * 0.54, height * 1.55, 0.38);
  color = composite(color, ARC_SHELL.coralEdge, rose);

  const warmBridge = radialAlpha(x, y, width * 0.44, height * 0.08, width * 0.46, height * 1.5, 0.14);
  color = composite(color, [218, 169, 166], warmBridge);

  const teal = radialAlpha(x, y, width * 1.03, height * 0.96, width * 0.58, height * 1.64, 0.48);
  color = composite(color, ARC_SHELL.tealEdge, teal);

  const warmWash = smoothstep(0.86, 0.08, nx * 0.58 + (1 - ny) * 0.42) * 0.1;
  color = composite(color, [183, 174, 169], warmWash);

  const edgeX = Math.abs(nx - 0.5) * 2;
  const edgeY = Math.abs(ny - 0.5) * 2;
  const vignette = Math.max(edgeX ** 2, edgeY ** 2) * 0.055;
  color = mixColor(color, [91, 91, 94], vignette);

  // Zen keeps grain separate from its gradients. Quantising the coordinates
  // keeps this high-DPI texture fine without letting downsampling erase it.
  const grain = (hash(Math.floor(x / 2), Math.floor(y / 2)) - 0.5) * 5.4;
  return [clamp(color[0] + grain), clamp(color[1] + grain), clamp(color[2] + grain)];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const row = y * (width * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < width; x += 1) {
    const [red, green, blue] = pixel(x, y);
    const offset = row + 1 + x * 4;
    raw[offset] = red;
    raw[offset + 1] = green;
    raw[offset + 2] = blue;
    raw[offset + 3] = 255;
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", new Uint8Array()),
]);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, png);
console.log(`Generated ${output}`);
