import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const withZip = process.argv.includes("--zip");

run(process.execPath, [resolve(root, "scripts/generate-icons.mjs")]);

const coreBundle = await createContentScriptCoreBundle();

await writeFile(resolve(root, "extension/src/prism-core.js"), coreBundle);
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "extension/src"), { recursive: true });

await cp(resolve(root, "extension"), resolve(dist, "extension"), { recursive: true });
await cp(resolve(root, "src/core"), resolve(dist, "extension/src/core"), { recursive: true });
await removeJunkFiles(dist);

const manifestPath = resolve(dist, "extension/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionDisplayName = `Prism ${pkg.version}`;
manifest.name = extensionDisplayName;
manifest.version = pkg.version;
manifest.action = manifest.action || {};
manifest.action.default_title = extensionDisplayName;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(dist, "extension/src/prism-core.js"), coreBundle);

if (withZip) {
  const zipName = `prism-extension-v${pkg.version}.zip`;
  const result = spawnSync("zip", ["-qr", resolve(dist, zipName), "."], {
    cwd: resolve(dist, "extension"),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("zip command failed");
  }
}

console.log(`Built Prism extension ${pkg.version} in ${dist}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function removeJunkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.name === ".DS_Store") {
      await rm(path, { force: true });
      return;
    }
    if (entry.isDirectory()) await removeJunkFiles(path);
  }));
}

async function createContentScriptCoreBundle() {
  const engine = await readFile(resolve(root, "src/core/prism-engine.js"), "utf8");
  const overlay = await readFile(resolve(root, "src/core/overlay-geometry.js"), "utf8");
  const stripExports = (source) => source.replace(/^export\s+/gm, "");
  return `(() => {
${stripExports(engine)}
${stripExports(overlay)}
globalThis.PrismCore = {
  createPrismEngine,
  prismPrompt,
  analyzePrompt,
  protectArtifacts,
  restoreArtifacts,
  placeOverlay,
  collectNativeHoles,
  createReferenceNativeHoles,
  mergeNearbyRects,
  clampRectToViewport,
  buildMaskPath,
  roundedRectPath,
  resolveSkinRadius
};
globalThis.PrismOptimizer = {
  optimize(prompt, options = {}) {
    const result = prismPrompt(prompt, options);
    return {
      optimizedPrompt: result.output,
      result,
      metrics: result.metrics
    };
  }
};
})();\n`;
}
