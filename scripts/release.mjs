import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const releaseDir = resolve(dist, "release");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

run(process.execPath, [resolve(root, "scripts/build.mjs"), "--zip"]);

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const extensionZipName = `prism-extension-v${version}-chrome-web-store.zip`;
const extensionZipPath = resolve(releaseDir, extensionZipName);
const builtExtensionZip = resolve(dist, `prism-extension-v${version}.zip`);
const extensionZipReport = validateExtensionZip(builtExtensionZip);

await copyFile(builtExtensionZip, extensionZipPath);
const extensionSha = await writeSha256(extensionZipPath);

const releaseManifest = {
  name: "Prism",
  version,
  builtAt: new Date().toISOString(),
  chromeExtension: {
    zipPath: relative(extensionZipPath),
    zipSha256: extensionSha,
    zipRoot: extensionZipReport.root,
    manifestVersion: extensionZipReport.manifest.version,
    permissions: extensionZipReport.manifest.permissions || [],
    hostPermissions: extensionZipReport.manifest.host_permissions || [],
    optionalHostPermissions: extensionZipReport.manifest.optional_host_permissions || []
  }
};

await writeFile(resolve(releaseDir, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
await writeFile(resolve(releaseDir, "CHROME_WEB_STORE_LISTING.md"), chromeStoreListing(releaseManifest));

console.log(`Release artifacts written to ${releaseDir}`);
console.log(`Chrome Web Store ZIP: ${extensionZipPath}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function validateExtensionZip(zipPath) {
  const listing = spawnSync("unzip", ["-Z1", zipPath], {
    cwd: root,
    encoding: "utf8"
  });
  if (listing.status !== 0) {
    throw new Error(`Could not inspect extension zip: ${listing.stderr || listing.stdout}`);
  }
  const entries = listing.stdout.trim().split(/\n+/).filter(Boolean);
  if (!entries.includes("manifest.json")) {
    throw new Error("Chrome Web Store package must contain manifest.json at the ZIP root.");
  }
  if (entries.includes("extension/manifest.json")) {
    throw new Error("Chrome Web Store package must not wrap files inside an extension/ directory.");
  }
  if (entries.some((entry) => entry.endsWith(".DS_Store"))) {
    throw new Error("Chrome Web Store package contains .DS_Store files.");
  }
  const manifestText = spawnSync("unzip", ["-p", zipPath, "manifest.json"], {
    cwd: root,
    encoding: "utf8"
  });
  if (manifestText.status !== 0) {
    throw new Error("Could not read manifest.json from extension zip.");
  }
  const manifest = JSON.parse(manifestText.stdout);
  if (manifest.manifest_version !== 3) {
    throw new Error("Chrome Web Store package must use Manifest V3.");
  }
  for (const size of ["16", "32", "48", "128"]) {
    const iconPath = manifest.icons?.[size];
    if (!iconPath || !entries.includes(iconPath)) {
      throw new Error(`Chrome Web Store package is missing ${size}px icon at ${iconPath || "(unset)"}.`);
    }
  }
  return { root: "manifest.json", entries, manifest };
}

async function writeSha256(path) {
  const buffer = await readFile(path);
  const digest = createHash("sha256").update(buffer).digest("hex");
  await writeFile(`${path}.sha256`, `${digest}  ${path.split("/").pop()}\n`);
  return digest;
}

function relative(path) {
  return path.replace(`${root}/`, "");
}

function chromeStoreListing(manifest) {
  return `# Chrome Web Store Listing Draft

Name: Prism

Summary: Rewrite prompts locally before sending them to AI apps.

Description:
Prism improves prompts before they are sent. It removes filler, preserves exact artifacts such as code and URLs, adds concise output guidance, and shows prompt quality metrics. Prism runs locally and stores only extension settings and local metrics.

Single purpose:
Prism rewrites and analyzes prompts in supported web text inputs so users can send clearer, more concise AI prompts.

Permission justification:
- storage: saves Prism settings, per-site enabled state, and local metrics.
- activeTab: lets the popup understand the currently active tab after the user opens Prism.
- scripting: lets Prism inject its local optimizer only after the user enables Prism on an additional site.
- optional host permissions for HTTPS pages: lets users explicitly grant Prism access to AI chat sites that are not in the built-in supported host list.

Privacy disclosure:
Prism does not sell user data. Prism V1 does not call external AI APIs from the extension package. Prompt rewriting runs locally in the extension content script. Settings and metrics are stored with Chrome extension storage.

Package:
\`${manifest.chromeExtension.zipPath}\`

Version:
\`${manifest.version}\`
`;
}
