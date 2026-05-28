import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("browser extension display name includes the package version", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
  const expectedName = `Prism ${pkg.version}`;

  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.action.default_title, expectedName);
});

test("browser extension manifest is ready for Chrome Web Store packaging", async () => {
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"]);
  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  assert.deepEqual(Object.keys(manifest.action.default_icon), ["16", "32", "48", "128"]);
  assert.equal(manifest.icons["128"], "assets/icons/prism-128.png");
});

test("browser extension limits required site access to known AI hosts", async () => {
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
  const requiredHosts = manifest.host_permissions || [];
  const contentMatches = manifest.content_scripts.flatMap((script) => script.matches || []);
  const expectedAiHosts = [
    "https://chatgpt.com/*",
    "https://*.chatgpt.com/*",
    "https://claude.ai/*",
    "https://*.claude.ai/*",
    "https://gemini.google.com/*",
    "https://*.gemini.google.com/*",
    "https://grok.com/*",
    "https://*.grok.com/*",
    "https://perplexity.ai/*",
    "https://*.perplexity.ai/*",
    "https://kimi.com/*",
    "https://*.kimi.com/*"
  ];

  assert(!requiredHosts.includes("http://*/*"));
  assert(!requiredHosts.includes("https://*/*"));
  assert.deepEqual(contentMatches, expectedAiHosts);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
});

test("browser extension exposes only the page bridge to web pages", async () => {
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
  const resources = manifest.web_accessible_resources || [];

  assert.equal(resources.length, 1);
  assert.deepEqual(resources[0].resources, ["src/page-bridge.js"]);
  assert.equal(resources[0].use_dynamic_url, true);
});
