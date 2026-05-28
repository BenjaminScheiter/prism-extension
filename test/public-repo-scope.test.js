import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("public repository is scoped to the Chrome extension", async () => {
  const rootEntries = await readdir(".");
  const forbidden = [".codex", ".prism-backup", "Native", "site", "bin", "script", "docs", "Package.swift", "NATIVE_HANDOFF.md"];
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const readme = await readFile("README.md", "utf8");

  for (const entry of forbidden) {
    assert(!rootEntries.includes(entry), `${entry} should not be published in the extension-only repo`);
  }
  assert.equal(pkg.name, "prism-extension");
  assert.equal(pkg.license, "UNLICENSED");
  assert.doesNotMatch(readme, /\b(?:macOS app|MCP server|CLI|native app|static app)\b/i);
  assert.match(readme, /Chrome extension/i);
});
