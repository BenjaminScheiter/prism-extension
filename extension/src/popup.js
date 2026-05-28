const SETTINGS_KEY = "prismSettings";
const STATE_KEY = "prismState";
const PRISM_USER_SITES_KEY = "prismUserSites";
const DEFAULT_SETTINGS = { enabled: true, paused: false };
const KNOWN_AI_HOSTS = [
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "grok.com",
  "perplexity.ai",
  "kimi.com"
];

const [settingsResult, metricsResult, localStateResult, activeTab] = await Promise.all([
  chrome.storage.sync.get(SETTINGS_KEY),
  chrome.storage.local.get("prismLastMetrics"),
  chrome.storage.local.get([STATE_KEY, PRISM_USER_SITES_KEY]),
  currentTab()
]);

const settings = { ...DEFAULT_SETTINGS, ...(settingsResult[SETTINGS_KEY] || {}) };
const metrics = metricsResult.prismLastMetrics || {};
const state = localStateResult[STATE_KEY] || {};
const userSites = localStateResult[PRISM_USER_SITES_KEY] || {};
const key = surfaceKey(activeTab?.url || "");
const siteState = key ? (state[key] || {}) : {};
const activePage = pageInfo(activeTab?.url || "");
const activeOrigin = activePage.origin;
const activePattern = activePage.pattern;
const knownAiSite = isKnownAiSite(activeTab?.url || "");
let userSiteEnabled = !!(activeOrigin && userSites[activeOrigin]);
if (activePattern && !userSiteEnabled) {
  userSiteEnabled = await hasSitePermission(activePattern);
}

text("before", metrics.beforeTokens || 0);
text("after", metrics.afterTokens || 0);
text("delta", signed(metrics.tokenDelta || 0));
text("vpt", Number(metrics.valuePerToken || 0).toFixed(3));
text("vpt-delta", signed(Number(metrics.valuePerTokenDelta || 0).toFixed(3)));
text("artifacts", metrics.protectedArtifacts || 0);
text("surface", metrics.surface || hostLabel(activeTab?.url) || "none");
text("strategy", metrics.strategy || "none");
text("decision", metrics.decision || "none");
text("confidence", Number.isFinite(Number(metrics.confidence)) ? `${Math.round(Number(metrics.confidence) * 100)}%` : "0%");

const toggle = document.getElementById("toggle");
const siteToggle = document.getElementById("site-toggle");
const siteAccess = document.getElementById("site-access");
const siteAccessMessage = document.getElementById("site-access-message");
const grantSite = document.getElementById("grant-site");
const removeSite = document.getElementById("remove-site");
renderControls();

toggle.addEventListener("click", async () => {
  settings.enabled = !settings.enabled;
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  renderControls();
});

siteToggle.addEventListener("click", async () => {
  if (!key) return;
  const next = { ...state };
  next[key] = { ...(next[key] || {}), paused: !siteState.paused };
  siteState.paused = !siteState.paused;
  await chrome.storage.local.set({ [STATE_KEY]: next });
  renderControls();
});

grantSite.addEventListener("click", enableCurrentSite);
removeSite.addEventListener("click", removeCurrentSite);

function renderControls() {
  const prismAvailable = knownAiSite || userSiteEnabled;
  toggle.textContent = settings.enabled ? "Disable overlay" : "Enable overlay";
  toggle.hidden = !prismAvailable;
  siteToggle.hidden = !prismAvailable;
  siteToggle.disabled = !key || !prismAvailable;
  siteToggle.textContent = siteState.paused ? "Resume site" : "Pause site";

  siteAccess.hidden = knownAiSite || !activeOrigin;
  grantSite.hidden = userSiteEnabled || !activeOrigin;
  removeSite.hidden = !userSiteEnabled;
  grantSite.disabled = !activeOrigin;
  removeSite.disabled = !activeOrigin;

  if (!activeOrigin) {
    siteAccess.hidden = false;
    siteAccessMessage.textContent = "Prism can be enabled on HTTPS AI chat sites.";
  } else if (userSiteEnabled) {
    siteAccessMessage.textContent = "Prism has user-granted access on this site.";
    removeSite.textContent = "Remove site access";
  } else {
    siteAccessMessage.textContent = "This is not one of Prism's built-in AI sites. You can enable Prism here if this is an AI chat page.";
    grantSite.textContent = "Enable Prism on this site";
  }
}

function text(id, value) {
  document.getElementById(id).textContent = String(value);
}

function signed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n > 0 ? `+${value}` : String(value);
}

async function currentTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

function surfaceKey(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").slice(0, 3).join("/");
    return (parsed.host + path).toLowerCase();
  } catch {
    return "";
  }
}

function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pageInfo(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { origin: "", pattern: "" };
    return {
      origin: parsed.origin,
      pattern: `${parsed.protocol}//${parsed.hostname}/*`
    };
  } catch {
    return { origin: "", pattern: "" };
  }
}

function isKnownAiSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return KNOWN_AI_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

async function hasSitePermission(pattern) {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function enableCurrentSite() {
  if (!activeOrigin || !activePattern || !activeTab?.id) return;
  grantSite.disabled = true;
  siteAccessMessage.textContent = "Waiting for Chrome permission...";

  const granted = await chrome.permissions.request({ origins: [activePattern] });
  if (!granted) {
    grantSite.disabled = false;
    siteAccessMessage.textContent = "Site access was not granted.";
    return;
  }

  const scriptId = scriptIdForOrigin(activeOrigin);
  await registerUserSiteScript(scriptId, activePattern);
  await chrome.storage.local.set({
    [PRISM_USER_SITES_KEY]: {
      ...userSites,
      [activeOrigin]: { scriptId, enabledAt: new Date().toISOString() }
    }
  });
  userSites[activeOrigin] = { scriptId, enabledAt: new Date().toISOString() };
  userSiteEnabled = true;
  await injectPrismIntoActiveTab(activeTab.id);
  renderControls();
}

async function removeCurrentSite() {
  if (!activeOrigin || !activePattern) return;
  removeSite.disabled = true;
  const scriptId = userSites[activeOrigin]?.scriptId || scriptIdForOrigin(activeOrigin);
  await unregisterUserSiteScript(scriptId);
  await chrome.permissions.remove({ origins: [activePattern] }).catch(() => false);
  delete userSites[activeOrigin];
  const nextState = { ...state };
  if (key) nextState[key] = { ...(nextState[key] || {}), paused: true };
  await chrome.storage.local.set({ [PRISM_USER_SITES_KEY]: userSites, [STATE_KEY]: nextState });
  userSiteEnabled = false;
  siteState.paused = true;
  renderControls();
}

async function registerUserSiteScript(scriptId, pattern) {
  await unregisterUserSiteScript(scriptId);
  await chrome.scripting.registerContentScripts([{
    id: scriptId,
    matches: [pattern],
    js: ["src/prism-core.js", "src/content.js"],
    css: ["src/content.css"],
    runAt: "document_start",
    persistAcrossSessions: true
  }]);
}

async function unregisterUserSiteScript(scriptId) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
  } catch {}
}

async function injectPrismIntoActiveTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content.css"] });
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/prism-core.js", "src/content.js"] });
  } catch (error) {
    siteAccessMessage.textContent = "Site access is enabled. Reload this page if Prism does not appear.";
  }
}

function scriptIdForOrigin(origin) {
  const safe = String(origin || "")
    .replace(/^https:\/\//, "")
    .replace(/[^a-z0-9_]/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `prism_user_${safe || "site"}`;
}
