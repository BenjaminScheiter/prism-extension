import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOGO_PATH = "M12 3 L21 19 H3 Z";
const LOGO_FACETS = "M3 19 L12 11 L21 19";

test("extension badge, composer, popup, and options use the same Prism triangle mark", async () => {
  const content = await readFile("extension/src/content.js", "utf8");
  const contentCss = await readFile("extension/src/content.css", "utf8");
  const popup = await readFile("extension/src/popup.html", "utf8");
  const popupCss = await readFile("extension/src/popup.css", "utf8");
  const options = await readFile("extension/src/options.html", "utf8");
  const optionsCss = await readFile("extension/src/options.css", "utf8");

  assert.match(content, /function prismMarkSvg\(gradientId = "prismG"\)/);
  assert.match(content, /badge\.innerHTML = prismMarkSvg\("prismBadgeG"\)/);
  assert.match(content, /prism-inline-mark[\s\S]*prismMarkSvg\("prismComposerG"\)/);
  assert.match(content, new RegExp(LOGO_PATH));
  assert.match(content, new RegExp(LOGO_FACETS));
  assert.match(popup, new RegExp(LOGO_PATH));
  assert.match(popup, new RegExp(LOGO_FACETS));
  assert.match(options, new RegExp(LOGO_PATH));
  assert.match(options, new RegExp(LOGO_FACETS));
  assert.doesNotMatch(contentCss, /\.prism-inline-mark span/);
  assert.doesNotMatch(contentCss, /nth-child/);
  assert.doesNotMatch(popupCss.match(/\.mark\s*\{[\s\S]*?\}/)?.[0] ?? "", /radial-gradient/);
  assert.doesNotMatch(optionsCss.match(/\.mark\s*\{[\s\S]*?\}/)?.[0] ?? "", /radial-gradient/);
});
