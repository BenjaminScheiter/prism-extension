const SETTINGS_KEY = "prismSettings";
const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "balanced",
  overlayIntensity: 1,
  autoMetrics: true,
  defaultOutputGuidance: true,
  outputGuidanceText: "direct, concise, complete",
  paused: false
};

const form = document.getElementById("settings");
const stored = await chrome.storage.sync.get(SETTINGS_KEY);
const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };

form.enabled.checked = settings.enabled;
form.autoMetrics.checked = settings.autoMetrics;
form.paused.checked = settings.paused;
form.mode.value = settings.mode;
form.defaultOutputGuidance.checked = settings.defaultOutputGuidance !== false;
form.outputGuidanceText.value = settings.outputGuidanceText || DEFAULT_SETTINGS.outputGuidanceText;
form.overlayIntensity.value = String(settings.overlayIntensity);

form.addEventListener("input", save);
form.addEventListener("change", save);
document.getElementById("export").addEventListener("click", exportDiagnostics);

async function save() {
  await chrome.storage.sync.set({
    [SETTINGS_KEY]: {
      enabled: form.enabled.checked,
      autoMetrics: form.autoMetrics.checked,
      paused: form.paused.checked,
      mode: form.mode.value,
      defaultOutputGuidance: form.defaultOutputGuidance.checked,
      outputGuidanceText: normalizeOutputGuidance(form.outputGuidanceText.value),
      overlayIntensity: Number(form.overlayIntensity.value)
    }
  });
}

function normalizeOutputGuidance(value) {
  return String(value || "")
    .replace(/^Output:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/u, "") || DEFAULT_SETTINGS.outputGuidanceText;
}

async function exportDiagnostics() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null)
  ]);
  const payload = {
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    settings: sync[SETTINGS_KEY] || {},
    lastMetrics: local.prismLastMetrics || null,
    surfaceState: local.prismState || {}
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `prism-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
