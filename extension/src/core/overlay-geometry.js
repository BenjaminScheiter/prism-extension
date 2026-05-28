const DEFAULT_MARGIN = 16;
const DEFAULT_PADDING = 8;
const DEFAULT_RADIUS = 28;
const TALL_COMPOSER_HEIGHT = 96;
const TALL_RADIUS_CAP = 56;
const TALL_FALLBACK_RADIUS = 48;

export function placeOverlay({ composerRect, viewport, padding = DEFAULT_PADDING, margin = DEFAULT_MARGIN }) {
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(Math.max(320, composerRect.width + padding * 2), maxWidth);
  let x = composerRect.x - padding;
  x = Math.max(margin, Math.min(x, viewport.width - margin - width));

  const height = Math.max(64, composerRect.height + padding * 2);
  let y = composerRect.y - padding;
  y = Math.max(margin, Math.min(y, viewport.height - margin - height));

  return roundRect({ x, y, width, height });
}

export function collectNativeHoles({ overlayRect, controlRects, viewport, padding = 4, gap = 8 }) {
  const inside = controlRects
    .map((rect) => expandRect(rect, padding))
    .map((rect) => clampRectToViewport(rect, viewport))
    .filter((rect) => rect.width > 8 && rect.height > 8)
    .filter((rect) => rectsIntersect(rect, overlayRect))
    .map((rect) => ({
      x: Math.max(rect.x, overlayRect.x),
      y: Math.max(rect.y, overlayRect.y),
      width: Math.min(rect.x + rect.width, overlayRect.x + overlayRect.width) - Math.max(rect.x, overlayRect.x),
      height: Math.min(rect.y + rect.height, overlayRect.y + overlayRect.height) - Math.max(rect.y, overlayRect.y)
    }))
    .filter((rect) => rect.width > 8 && rect.height > 8);

  return mergeNearbyRects(inside, gap).map((rect) => ({
    ...rect,
    radius: Math.min(DEFAULT_RADIUS, rect.height / 2, rect.width / 2)
  }));
}

export function mergeNearbyRects(rects, gap = 8) {
  const expanded = rects.map((rect) => expandRect(rect, 4)).sort((a, b) => a.x - b.x || a.y - b.y);
  const merged = [];

  for (const rect of expanded) {
    const last = merged[merged.length - 1];
    if (!last || !shouldMerge(last, rect, gap)) {
      merged.push({ ...rect });
      continue;
    }

    const right = Math.max(last.x + last.width, rect.x + rect.width);
    const bottom = Math.max(last.y + last.height, rect.y + rect.height);
    last.x = Math.min(last.x, rect.x);
    last.y = Math.min(last.y, rect.y);
    last.width = right - last.x;
    last.height = bottom - last.y;
  }

  return merged.map(roundRect);
}

export function clampRectToViewport(rect, viewport) {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  return roundRect({
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  });
}

export function buildMaskPath({ overlayRect, holes = [], radius = DEFAULT_RADIUS }) {
  const outer = roundedRectPath(overlayRect, radius, "left");
  const holePaths = holes.map((hole) => roundedRectPath(hole, hole.radius ?? radius, "top"));
  return [outer, ...holePaths].join(" ");
}

export function resolveSkinRadius({ hostRadius = 0, width = 0, height = 0 } = {}) {
  const numericWidth = finiteNumber(width);
  const numericHeight = finiteNumber(height);
  const maxPhysicalRadius = Math.max(0, Math.min(numericWidth / 2, numericHeight / 2));
  if (!maxPhysicalRadius) return 0;

  const isTall = numericHeight >= TALL_COMPOSER_HEIGHT;
  const maxUsefulRadius = isTall ? Math.min(TALL_RADIUS_CAP, maxPhysicalRadius) : maxPhysicalRadius;
  const numericHostRadius = finiteNumber(hostRadius);

  if (numericHostRadius > 0) {
    return round(Math.min(numericHostRadius, maxUsefulRadius));
  }

  if (isTall) {
    return round(Math.min(TALL_FALLBACK_RADIUS, maxUsefulRadius));
  }

  return round(Math.min(Math.max(24, numericHeight / 2), maxUsefulRadius));
}

export function createReferenceNativeHoles({ overlayRect, left = true, right = true }) {
  const holes = [];
  const centerY = overlayRect.height / 2;
  const circle = Math.min(48, Math.max(40, overlayRect.height - 24));
  const y = Math.max(6, centerY - circle / 2);

  if (left && overlayRect.width >= 260) {
    holes.push({
      x: 10,
      y,
      width: circle,
      height: circle,
      radius: circle / 2
    });
  }

  if (right && overlayRect.width >= 420) {
    const margin = 10;
    const gap = 8;
    const action = circle;
    const modelWidth = Math.min(168, Math.max(132, overlayRect.width * 0.18));
    const sendX = overlayRect.width - margin - action;
    const voiceX = sendX - gap - action;
    const modelX = Math.max(overlayRect.width * 0.58, voiceX - gap - modelWidth);

    holes.push(
      { x: modelX, y, width: modelWidth, height: circle, radius: circle / 2 },
      { x: voiceX, y, width: action, height: circle, radius: action / 2 },
      { x: sendX, y, width: action, height: circle, radius: action / 2 }
    );
  }

  return holes.map((hole) => ({
    ...roundRect(hole),
    radius: round(hole.radius)
  }));
}

export function roundedRectPath(rect, radius = DEFAULT_RADIUS, start = "left") {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const x = round(rect.x);
  const y = round(rect.y);
  const w = round(rect.width);
  const h = round(rect.height);
  const right = round(x + w);
  const bottom = round(y + h);
  const centerX = round(x + w / 2);
  const centerY = round(y + h / 2);

  if (start === "top") {
    return [
      `M ${centerX} ${y}`,
      `H ${right - r}`,
      `Q ${right} ${y} ${right} ${y + r}`,
      `V ${bottom - r}`,
      `Q ${right} ${bottom} ${right - r} ${bottom}`,
      `H ${x + r}`,
      `Q ${x} ${bottom} ${x} ${bottom - r}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      "Z"
    ].join(" ");
  }

  return [
    `M ${x} ${centerY}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `H ${right - r}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `V ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `H ${x + r}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    `V ${centerY}`,
    "Z"
  ].join(" ");
}

function shouldMerge(a, b, gap) {
  const horizontalGap = b.x - (a.x + a.width);
  const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const sameRow = verticalOverlap >= Math.min(a.height, b.height) * 0.35;
  return sameRow && horizontalGap <= gap;
}

function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function roundRect(rect) {
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height)
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
