import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("popup implements user-granted site access with Chrome permissions and scripting", async () => {
  const source = await readFile("extension/src/popup.js", "utf8");

  assert.match(source, /PRISM_USER_SITES_KEY/);
  assert.match(source, /chrome\.permissions\.request/);
  assert.match(source, /chrome\.permissions\.remove/);
  assert.match(source, /chrome\.scripting\.registerContentScripts/);
  assert.match(source, /chrome\.scripting\.unregisterContentScripts/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /chrome\.scripting\.insertCSS/);
});

test("popup exposes controls for enabling and removing site access", async () => {
  const html = await readFile("extension/src/popup.html", "utf8");
  const source = await readFile("extension/src/popup.js", "utf8");

  assert.match(html, /site-access/);
  assert.match(html, /grant-site/);
  assert.match(html, /remove-site/);
  assert.match(source, /Enable Prism on this site/);
  assert.match(source, /Remove site access/);
});
