import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(root, "dist/release");
const manifestPath = resolve(releaseDir, "release-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

await checkFile(manifest.chromeExtension.zipPath);
await checkFile(`${manifest.chromeExtension.zipPath}.sha256`);
await assertSha(manifest.chromeExtension.zipPath, manifest.chromeExtension.zipSha256);
assertExtensionZip(manifest.chromeExtension.zipPath, manifest.version);

console.log("Release verification passed.");
console.log(`Chrome Web Store ZIP: ${manifest.chromeExtension.zipPath}`);

async function checkFile(path) {
  await access(resolve(root, path));
}

async function assertSha(path, expected) {
  const buffer = await readFile(resolve(root, path));
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path}`);
  }
}

function assertExtensionZip(path, version) {
  const zipPath = resolve(root, path);
  const entriesResult = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  if (entriesResult.status !== 0) {
    throw new Error("Could not list extension ZIP.");
  }
  const entries = entriesResult.stdout.trim().split(/\n+/).filter(Boolean);
  if (!entries.includes("manifest.json")) throw new Error("Extension ZIP is missing root manifest.json.");
  if (entries.includes("extension/manifest.json")) throw new Error("Extension ZIP incorrectly wraps files in extension/.");
  if (entries.some((entry) => entry.endsWith(".DS_Store"))) throw new Error("Extension ZIP contains .DS_Store.");

  const manifestResult = spawnSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" });
  const extensionManifest = JSON.parse(manifestResult.stdout);
  if (extensionManifest.version !== version) throw new Error("Extension version does not match package version.");
  if (extensionManifest.manifest_version !== 3) throw new Error("Extension must use Manifest V3.");
  for (const size of ["16", "32", "48", "128"]) {
    const icon = extensionManifest.icons?.[size];
    if (!icon || !entries.includes(icon)) throw new Error(`Missing ${size}px extension icon.`);
  }
}
