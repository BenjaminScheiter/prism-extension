import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionIconDir = resolve(root, "extension/assets/icons");

await mkdir(extensionIconDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  await writeFile(resolve(extensionIconDir, `prism-${size}.png`), createPng(size));
}

console.log("Generated Prism extension icons.");

function createPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(size, x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function pixel(size, x, y) {
  const nx = (x + 0.5) / size;
  const ny = (y + 0.5) / size;
  const badgeDistance = Math.hypot(nx - 0.5, ny - 0.5);
  const badgeAlpha = smoothstep(0.5, 0.46, badgeDistance);
  if (badgeAlpha <= 0) return [0, 0, 0, 0];

  let r = 20;
  let g = 16;
  let b = 28;

  const top = [0.5, 0.125];
  const right = [0.875, 0.792];
  const left = [0.125, 0.792];
  const inner = [0.5, 0.458];
  const insideTriangle = pointInTriangle([nx, ny], top, right, left);
  const triangleEdge = Math.min(
    distanceToSegment(nx, ny, top, right),
    distanceToSegment(nx, ny, right, left),
    distanceToSegment(nx, ny, left, top)
  );
  const triangleCoverage = insideTriangle ? 1 : smoothstep(0.018, 0, triangleEdge) * 0.7;

  if (triangleCoverage > 0) {
    const magentaMix = Math.max(0, 1 - Math.hypot(nx - 0.18, ny - 0.18) / 0.78);
    const cyanMix = Math.max(0, 1 - Math.hypot(nx - 0.86, ny - 0.82) / 0.9);
    let tr = blend(164, 255, magentaMix * 0.72);
    let tg = blend(139, 106, magentaMix * 0.62);
    let tb = blend(255, 213, magentaMix * 0.55);
    tr = blend(tr, 122, cyanMix * 0.72);
    tg = blend(tg, 230, cyanMix * 0.72);
    tb = blend(tb, 253, cyanMix * 0.72);

    r = blend(r, tr, triangleCoverage);
    g = blend(g, tg, triangleCoverage);
    b = blend(b, tb, triangleCoverage);
  }

  const facetDistance = Math.min(
    distanceToSegment(nx, ny, left, inner),
    distanceToSegment(nx, ny, inner, right)
  );
  const whiteLine = Math.max(
    smoothstep(0.014, 0.004, triangleEdge) * 0.38,
    insideTriangle ? smoothstep(0.012, 0.003, facetDistance) * 0.52 : 0
  );
  r = blend(r, 255, whiteLine);
  g = blend(g, 255, whiteLine);
  b = blend(b, 255, whiteLine);

  return [clamp(r), clamp(g), clamp(b), clamp(255 * badgeAlpha)];
}

function pointInTriangle(p, a, b, c) {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(p1, p2, p3) {
  return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
}

function distanceToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function blend(a, b, amount) {
  return a + (b - a) * amount;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
