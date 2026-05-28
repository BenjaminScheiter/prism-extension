import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMaskPath,
  clampRectToViewport,
  createReferenceNativeHoles,
  mergeNearbyRects,
  placeOverlay,
  resolveSkinRadius
} from "../src/core/overlay-geometry.js";

test("places the prism bar around the composer without leaving the viewport", () => {
  const placement = placeOverlay({
    composerRect: { x: 24, y: 620, width: 920, height: 72 },
    viewport: { width: 960, height: 720 }
  });

  assert.equal(placement.x, 16);
  assert.equal(placement.width, 928);
  assert.ok(placement.y >= 0);
  assert.ok(placement.height >= 72);
});

test("recomputes overlay position when the composer moves during scroll", () => {
  const viewport = { width: 960, height: 720 };
  const before = placeOverlay({
    composerRect: { x: 240, y: 620, width: 520, height: 60 },
    viewport
  });
  const after = placeOverlay({
    composerRect: { x: 240, y: 420, width: 520, height: 60 },
    viewport
  });

  assert.notEqual(before.y, after.y);
  assert.equal(after.y, 412);
});

test("merges nearby native control rects into stable carved holes", () => {
  const merged = mergeNearbyRects(
    [
      { x: 20, y: 20, width: 44, height: 44 },
      { x: 68, y: 20, width: 28, height: 44 },
      { x: 700, y: 20, width: 64, height: 44 }
    ],
    8
  );

  assert.deepEqual(merged, [
    { x: 16, y: 16, width: 84, height: 52 },
    { x: 696, y: 16, width: 72, height: 52 }
  ]);
});

test("creates an even-odd svg mask path with transparent native holes", () => {
  const path = buildMaskPath({
    overlayRect: { x: 10, y: 10, width: 400, height: 80 },
    holes: [
      { x: 20, y: 20, width: 48, height: 48, radius: 24 },
      { x: 320, y: 20, width: 72, height: 48, radius: 24 }
    ]
  });

  assert.match(path, /^M 10 50/);
  assert.match(path, /M 44 20/);
  assert.match(path, /M 356 20/);
  assert.match(path, /Z M/);
});

test("adds reference-style native tool holes when site controls are hard to detect", () => {
  const holes = createReferenceNativeHoles({
    overlayRect: { x: 0, y: 0, width: 820, height: 72 },
    left: true,
    right: true
  });

  assert.deepEqual(holes[0], { x: 10, y: 12, width: 48, height: 48, radius: 24 });
  assert.ok(holes.some((hole) => hole.width >= 132 && hole.x > 540), "model picker hole is present");
  assert.ok(holes.filter((hole) => hole.width === 48 && hole.x > 650).length >= 2, "right native button holes are present");
});

test("clamps control holes to the viewport", () => {
  assert.deepEqual(
    clampRectToViewport({ x: -10, y: 10, width: 40, height: 20 }, { width: 100, height: 50 }),
    { x: 0, y: 10, width: 30, height: 20 }
  );
});

test("keeps multiline composer radius from turning into a pill", () => {
  assert.equal(resolveSkinRadius({ hostRadius: 34, width: 900, height: 280 }), 34);
  assert.equal(resolveSkinRadius({ hostRadius: 9999, width: 900, height: 280 }), 56);
  assert.equal(resolveSkinRadius({ width: 900, height: 280 }), 48);
  assert.equal(resolveSkinRadius({ hostRadius: 9999, width: 860, height: 74 }), 37);
});
