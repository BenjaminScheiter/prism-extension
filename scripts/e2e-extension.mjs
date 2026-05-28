import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(root, process.env.PRISM_EXTENSION_PATH || "dist/extension");
const fixturePath = resolve(root, "fixtures/chatgpt.html");
const qaDir = resolve(root, "dist/qa");
const chromePath = process.env.CHROME_PATH || findChrome();
const DOCKER_OPTIMIZED_PROMPT = "Explain docker containers for a beginner\nOutput: direct, concise, complete";
const EARTHQUAKE_OPTIMIZED_PROMPT = "How many earthquakes occur each year\nOutput: direct, concise, complete";
const EARTHQUAKE_OPTIMIZED_SINGLE_LINE_PROMPT = "How many earthquakes occur each year Output: direct, concise, complete";
const EARTHQUAKE_OPTIMIZED_PATTERN = /^How many earthquakes occur each year\nOutput: direct, concise, complete$/i;
const EARTHQUAKE_OPTIMIZED_FLEX_PATTERN = /^How many earthquakes occur each year\s+Output: direct, concise, complete$/i;

class CdpClient {
  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => resolveConnect(client), { once: true });
      socket.addEventListener("error", rejectConnect, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => this.handleMessage(event));
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
  }

  close() {
    this.socket.close();
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method) {
      this.events.push(message);
      this.events = this.events.slice(-20);
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  diagnostics() {
    return this.events.map((event) => JSON.stringify(event).slice(0, 800)).join("\n");
  }
}

if (!existsSync(extensionPath)) {
  throw new Error("Missing dist/extension. Run node scripts/build.mjs first.");
}
if (!chromePath) {
  throw new Error("Chrome or Chromium was not found. Set CHROME_PATH to run extension E2E.");
}

await writeFile(resolve(root, "dist/.e2e-ready"), "ready\n");
const server = await startFixtureServer();
const userDataDir = await mkdtemp(resolve(tmpdir(), "prism-chrome-"));
const extensionLoadPath = resolve(userDataDir, "prism-extension");
await symlink(extensionPath, extensionLoadPath, "dir");
let chromeLog = "";
const chromeArgs = [
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${userDataDir}`,
  `--disable-extensions-except=${extensionLoadPath}`,
  `--load-extension=${extensionLoadPath}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "about:blank"
];
if (process.env.PRISM_HEADLESS !== "0") chromeArgs.unshift("--headless=new");
const chrome = spawn(chromePath, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", (chunk) => {
  chromeLog += chunk.toString("utf8");
});

let client;
try {
  const port = await waitForDevToolsPort(userDataDir, chrome);
  const tabInfo = await firstPageTarget(port);
  client = await CdpClient.connect(tabInfo.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await delay(1000);
  await client.send("Page.navigate", { url: server.url });
  await waitForEval(client, "document.readyState === 'complete'");
  let injectionMode = "extension";
  const autoMounted = await tryWaitForEval(client, "Boolean(document.querySelector('.prism-composer'))", 6000);
  if (!autoMounted) {
    injectionMode = "manual-built-script";
    await injectBuiltExtensionRuntime(client);
    await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  }
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const initialTracking = await evaluate(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return {
      rootTop: Math.round(root.top),
      rootLeft: Math.round(root.left),
      rootWidth: Math.round(root.width),
      rootHeight: Math.round(root.height),
      composerTop: Math.round(composer.top),
      composerLeft: Math.round(composer.left),
      composerWidth: Math.round(composer.width),
      composerHeight: Math.round(composer.height)
    };
  })()`);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return Math.abs(root.top - composer.top) <= 4 &&
      Math.abs(root.left - composer.left) <= 4 &&
      Math.abs(root.width - composer.width) <= 4 &&
      Math.abs(root.height - composer.height) <= 4;
  })()`);
  const badgePlacement = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const badgeRect = badge.getBoundingClientRect();
    const composerRect = document.querySelector('.composer').getBoundingClientRect();
    const style = getComputedStyle(badge);
    const overlapWidth = Math.max(0, Math.min(badgeRect.right, composerRect.right) - Math.max(badgeRect.left, composerRect.left));
    const overlapHeight = Math.max(0, Math.min(badgeRect.bottom, composerRect.bottom) - Math.max(badgeRect.top, composerRect.top));
    const overlapRatio = (overlapWidth * overlapHeight) / Math.max(1, badgeRect.width * badgeRect.height);
    const centerTarget = document.elementFromPoint(badgeRect.left + badgeRect.width / 2, badgeRect.top + badgeRect.height / 2);
    return {
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03,
      clickable: centerTarget === badge || badge.contains(centerTarget),
      overlapRatio,
      badgeRect: { left: badgeRect.left, top: badgeRect.top, right: badgeRect.right, bottom: badgeRect.bottom },
      composerRect: { left: composerRect.left, top: composerRect.top, right: composerRect.right, bottom: composerRect.bottom }
    };
  })()`);
  assert(badgePlacement.visible && badgePlacement.clickable && badgePlacement.overlapRatio <= 0.12,
    `Prism badge should stay visible, clickable, and outside the native composer ${JSON.stringify(badgePlacement)}`);
  const manifest = JSON.parse(await readFile(resolve(extensionPath, "manifest.json"), "utf8"));
  const badgeVersion = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    return { version: badge?.dataset.version || "", title: badge?.title || "" };
  })()`);
  if (injectionMode === "extension") {
    assert(badgeVersion.version === manifest.version && badgeVersion.title.includes(manifest.version),
      `Prism badge should expose the loaded extension version ${JSON.stringify({ badgeVersion, manifestVersion: manifest.version })}`);
  }
  const canPatchGlobalSettings = await evaluate(client, "Boolean(window.__PrismContentTest?.setGlobalSettings)");
  if (canPatchGlobalSettings) {
    await evaluate(client, "window.__PrismContentTest.setGlobalSettings({ enabled: false }); true;");
    await waitForEval(client, `(() => {
      const badge = document.querySelector('.prism-badge');
      const composer = document.querySelector('.prism-composer');
      const r = badge?.getBoundingClientRect();
      const style = badge ? getComputedStyle(badge) : null;
      return !!badge &&
        badge.dataset.state === 'off' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.03 &&
        r.width > 1 &&
        r.height > 1 &&
        (!composer || getComputedStyle(composer).display === 'none');
    })()`);
    await clickCenter(client, ".prism-badge");
    await waitForEval(client, `(() => {
      const badge = document.querySelector('.prism-badge');
      const composer = document.querySelector('.prism-composer');
      return badge?.dataset.state === 'on' &&
        !!composer &&
        getComputedStyle(composer).display !== 'none';
    })()`);
  }
  await evaluate(client, "document.querySelector('.prism-badge').remove(); window.dispatchEvent(new Event('resize')); true;");
  await waitForEval(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    if (!badge) return false;
    const r = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return badge.isConnected &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0.03 &&
      r.width > 1 &&
      r.height > 1;
  })()`);

  await evaluate(client, `
    (() => {
      const modal = document.createElement('div');
      modal.className = 'fixture-voice-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = '<h1>Try voice mode for free</h1><button>Back to chat</button>';
      Object.assign(modal.style, {
        position: 'fixed',
        inset: '0',
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(20, 20, 22, 0.92)',
        color: 'white'
      });
      document.body.appendChild(modal);
      return true;
    })();
  `);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer');
    const badge = document.querySelector('.prism-badge');
    return getComputedStyle(root).visibility === 'hidden' &&
      getComputedStyle(badge).visibility === 'hidden';
  })()`);
  const modalScreenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await mkdir(qaDir, { recursive: true });
  await writeFile(resolve(qaDir, "prism-extension-modal-layering.png"), Buffer.from(modalScreenshot.data, "base64"));
  await evaluate(client, "document.querySelector('.fixture-voice-modal')?.remove(); true;");
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer');
    const badge = document.querySelector('.prism-badge');
    return getComputedStyle(root).visibility !== 'hidden' &&
      getComputedStyle(badge).visibility !== 'hidden';
  })()`);

  const badgeClickBefore = await evaluate(client, `(() => {
    const composer = document.querySelector('.prism-composer');
    return {
      beforeOpen: getComputedStyle(composer).display !== 'none',
      hasPeek: composer.dataset.peek === 'true'
    };
  })()`);
  await clickCenter(client, ".prism-badge");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display === 'none'");
  await clickCenter(client, ".prism-badge");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const badgeClickResult = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const composer = document.querySelector('.prism-composer');
    const badgeRect = badge?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    return {
      beforeOpen: ${JSON.stringify(badgeClickBefore.beforeOpen)},
      afterReopened: !!composer && getComputedStyle(composer).display !== 'none' && composerRect.width > 200 && composerRect.height > 30,
      badgeVisible: !!badge && badgeStyle.display !== 'none' && badgeStyle.visibility !== 'hidden' && Number(badgeStyle.opacity || 1) > 0.03 && badgeRect.width > 1 && badgeRect.height > 1,
      badgeCollapsed: badge?.dataset.collapsed === 'true',
      hasPeek: composer.dataset.peek === 'true'
    };
  })()`);
  assert(badgeClickResult.beforeOpen && badgeClickResult.afterReopened && badgeClickResult.badgeVisible && !badgeClickResult.badgeCollapsed,
    `real badge clicks should turn Prism off and then back on without losing the icon ${JSON.stringify(badgeClickResult)}`);
  assert(!badgeClickResult.hasPeek && !badgeClickBefore.hasPeek, "normal badge click should not open the off-state peek");
  await clickCenter(client, ".prism-badge");
  await delay(500);
  const collapsedBadgeResult = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const composer = document.querySelector('.prism-composer');
    const r = badge?.getBoundingClientRect();
    const style = badge ? getComputedStyle(badge) : null;
    return {
      badgeExists: !!badge,
      badgeVisible: !!badge && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03 && r.width > 1 && r.height > 1,
      badgeCollapsed: badge?.dataset.collapsed === 'true',
      composerHidden: !!composer && getComputedStyle(composer).display === 'none'
    };
  })()`);
  assert(collapsedBadgeResult.badgeExists && collapsedBadgeResult.badgeVisible && collapsedBadgeResult.badgeCollapsed && collapsedBadgeResult.composerHidden,
    `turning Prism off should hide the layer but keep the icon visible for re-opening ${JSON.stringify(collapsedBadgeResult)}`);
  const collapsedAfterRefreshResult = await evaluate(client, `new Promise((resolve) => {
    const field = document.querySelector('[data-testid="prompt"]');
    field.style.opacity = '0';
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => {
      const badge = document.querySelector('.prism-badge');
      const composer = document.querySelector('.prism-composer');
      const r = badge?.getBoundingClientRect();
      const style = badge ? getComputedStyle(badge) : null;
      resolve({
        badgeExists: !!badge,
        badgeVisible: !!badge && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03 && r.width > 1 && r.height > 1,
        badgeCollapsed: badge?.dataset.collapsed === 'true',
        composerHidden: !!composer && getComputedStyle(composer).display === 'none',
        badgeRect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null,
        hitTarget: r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className || "" : "",
        fieldOpacity: getComputedStyle(field).opacity
      });
    }, 350);
  })`);
  assert(collapsedAfterRefreshResult.badgeExists && collapsedAfterRefreshResult.badgeVisible && collapsedAfterRefreshResult.badgeCollapsed && collapsedAfterRefreshResult.composerHidden,
    `Prism icon should stay visible after an off-state prompt visibility refresh ${JSON.stringify(collapsedAfterRefreshResult)}`);
  await clickCenter(client, ".prism-badge");
  await delay(500);
  const reopenedDuringRefreshResult = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const composer = document.querySelector('.prism-composer');
    const badgeRect = badge?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    const composerStyle = composer ? getComputedStyle(composer) : null;
    return {
      badgeVisible: !!badge && badgeStyle.display !== 'none' && badgeStyle.visibility !== 'hidden' && Number(badgeStyle.opacity || 1) > 0.03 && badgeRect.width > 1 && badgeRect.height > 1,
      badgeCollapsed: badge?.dataset.collapsed === 'true',
      composerVisible: !!composer && composerStyle.display !== 'none' && composerRect.width > 200 && composerRect.height > 30,
      badgeRect: badgeRect ? { left: badgeRect.left, top: badgeRect.top, right: badgeRect.right, bottom: badgeRect.bottom, width: badgeRect.width, height: badgeRect.height } : null,
      composerRect: composerRect ? { left: composerRect.left, top: composerRect.top, right: composerRect.right, bottom: composerRect.bottom, width: composerRect.width, height: composerRect.height } : null,
      hitTarget: badgeRect ? document.elementFromPoint(badgeRect.left + badgeRect.width / 2, badgeRect.top + badgeRect.height / 2)?.className || "" : "",
      fieldOpacity: getComputedStyle(document.querySelector('[data-testid="prompt"]')).opacity
    };
  })()`);
  assert(reopenedDuringRefreshResult.badgeVisible && !reopenedDuringRefreshResult.badgeCollapsed && reopenedDuringRefreshResult.composerVisible,
    `clicking the off-state Prism icon should turn the layer back on instead of hiding the icon ${JSON.stringify(reopenedDuringRefreshResult)}`);
  await evaluate(client, "document.querySelector('[data-testid=\"prompt\"]').style.opacity = ''; window.dispatchEvent(new Event('resize')); true;");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");

  await evaluate(client, `
    (() => {
      const native = document.querySelector('[data-testid="prompt"]');
      native.focus();
      native.value = "hey can you please explain docker containers like I am new to programming";
      native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: native.value }));
      return true;
    })();
  `);
  await evaluate(client, "document.querySelector('.prism-badge').click(); true;");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display === 'none'");
  const longPressPeek = await evaluate(client, `new Promise((resolve) => {
    const badge = document.querySelector('.prism-badge');
    badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
    setTimeout(() => {
      const composer = document.querySelector('.prism-composer');
      const text = document.querySelector('.prism-peek-text')?.textContent || "";
      const tooltip = document.querySelector('.prism-peek-tooltip');
      const tooltipStyle = getComputedStyle(tooltip);
      resolve({
        composerVisible: getComputedStyle(composer).display !== 'none',
        peekActive: composer.dataset.peek === 'true',
        stillCollapsed: document.querySelector('.prism-badge').dataset.collapsed === 'true',
        text,
        tooltipVisible: Number(tooltipStyle.opacity) > 0.5,
        tooltipText: tooltip.textContent,
        nativeValue: document.querySelector('[data-testid="prompt"]').value,
        hasPreviewPanel: Boolean(document.querySelector('.prism-preview-panel'))
      });
    }, 620);
  })`);
  assert(longPressPeek.composerVisible && longPressPeek.peekActive && longPressPeek.stillCollapsed, `long press while Prism is off should show a temporary in-box peek without toggling Prism on ${JSON.stringify(longPressPeek)}`);
  assert(longPressPeek.text.includes(DOCKER_OPTIMIZED_PROMPT), `peek layer should show the local rewrite inside the message box ${JSON.stringify(longPressPeek)}`);
  assert(longPressPeek.tooltipVisible && /Double-tap Control/i.test(longPressPeek.tooltipText), `peek tooltip should explain the Control double-tap adoption path ${JSON.stringify(longPressPeek)}`);
  assert(longPressPeek.nativeValue === "hey can you please explain docker containers like I am new to programming", `peek must not mutate the native prompt while held ${JSON.stringify(longPressPeek)}`);
  assert(!longPressPeek.hasPreviewPanel, "old floating preview panel should not be mounted");
  await evaluate(client, "document.querySelector('.prism-badge').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' })); true;");
  await waitForPeekClosed(client);
  const longPressClosed = await evaluate(client, `(() => ({
    value: document.querySelector('[data-testid="prompt"]').value,
    composerHidden: getComputedStyle(document.querySelector('.prism-composer')).display === 'none',
    peekActive: document.querySelector('.prism-composer').dataset.peek === 'true'
  }))()`);
  assert(longPressClosed.value === "hey can you please explain docker containers like I am new to programming" && longPressClosed.composerHidden && !longPressClosed.peekActive, `releasing long press should restore the user's original prompt view ${JSON.stringify(longPressClosed)}`);

  await evaluate(client, `
    (() => {
      const native = document.querySelector('[data-testid="prompt"]');
      native.value = "hey can you please explain docker containers like I am new to programming";
      native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: native.value }));
      const badge = document.querySelector('.prism-badge');
      badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, pointerType: 'mouse' }));
      return true;
    })();
  `);
  await waitForEval(client, "document.querySelector('.prism-composer').dataset.peek === 'true'");
  await evaluate(client, `
    new Promise((resolve) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
        resolve(true);
      }, 110);
    })
  `);
  await waitForEval(client, `document.querySelector('[data-testid="prompt"]').value === ${JSON.stringify(DOCKER_OPTIMIZED_PROMPT)}`);
  await waitForPeekClosed(client);
  const previewInserted = await evaluate(client, `(() => ({
    value: document.querySelector('[data-testid="prompt"]').value,
    sent: document.querySelector('[data-testid="prompt"]').value === "",
    stillCollapsed: document.querySelector('.prism-badge').dataset.collapsed === 'true',
    peekClosed: document.querySelector('.prism-composer').dataset.peek !== 'true'
  }))()`);
  assert(previewInserted.value === DOCKER_OPTIMIZED_PROMPT && !previewInserted.sent && previewInserted.stillCollapsed && previewInserted.peekClosed, `Control double-tap should insert the peeked rewrite without sending or turning Prism on ${JSON.stringify(previewInserted)}`);
  await evaluate(client, "document.querySelector('.prism-badge').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); true;");
  await waitForEval(client, "document.querySelector('.prism-composer').dataset.peek === 'true'");
  await evaluate(client, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;");
  await waitForPeekClosed(client);
  await delay(950);
  await evaluate(client, "document.querySelector('.prism-badge').click(); true;");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");

  await evaluate(client, `
    (() => {
      const modal = document.createElement('div');
      modal.className = 'fixture-preview-layer-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      Object.assign(modal.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '5000',
        background: 'rgba(20, 20, 22, 0.92)'
      });
      document.body.appendChild(modal);
      return true;
    })();
  `);
  await waitForEval(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    return getComputedStyle(badge).visibility === 'hidden';
  })()`);
  await evaluate(client, "document.querySelector('.fixture-preview-layer-modal')?.remove(); true;");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-badge')).visibility !== 'hidden'");

  await evaluate(client, `
    (() => {
      const composer = document.querySelector('.composer');
      const native = document.querySelector('[data-testid="prompt"]');
      composer.dataset.delayHostGrowth = 'true';
      composer.dataset.delayFrames = '8';
      native.focus();
      native.value = ['k', 'k', 'k', 'k', 'k', 'k'].join('\\n');
      native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: '\\n' }));
      return true;
    })();
  `);
  const transitionSamples = await evaluate(client, `new Promise((resolve) => {
    const samples = [];
    let count = 0;
    const sample = () => {
      const root = document.querySelector('.prism-composer').getBoundingClientRect();
      const host = document.querySelector('.composer').getBoundingClientRect();
      const field = document.querySelector('[data-testid="prompt"]').getBoundingClientRect();
      const skin = document.querySelector('.prism-skin-svg > rect[mask]');
      samples.push({
        rootHeight: Math.round(root.height),
        hostHeight: Math.round(host.height),
        fieldHeight: Math.round(field.height),
        rootTop: Math.round(root.top),
        hostTop: Math.round(host.top),
        skinRx: Number(skin?.getAttribute('rx') || 0)
      });
      count += 1;
      if (count >= 12) resolve(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`);
  const unstableTransitionSamples = transitionSamples.filter((sample) =>
    Math.abs(sample.rootHeight - sample.hostHeight) > 4 ||
    Math.abs(sample.rootTop - sample.hostTop) > 4 ||
    (sample.hostHeight < 100 && sample.rootHeight > sample.hostHeight + 12)
  );
  await mkdir(qaDir, { recursive: true });
  await writeFile(resolve(qaDir, "chatgpt-transition-report.json"), JSON.stringify({
    samples: transitionSamples,
    unstableSamples: unstableTransitionSamples
  }, null, 2));
  assert(unstableTransitionSamples.length === 0, `Prism should not switch surfaces during delayed ChatGPT line growth: ${JSON.stringify(transitionSamples)}`);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return composer.height > 120 &&
      Math.abs(root.top - composer.top) <= 2 &&
      Math.abs(root.left - composer.left) <= 2 &&
      Math.abs(root.width - composer.width) <= 2 &&
      Math.abs(root.height - composer.height) <= 2;
  })()`);

  await evaluate(client, `
    (() => {
      const composer = document.querySelector('.composer');
      const native = document.querySelector('[data-testid="prompt"]');
      composer.dataset.splitSurface = 'true';
      composer.dataset.delayHostGrowth = 'true';
      composer.dataset.delayFrames = '8';
      native.focus();
      native.value = '';
      native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })();
  `);
  const shrinkSamples = await evaluate(client, `new Promise((resolve) => {
    const samples = [];
    let count = 0;
    const sample = () => {
      const root = document.querySelector('.prism-composer').getBoundingClientRect();
      const host = document.querySelector('.composer').getBoundingClientRect();
      const inner = document.querySelector('.composer-inner').getBoundingClientRect();
      const field = document.querySelector('[data-testid="prompt"]').getBoundingClientRect();
      const skin = document.querySelector('.prism-skin-svg > rect[mask]');
      samples.push({
        rootHeight: Math.round(root.height),
        hostHeight: Math.round(host.height),
        innerHeight: Math.round(inner.height),
        fieldHeight: Math.round(field.height),
        rootTop: Math.round(root.top),
        hostTop: Math.round(host.top),
        innerTop: Math.round(inner.top),
        skinRx: Number(skin?.getAttribute('rx') || 0)
      });
      count += 1;
      if (count >= 12) resolve(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`);
  const unstableShrinkSamples = shrinkSamples.filter((sample) =>
    sample.hostHeight > sample.innerHeight + 12 &&
    (
      Math.abs(sample.rootHeight - sample.hostHeight) > 4 ||
      Math.abs(sample.rootTop - sample.hostTop) > 4
    )
  );
  await writeFile(resolve(qaDir, "chatgpt-transition-report.json"), JSON.stringify({
    samples: transitionSamples,
    unstableSamples: unstableTransitionSamples,
    shrinkSamples,
    unstableShrinkSamples
  }, null, 2));
  assert(unstableShrinkSamples.length === 0, `Prism should not switch to ChatGPT's inner row during delayed collapse: ${JSON.stringify(shrinkSamples)}`);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return composer.height <= 90 &&
      Math.abs(root.top - composer.top) <= 2 &&
      Math.abs(root.left - composer.left) <= 2 &&
      Math.abs(root.width - composer.width) <= 2 &&
      Math.abs(root.height - composer.height) <= 2;
  })()`);
  await evaluate(client, `
    (() => {
      const composer = document.querySelector('.composer');
      composer.dataset.splitSurface = 'false';
      composer.dataset.delayHostGrowth = 'false';
      composer.dataset.delayFrames = '0';
      return true;
    })();
  `);

  const stressPrompt = ["k", "k", "k", "k", "k", "k", "k", "k", "k", "k"].join("\n");
  await evaluate(client, `
    (() => {
    const native = document.querySelector('[data-testid="prompt"]');
    native.focus();
    native.value = ${JSON.stringify(stressPrompt)};
    native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: '\\n' }));
    return true;
    })();
  `);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return composer.height > 150 &&
      Math.abs(root.top - composer.top) <= 2 &&
      Math.abs(root.left - composer.left) <= 2 &&
      Math.abs(root.width - composer.width) <= 2 &&
      Math.abs(root.height - composer.height) <= 2;
  })()`);
  const multilineShape = await evaluate(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const host = document.querySelector('.composer');
    const hostRect = host.getBoundingClientRect();
    const skin = document.querySelector('.prism-skin-svg > rect[mask]');
    const maskBase = document.querySelector('.prism-skin-svg mask rect');
    const hostRadius = parseFloat(getComputedStyle(host).borderTopLeftRadius || getComputedStyle(host).borderRadius) || 0;
    const skinRx = Number(skin.getAttribute('rx'));
    const maskRx = Number(maskBase.getAttribute('rx'));
    return {
      rootHeight: Math.round(root.height),
      hostHeight: Math.round(hostRect.height),
      hostRadius,
      skinRx,
      maskRx,
      skinRadiusRatio: skinRx / Math.max(1, root.height)
    };
  })()`);
  assert(Math.abs(multilineShape.skinRx - multilineShape.hostRadius) <= 1, `multiline skin radius should match native host radius: ${JSON.stringify(multilineShape)}`);
  assert(Math.abs(multilineShape.maskRx - multilineShape.skinRx) <= 1, `mask base radius should match skin radius: ${JSON.stringify(multilineShape)}`);
  assert(multilineShape.skinRadiusRatio < 0.35, `multiline skin should not become a pill: ${JSON.stringify(multilineShape)}`);

  const prompt = [
    "hey can you please make this function faster but do not change `exactCall()`",
    "exactCall();",
    "return a checklist"
  ].join("\n");
  await evaluate(client, `
    (() => {
    const native = document.querySelector('[data-testid="prompt"]');
    native.focus();
    native.value = ${JSON.stringify(prompt)};
    native.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: native.value }));
    return true;
    })();
  `);
  await waitForEval(client, "document.querySelector('[data-testid=\"prompt\"]').value.includes('exactCall')");
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const svg = document.querySelector('.prism-skin-svg').getBoundingClientRect();
    const inputZone = document.querySelector('.prism-input-zone');
    const native = document.querySelector('[data-testid="prompt"]');
    const nativeRect = native.getBoundingClientRect();
    const pointElement = document.elementFromPoint(nativeRect.left + 220, nativeRect.top + nativeRect.height / 2);
    return Math.abs(root.top - composer.top) <= 2 &&
      Math.abs(root.left - composer.left) <= 2 &&
      Math.abs(root.width - composer.width) <= 2 &&
      Math.abs(root.height - composer.height) <= 2 &&
      Math.abs(svg.height - root.height) <= 2 &&
      getComputedStyle(inputZone).display === 'none' &&
      (pointElement === native || native.contains(pointElement)) &&
      document.querySelector('.prism-composer').dataset.expanded === 'native';
  })()`);
  await mkdir(qaDir, { recursive: true });
  const typingScreenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(resolve(qaDir, "prism-extension-typing.png"), Buffer.from(typingScreenshot.data, "base64"));
  await evaluate(client, "document.querySelector('.send').click(); true;");
  await waitForEval(client, "document.querySelector('[data-testid=\"prompt\"]').value.includes('Task:')");
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return Math.abs(root.top - composer.top) <= 2 &&
      Math.abs(root.left - composer.left) <= 2 &&
      Math.abs(root.width - composer.width) <= 2 &&
      Math.abs(root.height - composer.height) <= 2;
  })()`);

  const result = await evaluate(client, `(() => {
    const input = document.querySelector('[data-testid="prompt"]').value;
    const root = document.querySelector('.prism-composer');
    const rootRect = root.getBoundingClientRect();
    const prismInput = document.querySelector('.prism-composer-input');
    const inputZone = document.querySelector('.prism-input-zone').getBoundingClientRect();
    const inputZoneStyle = getComputedStyle(document.querySelector('.prism-input-zone'));
    const skinLayerStyle = getComputedStyle(document.querySelector('.prism-skin-layer'));
    const hostComposer = document.querySelector('.composer').getBoundingClientRect();
    const nativePrompt = document.querySelector('[data-testid="prompt"]');
    const nativePromptRect = nativePrompt.getBoundingClientRect();
    const nativeControls = [
      document.querySelector('.plus'),
      document.querySelector('.tools'),
      document.querySelector('select'),
      document.querySelector('.mic'),
      document.querySelector('.send')
    ];
    const holeRects = Array.from(document.querySelectorAll('.prism-skin-svg mask rect')).slice(1).map((hole) => ({
      x: Number(hole.getAttribute('x')),
      y: Number(hole.getAttribute('y')),
      width: Number(hole.getAttribute('width')),
      height: Number(hole.getAttribute('height'))
    }));
    const exposedNativeControls = nativeControls.filter((el) => {
      const r = el.getBoundingClientRect();
      const pointElement = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return pointElement === el || el.contains(pointElement);
    }).length;
    const tinyLeftArtifactCount = holeRects.filter((hole) => hole.x < rootRect.width * 0.32 && (hole.width < 30 || hole.height < 30)).length;
    const inputPointElement = document.elementFromPoint(nativePromptRect.left + 220, nativePromptRect.top + nativePromptRect.height / 2);
    return {
      hasAdaptiveTask: input.includes('Task:') && input.includes('Output: a checklist'),
      hasNoFixedTemplate: !input.includes('Goal:') && !input.includes('Quality bar:'),
      hasArtifact: input.includes('\`exactCall()\`') && input.includes('exactCall();'),
      hasWaste: /basically|could you please/.test(input),
      composerCoversNativeSurface:
        Math.abs(rootRect.top - hostComposer.top) <= 2 &&
        Math.abs(rootRect.left - hostComposer.left) <= 2 &&
        Math.abs(rootRect.width - hostComposer.width) <= 2 &&
        Math.abs(rootRect.height - hostComposer.height) <= 2,
      skinHasNoDropShadow: skinLayerStyle.filter === 'none',
      prismInputHidden: inputZoneStyle.display === 'none' && prismInput.offsetParent === null,
      nativeInputIsTextTarget: inputPointElement === nativePrompt || nativePrompt.contains(inputPointElement),
      hasMask: holeRects.some((hole) => hole.x < 96 && hole.width < 110) && holeRects.some((hole) => hole.x + hole.width > rootRect.width * 0.72 && hole.width < 260),
      holeCount: holeRects.length,
      tinyLeftArtifactCount,
      exposedNativeControls,
      rootWidth: Math.round(rootRect.width)
    };
  })()`);

  assert(result.hasAdaptiveTask, "rewritten prompt should include adaptive Task/Output structure");
  assert(result.hasNoFixedTemplate, "rewritten prompt should not force the old fixed template");
  assert(result.hasArtifact, "rewritten prompt should preserve exact artifacts");
  assert(!result.hasWaste, "rewritten prompt should remove waste phrases");
  assert(result.composerCoversNativeSurface, "Prism skin should exactly track the native composer surface");
  assert(result.skinHasNoDropShadow, "Prism skin should not add drop shadows around mask holes");
  assert(result.prismInputHidden, "Prism should not render a second visible input over the native composer");
  assert(result.nativeInputIsTextTarget, "native input should remain the writable text target under the Prism skin");
  assert(result.hasMask, `overlay should expose SVG mask holes for native controls; saw ${result.holeCount}`);
  assert(result.holeCount <= 6, `overlay should not create duplicate nested control holes; saw ${result.holeCount}`);
  assert(result.tinyLeftArtifactCount === 0, "overlay should not create small dark duplicate holes around the left toolbar");
  assert(result.exposedNativeControls >= 4, "native model controls should remain click-through through carveouts");
  assert(result.rootWidth > 300, "overlay should have a usable width");

  const sentScreenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(resolve(qaDir, "prism-extension-sent.png"), Buffer.from(sentScreenshot.data, "base64"));

  const shapeResults = [];
  for (const shape of providerShapeCases()) {
    shapeResults.push(await assertProviderShape(client, server.shapeUrl(shape.name), shape, injectionMode));
  }
  await writeFile(resolve(qaDir, "provider-shape-report.json"), JSON.stringify(shapeResults, null, 2));

  await assertContenteditableAppendRisk(client, server.appendRiskUrl, injectionMode);
  await assertContenteditablePreviewAdoption(client, server.appendRiskUrl, injectionMode);
  await assertContenteditableAppendRisk(client, server.perplexityAppendRiskUrl, injectionMode, ".send", { requiresTrustedNativeSend: true });
  await assertContenteditableEnterSend(client, server.perplexityAppendRiskUrl, injectionMode, { requiresTrustedNativeSend: true });
  await assertContenteditablePreviewAdoption(client, server.perplexityAppendRiskUrl, injectionMode);
  await assertContenteditablePreviewAdoptionAndSend(client, server.perplexityAppendRiskUrl, injectionMode);
  await assertContenteditableAppendRisk(client, server.kimiDivSendRiskUrl, injectionMode, ".send-button-container");
  await assertContenteditableEnterSend(client, server.kimiDivSendRiskUrl, injectionMode);
  await assertContenteditablePreviewAdoptionAndSend(client, server.kimiDivSendRiskUrl, injectionMode, ".send-button-container");
  await assertContenteditableAppendRisk(client, server.kimiTrustedSendRiskUrl, injectionMode, ".send-button-container", { requiresTrustedNativeSend: true });
  await assertContenteditableEnterSend(client, server.kimiTrustedSendRiskUrl, injectionMode, { requiresTrustedNativeSend: true });
  await assertContenteditableEnterSend(client, server.windowCaptureSendRiskUrl, injectionMode, {
    waitForWindowCaptureReady: true,
  });
  await assertNoPromptGalleryStaysNative(client, server.noPromptGalleryUrl, injectionMode);
  await assertHomepagePromptSurvivesSettledLayout(client, server.homepagePromptUrl, injectionMode);
  await assertPrismTracksMovingPrompt(client, server.scrollTrackingUrl, injectionMode);

  await client.send("Page.navigate", { url: server.selfOptOutUrl });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await delay(800);
  const selfOptOutResult = await evaluate(client, `(() => ({
    hasOptOut: document.querySelector('meta[name="prism-extension"][content="disabled"]') !== null,
    hasPrismUi: document.querySelector('.prism-composer,.prism-badge') !== null,
    textareaVisible: document.querySelector('[data-testid="self-prompt"]')?.getBoundingClientRect().width > 200
  }))()`);
  assert(selfOptOutResult.hasOptOut, "self opt-out fixture should expose the Prism extension opt-out meta tag");
  assert(selfOptOutResult.textareaVisible, "self opt-out fixture should expose a visible prompt textarea");
  assert(!selfOptOutResult.hasPrismUi, "Prism should not inject composer or badge into pages that opt out");
  console.log(`E2E passed (${injectionMode}): native composer skin matched host geometry, cutouts stayed exposed, optimized prompt committed.`);
} finally {
  if (client) client.close();
  chrome.kill("SIGTERM");
  server.close();
  await delay(250);
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function startFixtureServer() {
  const html = await readFile(fixturePath, "utf8");
  const selfOptOutHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="prism-extension" content="disabled">
    <title>Prism Self Opt Out</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111016; }
      textarea { width: min(720px, calc(100vw - 48px)); min-height: 140px; padding: 18px; border-radius: 12px; }
    </style>
  </head>
  <body>
    <textarea data-testid="self-prompt">This first-party prompt field should stay native.</textarea>
  </body>
</html>`;
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url === "/chat") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url?.startsWith("/shape/")) {
      const name = decodeURIComponent(request.url.split("/").pop() || "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(providerShapeFixtureHtml(name));
      return;
    }
    if (request.url === "/prism-self-opt-out") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(selfOptOutHtml);
      return;
    }
    if (request.url === "/append-risk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(contenteditableAppendRiskFixtureHtml());
      return;
    }
    if (request.url === "/perplexity-append-risk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(contenteditableAppendRiskFixtureHtml({ provider: "perplexity", title: "Prism Perplexity Append Risk Fixture", perplexityShape: true }));
      return;
    }
    if (request.url === "/kimi-div-send-risk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(contenteditableAppendRiskFixtureHtml({ provider: "kimi", title: "Prism Kimi Div Send Fixture", sendMode: "kimi-div" }));
      return;
    }
    if (request.url === "/kimi-trusted-send-risk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(contenteditableAppendRiskFixtureHtml({ provider: "kimi", title: "Prism Kimi Trusted Send Fixture", sendMode: "kimi-trusted" }));
      return;
    }
    if (request.url === "/window-capture-send-risk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(contenteditableAppendRiskFixtureHtml({ provider: "kimi", title: "Prism Window Capture Send Fixture", sendMode: "window-capture" }));
      return;
    }
    if (request.url === "/no-prompt-gallery") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(noPromptGalleryFixtureHtml());
      return;
    }
    if (request.url === "/homepage-prompt") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(homepagePromptFixtureHtml());
      return;
    }
    if (request.url === "/scroll-tracking") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(scrollTrackingFixtureHtml());
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  return {
    url: `http://localhost:${address.port}/chat`,
    shapeUrl: (name) => `http://localhost:${address.port}/shape/${encodeURIComponent(name)}`,
    appendRiskUrl: `http://localhost:${address.port}/append-risk`,
    perplexityAppendRiskUrl: `http://localhost:${address.port}/perplexity-append-risk`,
    kimiDivSendRiskUrl: `http://localhost:${address.port}/kimi-div-send-risk`,
    kimiTrustedSendRiskUrl: `http://localhost:${address.port}/kimi-trusted-send-risk`,
    windowCaptureSendRiskUrl: `http://localhost:${address.port}/window-capture-send-risk`,
    noPromptGalleryUrl: `http://localhost:${address.port}/no-prompt-gallery`,
    homepagePromptUrl: `http://localhost:${address.port}/homepage-prompt`,
    scrollTrackingUrl: `http://localhost:${address.port}/scroll-tracking`,
    selfOptOutUrl: `http://localhost:${address.port}/prism-self-opt-out`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

function contenteditableAppendRiskFixtureHtml({ provider = "claude", title = "Prism Contenteditable Append Risk Fixture", perplexityShape = false, sendMode = "button" } = {}) {
  const isKimiLike = sendMode === "kimi-div" || sendMode === "kimi-trusted";
  const requiresTrustedNativeSend = sendMode === "kimi-trusted" || !!perplexityShape;
  const blocksUntrustedSend = !!perplexityShape || isKimiLike || sendMode === "window-capture";
  const modelBackedSend = !!perplexityShape || isKimiLike || sendMode === "window-capture";
  const appendOnlyModel = sendMode === "kimi-div";
  const editorClass = isKimiLike
    ? "chat-input-editor prompt"
    : perplexityShape
    ? "overflow-auto max-h-[45vh] lg:max-h-[40vh] sm:max-h-[25vh] outline-none font-sans resize-none caret-super selection:bg-super/30"
    : "prompt";
  const sendAria = perplexityShape ? "Submit" : "Send";
  const sendControl = isKimiLike || sendMode === "window-capture"
    ? `<div class="send-button-container" aria-hidden="true"><span>go</span></div>`
    : `<button class="send" type="button" aria-label="${sendAria}">go</button>`;
  return `<!doctype html>
<html lang="en" data-prism-provider="${escapeHtml(provider)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: end center;
        padding: 40px;
        color: #f6f3ff;
        background: #08080d;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .composer {
        position: relative;
        width: min(820px, calc(100vw - 64px));
        min-height: 86px;
        border-radius: 24px;
        background: rgba(31, 30, 38, 0.98);
        overflow: hidden;
      }
      .composer[data-perplexity-shape="true"] {
        display: grid;
        grid-template-rows: 1fr auto;
        width: min(640px, calc(100vw - 64px));
        min-height: 96px;
        padding: 16px 12px 12px;
        border-radius: 16px;
        background: rgba(32, 34, 38, 0.98);
      }
      .prompt {
        width: 100%;
        min-height: 86px;
        padding: 24px 86px 24px 28px;
        outline: none;
        white-space: pre-wrap;
        line-height: 1.4;
      }
      .prompt:empty::before {
        content: attr(data-placeholder);
        color: rgba(255, 255, 255, 0.46);
      }
      .composer[data-perplexity-shape="true"] .prompt,
      .composer[data-perplexity-shape="true"] [role="textbox"] {
        min-height: 84px;
        max-height: 240px;
        padding: 0 10px 8px;
        overflow: auto;
        outline: none;
        white-space: pre-wrap;
        line-height: 1.45;
      }
      .toolbar {
        display: none;
      }
      .composer[data-perplexity-shape="true"] .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .composer[data-perplexity-shape="true"] .tool {
        position: static;
        width: auto;
        min-width: 32px;
        height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        color: white;
        background: rgba(255, 255, 255, 0.08);
      }
      .send {
        position: absolute;
        right: 18px;
        bottom: 18px;
        width: 48px;
        height: 48px;
        border: 0;
        border-radius: 24px;
        color: white;
        background: rgba(255, 255, 255, 0.12);
        font: inherit;
      }
      .send-button-container {
        position: absolute;
        right: 18px;
        bottom: 18px;
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: 24px;
        color: white;
        background: rgba(255, 255, 255, 0.12);
        cursor: pointer;
      }
      .composer[data-perplexity-shape="true"] .send {
        position: static;
        margin-left: auto;
        width: 32px;
        height: 32px;
      }
      .send:disabled {
        opacity: 0.42;
      }
    </style>
  </head>
  <body>
    <section class="composer" data-perplexity-shape="${String(!!perplexityShape)}">
      <div class="${escapeHtml(editorClass)}" data-testid="prompt" role="textbox" ${isKimiLike ? `aria-multiline="false" data-lexical-editor="true"` : (perplexityShape ? `data-lexical-editor="true"` : "")} contenteditable="true" data-placeholder="Message ${escapeHtml(provider)}"></div>
      ${perplexityShape ? `<div class="toolbar" aria-label="Perplexity tools">
        <button class="tool" type="button" aria-label="Add files or tools">+</button>
        <button class="tool" type="button">Search</button>
        <button class="tool" type="button" aria-label="Computer">Computer</button>
        <button class="tool" type="button" aria-label="Model">Model</button>
        <button class="tool" type="button" aria-label="Dictation">mic</button>
        <button class="send" type="button" aria-label="${sendAria}">go</button>
      </div>` : sendControl}
    </section>
    <script>
      const prompt = document.querySelector('[data-testid="prompt"]');
      const send = document.querySelector(".send, .send-button-container");
      const state = {
        provider: ${JSON.stringify(provider)},
        model: "",
        sent: [],
        sentEvents: [],
        events: []
      };
      function recordEvent(event, extra = {}) {
        state.events.push({
          inputType: event.inputType || event.type || "",
          dataLength: event.data == null ? 0 : String(event.data).length,
          trusted: !!event.isTrusted,
          beforeLength: extra.beforeLength ?? state.model.length,
          afterLength: extra.afterLength ?? state.model.length,
          taskCount: (state.model.match(/Task:/g) || []).length,
          outputCount: (state.model.match(/Output:/g) || []).length,
          earthquakeCount: (state.model.match(/earthquakes/gi) || []).length,
          ...extra
        });
      }
      function readPrompt() {
        return (prompt.innerText || prompt.textContent || "").replace(/\\u00a0/g, " ").trim();
      }
      function sendNow(event) {
        if (${JSON.stringify(blocksUntrustedSend)} && event && !event.isTrusted) {
          if (${JSON.stringify(requiresTrustedNativeSend)}) {
            recordEvent(event, { blockedUntrustedSend: true, requiresTrustedNativeSend: true });
            return;
          }
          const currentPrompt = readPrompt();
          const safeDeferredPrismSend =
            state.model &&
            state.model === currentPrompt &&
            !/^Please tell me how many earthquakes there are yearly$/i.test(state.model) &&
            /^How many earthquakes occur each year\\s+Output: direct, concise, complete$/i.test(state.model);
          if (!safeDeferredPrismSend) {
            recordEvent(event, { blockedUntrustedSend: true });
            return;
          }
        }
        state.sent.push(${JSON.stringify(modelBackedSend)} ? state.model : readPrompt());
        state.sentEvents.push({ trusted: !!event?.isTrusted, type: event?.type || "" });
        state.model = "";
        prompt.textContent = "";
      }
      function renderModel() {
        if (readPrompt() !== state.model) prompt.textContent = state.model;
        if ("disabled" in send) {
          send.disabled = state.model.length > 2000;
          if (send.disabled) send.setAttribute("aria-label", "Query is too long");
          else send.setAttribute("aria-label", ${JSON.stringify(sendAria)});
        }
      }
      ${perplexityShape ? `function lexicalStateText(node) {
        if (!node) return "";
        if (typeof node.text === "string") return node.text;
        return (node.children || []).map(lexicalStateText).join("\\n").replace(/\\n+/g, "\\n").trim();
      }
      prompt.__lexicalEditor = {
        parseEditorState(json) {
          return JSON.parse(json);
        },
        setEditorState(nextState) {
          const before = state.model;
          state.model = lexicalStateText(nextState.root);
          renderModel();
          recordEvent({ type: "lexicalBridge", inputType: "lexicalBridge", isTrusted: true }, {
            lexicalBridgeSet: true,
            beforeLength: before.length,
            afterLength: state.model.length,
            taskCount: (state.model.match(/Task:/g) || []).length,
            outputCount: (state.model.match(/Output:/g) || []).length,
            earthquakeCount: (state.model.match(/earthquakes/gi) || []).length
          });
        },
        focus() {
          prompt.focus();
        }
      };` : ""}
      function delayedKimiTrustedSync(event, before) {
        const sentGeneration = state.sent.length;
        setTimeout(() => {
          if (state.sent.length !== sentGeneration) {
            recordEvent(event, { skippedAfterSend: true });
            return;
          }
          const nextModel = readPrompt();
          state.model = nextModel;
          renderModel();
          recordEvent(event, {
            delayedKimiTrustedSync: true,
            beforeLength: before.length,
            afterLength: nextModel.length,
            taskCount: (nextModel.match(/Task:/g) || []).length,
            outputCount: (nextModel.match(/Output:/g) || []).length,
            earthquakeCount: (nextModel.match(/earthquakes/gi) || []).length
          });
        }, 420);
      }
      ${perplexityShape ? `prompt.addEventListener("paste", (event) => {
        const data = event.clipboardData?.getData("text/plain") || "";
        if (!data) return;
        event.preventDefault();
        const staleModel = state.model + data;
        recordEvent(event, {
          inputType: "paste",
          dataLength: data.length,
          beforeLength: state.model.length,
          afterLength: staleModel.length,
          taskCount: (staleModel.match(/Task:/g) || []).length,
          outputCount: (staleModel.match(/Output:/g) || []).length
        });
        setTimeout(() => {
          state.model = staleModel;
          renderModel();
        }, 120);
      });` : ""}
      prompt.addEventListener("input", (event) => {
        const data = event.data == null ? null : String(event.data);
        const before = state.model;
        if (${JSON.stringify(perplexityShape)} && event.inputType === "insertReplacementText") {
          state.model += readPrompt();
          renderModel();
        } else if (${JSON.stringify(sendMode === "kimi-div")} && event.inputType === "insertText" && data && data.includes("\\n")) {
          recordEvent(event, {
            rejectedMultilineInsert: true,
            beforeLength: before.length,
            afterLength: state.model.length,
            taskCount: (state.model.match(/Task:/g) || []).length,
            outputCount: (state.model.match(/Output:/g) || []).length,
            earthquakeCount: (state.model.match(/earthquakes/gi) || []).length
          });
          renderModel();
        } else if (${JSON.stringify(sendMode === "kimi-div")} && event.inputType === "insertText" && /\\bOutput:\\s*direct, concise, complete\\b/i.test(data || "")) {
          const nextModel = readPrompt();
          state.model = nextModel;
          renderModel();
          recordEvent(event, {
            optimizedModelSync: true,
            beforeLength: before.length,
            afterLength: nextModel.length,
            taskCount: (nextModel.match(/Task:/g) || []).length,
            outputCount: (nextModel.match(/Output:/g) || []).length,
            earthquakeCount: (nextModel.match(/earthquakes/gi) || []).length
          });
        } else if (${JSON.stringify(sendMode === "kimi-div")} && event.inputType === "insertText" && data) {
          state.model = readPrompt();
          renderModel();
        } else if (${JSON.stringify(modelBackedSend)} && /^delete/.test(event.inputType || "")) {
          if (${JSON.stringify(appendOnlyModel)}) {
            recordEvent(event, {
              appendOnlyDeleteIgnored: true,
              beforeLength: before.length,
              afterLength: state.model.length,
              taskCount: (state.model.match(/Task:/g) || []).length,
              outputCount: (state.model.match(/Output:/g) || []).length,
              earthquakeCount: (state.model.match(/earthquakes/gi) || []).length
            });
          } else {
          state.model = "";
            renderModel();
          }
        } else if (${JSON.stringify(sendMode === "kimi-trusted")} && event.inputType === "insertReplacementText" && data == null) {
          delayedKimiTrustedSync(event, before);
        } else if ((event.inputType === "insertReplacementText" || event.inputType === "insertText") && data) {
          state.model += data;
          renderModel();
        } else if (${JSON.stringify(sendMode === "kimi-div")} && !event.inputType) {
          renderModel();
        } else if (${JSON.stringify(sendMode === "kimi-trusted")} && !event.inputType) {
          delayedKimiTrustedSync(event, before);
        } else if (${JSON.stringify(perplexityShape)} && !event.inputType) {
          const nextModel = readPrompt();
          setTimeout(() => {
            state.model = nextModel;
            renderModel();
            recordEvent(event, {
              delayedPlainSync: true,
              beforeLength: before.length,
              afterLength: state.model.length,
              taskCount: (state.model.match(/Task:/g) || []).length,
              outputCount: (state.model.match(/Output:/g) || []).length,
              earthquakeCount: (state.model.match(/earthquakes/gi) || []).length
            });
          }, 180);
        } else {
          state.model = readPrompt();
        }
        recordEvent(event, {
          beforeLength: before.length,
          afterLength: state.model.length,
          taskCount: (state.model.match(/Task:/g) || []).length,
          outputCount: (state.model.match(/Output:/g) || []).length
        });
      });
      prompt.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        sendNow(event);
      });
      ${sendMode === "window-capture" ? `setTimeout(() => {
        window.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          sendNow(event);
        }, true);
        state.windowCaptureReady = true;
      }, 250);` : ""}
      send.addEventListener("click", sendNow);
      window.__appendRisk = {
        state,
        readPrompt
      };
    </script>
  </body>
</html>`;
}

function providerShapeCases() {
  return [
    { name: "chatgpt-tall", label: "ChatGPT multiline", width: 920, grownHeight: 292, radius: 34, editor: "textarea" },
    { name: "chatgpt-wide-wrapper", label: "ChatGPT wide wrapper", width: 980, surfaceWidth: 500, grownHeight: 216, radius: 28, editor: "textarea", provider: "chatgpt", targetSelector: ".input-surface", wideWrapper: true },
    { name: "gemini-tall", label: "Gemini multiline", width: 980, grownHeight: 236, radius: 30, editor: "textarea" },
    { name: "claude-rect", label: "Claude multiline", width: 760, grownHeight: 212, radius: 18, editor: "contenteditable" },
    { name: "claude-skills-row", label: "Claude skills row", width: 920, grownHeight: 168, radius: 28, editor: "contenteditable", targetSelector: ".input-surface", hasDetachedChips: true },
    { name: "perplexity-box", label: "Perplexity multiline", width: 900, grownHeight: 248, radius: 26, editor: "textarea" },
    { name: "grok-rounded", label: "Grok multiline", width: 860, grownHeight: 224, radius: 28, editor: "textarea" },
    { name: "kimi-contenteditable", label: "Kimi contenteditable", width: 860, grownHeight: 220, radius: 24, editor: "contenteditable", provider: "kimi" },
    { name: "generic-visual-controls", label: "Generic visual controls", width: 920, grownHeight: 216, radius: 30, editor: "contenteditable", visualToolbar: true, expectedVisualHoles: 5 }
  ];
}

function noPromptGalleryFixtureHtml() {
  const cards = Array.from({ length: 12 }, (_, i) => `
        <article class="card">
          <div class="thumb"></div>
          <h2>${escapeHtml(["Build Linux System", "Wool Sneakers", "GenAI Video Report", "Smoke, Amber, Ritual"][i % 4])}</h2>
          <p>Kimi · ${8728 + i * 4103}</p>
        </article>`).join("");
  return `<!doctype html>
<html lang="en" data-prism-provider="kimi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Kimi Inspiration Gallery</title>
    <style>
      body {
        margin: 0;
        min-height: 180vh;
        color: #e8e4ef;
        background: #111;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      nav {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        gap: 48px;
        padding: 56px 96px 32px;
        color: rgba(255,255,255,0.48);
        background: #111;
        font-size: 24px;
      }
      nav strong { color: white; }
      main {
        display: grid;
        grid-template-columns: repeat(3, minmax(240px, 1fr));
        gap: 42px 38px;
        max-width: 1320px;
        margin: 0 auto;
        padding: 16px 64px 120px;
      }
      .card { min-width: 0; }
      .thumb {
        height: 210px;
        border-radius: 18px;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.18), transparent 50%),
          linear-gradient(120deg, #252b3a, #80533f 45%, #34244f);
        border: 1px solid rgba(255,255,255,0.1);
      }
      h2 { margin: 18px 0 12px; font-size: 23px; font-weight: 500; }
      p { margin: 0; color: rgba(255,255,255,0.45); font-size: 18px; }
      .chat-editor {
        position: relative;
        z-index: 1;
        width: min(768px, calc(100vw - 96px));
        height: 130px;
        margin: 10px auto 34px;
        border-radius: 24px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgb(31,31,31);
      }
      .chat-input-editor {
        width: 100%;
        min-height: 60px;
        box-sizing: border-box;
        padding: 24px 132px 20px 28px;
        outline: none;
        color: white;
      }
      .chat-input-editor:empty::before { content: "Type / to quickly access skills"; color: rgba(255,255,255,0.44); }
      .agent-pill, .send-dot {
        position: absolute;
        bottom: 18px;
        height: 34px;
        border-radius: 18px;
        background: rgba(255,255,255,0.1);
      }
      .agent-pill { left: 28px; width: 84px; }
      .send-dot { right: 22px; width: 34px; }
    </style>
  </head>
  <body>
    <nav><strong>Inspiration</strong><span>Web App</span><span>Mobile App</span><span>Data visualization</span><span>Back to Home</span></nav>
    <section class="chat-editor">
      <div class="chat-input-editor" role="textbox" contenteditable="true"></div>
      <div class="agent-pill"></div>
      <button class="send-dot" type="button" aria-label="Send"></button>
    </section>
    <main>${cards}</main>
  </body>
</html>`;
}

function homepagePromptFixtureHtml() {
  return `<!doctype html>
<html lang="en" data-prism-provider="chatgpt">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ChatGPT Homepage Prompt</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: #f5f2ff;
        background: #050509;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      h1 {
        margin: 58px 0 0;
        text-align: center;
        font-size: 34px;
        font-weight: 500;
      }
      .composer-wrap {
        position: fixed;
        left: 50%;
        top: 168px;
        width: min(860px, calc(100vw - 32px));
        transform: translateX(-50%) translateY(260px);
        transition: transform 180ms ease;
      }
      body[data-settled="true"] .composer-wrap {
        transform: translateX(-50%) translateY(0);
      }
      .composer {
        position: relative;
        height: 88px;
        border-radius: 34px;
        background: rgba(30, 28, 38, 0.96);
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
      }
      textarea {
        width: 100%;
        height: 88px;
        padding: 24px 190px 18px 82px;
        border: 0;
        outline: none;
        resize: none;
        color: #ffffff;
        background: transparent;
        font: inherit;
        font-size: 18px;
      }
      button {
        position: absolute;
        top: 18px;
        height: 52px;
        border: 0;
        color: white;
        background: rgba(255, 255, 255, 0.08);
        font: inherit;
      }
      .plus { left: 14px; width: 52px; border-radius: 50%; font-size: 26px; }
      .voice { right: 66px; width: 52px; border-radius: 26px; }
      .send { right: 14px; width: 44px; border-radius: 22px; }
    </style>
  </head>
  <body>
    <h1>Ready when you are.</h1>
    <section class="composer-wrap">
      <div class="composer" data-testid="homepage-composer">
        <button class="plus" type="button" aria-label="Attach">+</button>
        <textarea id="prompt-textarea" data-testid="prompt-textarea" placeholder="Ask anything"></textarea>
        <button class="voice" type="button" aria-label="Voice">mic</button>
        <button class="send" type="button" aria-label="Send">go</button>
      </div>
    </section>
    <script>
      window.__settleHomepagePrompt = () => {
        document.body.dataset.settled = "true";
      };
    </script>
  </body>
</html>`;
}

function scrollTrackingFixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Prism Scroll Tracking Fixture</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 40px;
        color: #f6f3ff;
        background: #08080d;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .composer {
        position: relative;
        width: min(820px, calc(100vw - 64px));
        height: 88px;
        border-radius: 28px;
        background: rgba(31, 30, 38, 0.98);
        will-change: transform;
      }
      textarea {
        width: 100%;
        height: 100%;
        padding: 24px 164px 22px 72px;
        border: 0;
        outline: none;
        resize: none;
        color: white;
        background: transparent;
        font: inherit;
        font-size: 18px;
      }
      button {
        position: absolute;
        top: 18px;
        height: 52px;
        border: 0;
        color: white;
        background: rgba(255,255,255,0.1);
      }
      .attach { left: 14px; width: 52px; border-radius: 26px; }
      .send { right: 16px; width: 52px; border-radius: 26px; }
    </style>
  </head>
  <body>
    <section class="composer" data-testid="moving-composer">
      <button class="attach" type="button" aria-label="Attach">+</button>
      <textarea data-testid="prompt" placeholder="Ask anything"></textarea>
      <button class="send" type="button" aria-label="Send">go</button>
    </section>
    <script>
      window.__moveComposer = (dy) => {
        document.querySelector('[data-testid="moving-composer"]').style.transform = 'translateY(' + dy + 'px)';
      };
    </script>
  </body>
</html>`;
}

function providerShapeFixtureHtml(name) {
  const shape = providerShapeCases().find((candidate) => candidate.name === name) || providerShapeCases()[0];
  const editor = shape.editor === "contenteditable"
    ? `<div class="prompt" data-testid="prompt" role="textbox" contenteditable="true" aria-label="Message ${escapeHtml(shape.label)}"></div>`
    : `<textarea class="prompt" data-testid="prompt" placeholder="Message ${escapeHtml(shape.label)}"></textarea>`;
  const controls = shape.visualToolbar
    ? `
          <div class="visual-control visual-attach" tabindex="0" aria-label="Attach">
            <span class="visual-fragment" role="button" aria-label="Attach icon">+</span>
          </div>
          <div class="visual-control visual-tool" tabindex="0" aria-label="Tool">
            <span class="visual-fragment" role="button" aria-label="Tool icon">□</span>
            <span>Tool</span>
          </div>
          <div class="visual-control visual-model" tabindex="0" aria-haspopup="menu">
            <span>Model</span>
            <span class="visual-fragment visual-caret" role="button" aria-label="Open model menu">⌄</span>
          </div>
          <div class="visual-control visual-extra" tabindex="0" aria-label="New feature">
            <span class="visual-fragment" role="button" aria-label="Feature icon">○</span>
          </div>
          <div class="visual-control visual-send" tabindex="0" aria-label="Send">
            <span class="visual-fragment" role="button" aria-label="Send icon">↑</span>
          </div>`
    : `
          <button class="attach" type="button" aria-label="Attach">+</button>
          <button class="model" type="button" aria-label="Model">Model</button>
          <button class="voice" type="button" aria-label="Voice">mic</button>
          <button class="send" type="button" aria-label="Send">go</button>`;
  return `<!doctype html>
<html lang="en"${shape.provider ? ` data-prism-provider="${escapeHtml(shape.provider)}"` : ""}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(shape.label)} Fixture</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: end center;
        padding: 32px;
        color: #f4f1ff;
        background: #08080d;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .composer-wrap { width: min(${shape.width}px, calc(100vw - 64px)); }
      .composer {
        position: relative;
        height: ${shape.hasDetachedChips ? shape.grownHeight + 92 : 76}px;
        min-height: 76px;
        border-radius: ${shape.hasDetachedChips || shape.wideWrapper ? 0 : shape.radius}px;
        background: ${shape.hasDetachedChips || shape.wideWrapper ? "transparent" : "rgba(32, 32, 38, 0.98)"};
        overflow: visible;
      }
      .input-surface {
        position: relative;
        width: ${shape.surfaceWidth ? `min(${shape.surfaceWidth}px, 100%)` : "100%"};
        margin: ${shape.wideWrapper ? "0 auto" : "0"};
        height: 76px;
        min-height: 76px;
        border-radius: ${shape.radius}px;
        background: rgba(32, 32, 38, 0.98);
        overflow: hidden;
      }
      .prompt {
        display: block;
        width: 100%;
        min-height: 76px;
        height: 76px;
        padding: 22px ${shape.visualToolbar ? 340 : 172}px 18px ${shape.visualToolbar ? 224 : 86}px;
        border: 0;
        outline: none;
        resize: none;
        color: white;
        background: transparent;
        font: inherit;
        font-size: 17px;
        line-height: 1.35;
        white-space: pre-wrap;
      }
      button {
        position: absolute;
        top: 14px;
        height: 48px;
        border: 0;
        color: white;
        background: rgba(255, 255, 255, 0.08);
        font: inherit;
      }
      .attach { left: 14px; width: 48px; border-radius: 24px; font-size: 24px; }
      .model { right: 112px; width: 126px; border-radius: 24px; }
      .voice { right: 62px; width: 44px; border-radius: 22px; }
      .send { right: 12px; width: 44px; border-radius: 22px; }
      .visual-control {
        position: absolute;
        top: 14px;
        height: 48px;
        border-radius: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: white;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.08);
        cursor: pointer;
        font: inherit;
      }
      .visual-attach { left: 14px; width: 48px; }
      .visual-tool { left: 72px; width: 132px; justify-content: flex-start; padding: 0 16px 0 10px; }
      .visual-model { right: 112px; width: 150px; }
      .visual-extra { right: 62px; width: 44px; }
      .visual-send { right: 12px; width: 44px; }
      .visual-fragment {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 15px;
        color: rgba(255, 255, 255, 0.92);
        background: rgba(0, 0, 0, 0.14);
      }
      .visual-caret {
        width: 22px;
        background: transparent;
      }
      .composer[data-grown="true"] .prompt {
        height: ${shape.grownHeight}px;
        padding-top: 24px;
        padding-bottom: 88px;
      }
      .composer[data-grown="true"] .input-surface {
        height: ${shape.grownHeight}px;
      }
      .composer[data-grown="true"] button,
      .composer[data-grown="true"] .visual-control {
        top: auto;
        bottom: 14px;
      }
      .chips {
        display: ${shape.hasDetachedChips ? "flex" : "none"};
        gap: 10px;
        justify-content: center;
        margin-top: 18px;
      }
      .chips button {
        position: static;
        width: auto;
        min-width: 112px;
        padding: 0 24px;
        border-radius: 20px;
      }
    </style>
  </head>
  <body>
    <section class="composer-wrap">
      <div class="composer" data-provider-shape="${escapeHtml(shape.name)}">
        <div class="input-surface">
          ${editor}
          ${controls}
        </div>
        <div class="chips" aria-label="Claude skills">
          <button type="button">Write</button>
          <button type="button">Learn</button>
          <button type="button">Code</button>
          <button type="button">Life stuff</button>
        </div>
      </div>
    </section>
    <script>
      const composer = document.querySelector(".composer");
      const inputSurface = document.querySelector(".input-surface");
      const prompt = document.querySelector('[data-testid="prompt"]');
      function value() {
        return prompt.tagName === "TEXTAREA" ? prompt.value : prompt.textContent;
      }
      function resizeComposer() {
        const grown = value().split("\\n").length >= 5;
        composer.dataset.grown = String(grown);
        inputSurface.style.height = grown ? "${shape.grownHeight}px" : "76px";
        composer.style.height = grown ? "${shape.hasDetachedChips ? shape.grownHeight + 92 : shape.grownHeight}px" : "${shape.hasDetachedChips ? 168 : 76}px";
      }
      prompt.addEventListener("input", resizeComposer);
      resizeComposer();
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function assertProviderShape(client, url, shape, injectionMode) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  await evaluate(client, `
    (() => {
      const field = document.querySelector('[data-testid="prompt"]');
      const value = ["k", "k", "k", "k", "k", "k", "k", "k"].join("\\n");
      field.focus();
      if (field.tagName === "TEXTAREA") field.value = value;
      else field.textContent = value;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: '\\n' }));
      return true;
    })();
  `);
  await waitForEval(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const host = document.querySelector(${JSON.stringify(shape.targetSelector || ".composer")}).getBoundingClientRect();
    return host.height > 120 &&
      Math.abs(root.left - host.left) <= 2 &&
      Math.abs(root.top - host.top) <= 2 &&
      Math.abs(root.width - host.width) <= 2 &&
      Math.abs(root.height - host.height) <= 2;
  })()`);
  const result = await evaluate(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const host = document.querySelector(${JSON.stringify(shape.targetSelector || ".composer")});
    const hostRect = host.getBoundingClientRect();
    const skin = document.querySelector('.prism-skin-svg > rect[mask]');
    const maskBase = document.querySelector('.prism-skin-svg mask rect');
    const hostRadius = parseFloat(getComputedStyle(host).borderTopLeftRadius || getComputedStyle(host).borderRadius) || 0;
    const skinRx = Number(skin.getAttribute('rx'));
    const maskRx = Number(maskBase.getAttribute('rx'));
    const svgRect = document.querySelector('.prism-skin-svg').getBoundingClientRect();
    return {
      name: ${JSON.stringify(shape.name)},
      hostRadius,
      skinRx,
      maskRx,
      rootHeight: Math.round(root.height),
      hostHeight: Math.round(hostRect.height),
      radiusRatio: skinRx / Math.max(1, root.height),
      tracksHost:
        Math.abs(root.left - hostRect.left) <= 2 &&
        Math.abs(root.top - hostRect.top) <= 2 &&
        Math.abs(root.width - hostRect.width) <= 2 &&
        Math.abs(root.height - hostRect.height) <= 2,
      svgTracksRoot: Math.abs(svgRect.width - root.width) <= 2 && Math.abs(svgRect.height - root.height) <= 2
    };
  })()`);
  assert(result.tracksHost, `${shape.name}: Prism skin should track native host bounds ${JSON.stringify(result)}`);
  assert(result.svgTracksRoot, `${shape.name}: SVG skin should track Prism bounds ${JSON.stringify(result)}`);
  assert(Math.abs(result.skinRx - shape.radius) <= 1, `${shape.name}: skin radius should match native radius ${JSON.stringify(result)}`);
  assert(Math.abs(result.maskRx - result.skinRx) <= 1, `${shape.name}: mask radius should match skin radius ${JSON.stringify(result)}`);
  assert(result.radiusRatio < 0.35, `${shape.name}: expanded skin should not become a pill ${JSON.stringify(result)}`);
  if (shape.visualToolbar) {
    const visualResult = await evaluate(client, `(() => {
      const root = document.querySelector('.prism-composer').getBoundingClientRect();
      const holes = [...document.querySelectorAll('.prism-skin-svg mask rect')]
        .filter((rect) => rect.getAttribute('fill') === 'black')
        .map((rect) => ({
          x: Number(rect.getAttribute('x')),
          y: Number(rect.getAttribute('y')),
          w: Number(rect.getAttribute('width')),
          h: Number(rect.getAttribute('height')),
          rx: Number(rect.getAttribute('rx')),
        }));
      return {
        holes,
        holeCount: holes.length,
        hasAttachSurface: holes.some((h) => h.x <= 18 && h.w >= 48 && h.h >= 48),
        hasWideToolSurface: holes.some((h) => h.x >= 64 && h.x <= 78 && h.w >= 126 && h.h >= 48),
        rightSurfaceCount: holes.filter((h) => h.x > root.width * 0.55 && h.w >= 42 && h.h >= 42).length,
        tinyLeftFragmentCount: holes.filter((h) => h.x < root.width * 0.28 && h.w < 42 && h.h < 42).length,
        roundedSurfaceCount: holes.filter((h) => h.rx >= 18).length,
      };
    })()`);
    assert(visualResult.hasAttachSurface, `${shape.name}: unknown visual attach surface should be cut as one full hole ${JSON.stringify(visualResult)}`);
    assert(visualResult.hasWideToolSurface, `${shape.name}: unknown visual pill surface should be cut as one full hole ${JSON.stringify(visualResult)}`);
    assert(visualResult.rightSurfaceCount >= 3, `${shape.name}: unknown right-side visual controls should stay exposed ${JSON.stringify(visualResult)}`);
    assert(visualResult.tinyLeftFragmentCount === 0, `${shape.name}: nested icon fragments should not become separate holes ${JSON.stringify(visualResult)}`);
    assert(visualResult.holeCount <= shape.expectedVisualHoles + 1, `${shape.name}: visual control discovery should not create duplicate holes ${JSON.stringify(visualResult)}`);
    assert(visualResult.roundedSurfaceCount >= shape.expectedVisualHoles - 1, `${shape.name}: holes should preserve visual surface radius ${JSON.stringify(visualResult)}`);
    Object.assign(result, visualResult);
  }
  const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(resolve(qaDir, `provider-shape-${shape.name}.png`), Buffer.from(screenshot.data, "base64"));
  return result;
}

async function assertPromptStaysRawWhileTyping(client, prompt, label) {
  await delay(1200);
  const result = await evaluate(client, `(() => {
    const currentPrompt = window.__appendRisk.readPrompt();
    const model = window.__appendRisk.state.model;
    return {
      currentPrompt,
      model,
      sentCount: window.__appendRisk.state.sent.length,
      currentOutputCount: (currentPrompt.match(/Output:/g) || []).length,
      modelOutputCount: (model.match(/Output:/g) || []).length,
      rawPromptVisible: currentPrompt === ${JSON.stringify(prompt)},
      rawModel: model === ${JSON.stringify(prompt)}
    };
  })()`);
  assert(result.sentCount === 0, `${label}: typing should not send before the user presses Enter/send ${JSON.stringify(result)}`);
  assert(result.rawPromptVisible && result.rawModel, `${label}: Prism must not replace the user's native prompt while they are still typing ${JSON.stringify(result)}`);
  assert(result.currentOutputCount === 0 && result.modelOutputCount === 0, `${label}: output guidance should only be inserted on send or explicit preview adoption ${JSON.stringify(result)}`);
}

async function assertContenteditableAppendRisk(client, url, injectionMode, sendSelector = ".send", options = {}) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const prompt = "Please tell me how many earthquakes there are yearly";
  await clickCenter(client, '[data-testid="prompt"]');
  await client.send("Input.insertText", { text: prompt });
  await waitForEval(client, "window.__appendRisk?.state.model.includes('earthquakes')");
  await assertPromptStaysRawWhileTyping(client, prompt, "contenteditable click-send");
  await clickCenter(client, sendSelector);
  await delay(1800);
  const result = await evaluate(client, `(() => {
    const sent = window.__appendRisk.state.sent[0] || "";
    const currentPrompt = window.__appendRisk.readPrompt();
    const dangerousReplacementEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertReplacementText" && event.dataLength > 0);
    const dangerousInsertEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertText" && event.earthquakeCount > 1);
    const blockedSends = window.__appendRisk.state.events.filter((event) => event.blockedUntrustedSend);
    return {
      sent,
      provider: window.__appendRisk.state.provider,
      sentTrusted: window.__appendRisk.state.sentEvents[0]?.trusted ?? null,
      sentEventType: window.__appendRisk.state.sentEvents[0]?.type || "",
      currentPrompt,
      sentCount: window.__appendRisk.state.sent.length,
	      sentLength: sent.length,
	      badgeVisible: !!(document.querySelector('.prism-badge')?.offsetWidth || document.querySelector('.prism-badge')?.offsetHeight || document.querySelector('.prism-badge')?.getClientRects?.().length),
	      composerVisible: getComputedStyle(document.querySelector('.prism-composer')).display !== 'none',
	      taskCount: (sent.match(/Task:/g) || []).length,
      outputCount: (sent.match(/Output:/g) || []).length,
      earthquakeCount: (sent.match(/earthquakes/gi) || []).length,
      currentTaskCount: (currentPrompt.match(/Task:/g) || []).length,
      currentOutputCount: (currentPrompt.match(/Output:/g) || []).length,
      currentEarthquakeCount: (currentPrompt.match(/earthquakes/gi) || []).length,
      dangerousReplacementEventCount: dangerousReplacementEvents.length,
      dangerousInsertEventCount: dangerousInsertEvents.length,
      blockedUntrustedSendCount: blockedSends.length,
      dangerousReplacementEvents,
      dangerousInsertEvents,
      events: window.__appendRisk.state.events
    };
  })()`);
  assert(result.sentCount === 1, `contenteditable send should submit exactly once after Prism optimization ${JSON.stringify(result)}`);
  assert(EARTHQUAKE_OPTIMIZED_FLEX_PATTERN.test(result.sent), `contenteditable send should submit the compact optimized prompt with output guidance, not the original or a template ${JSON.stringify(result)}`);
  assert(result.earthquakeCount === 1, `contenteditable send should commit exactly one optimized earthquake prompt, not repeated blocks ${JSON.stringify(result)}`);
  assert(result.outputCount === 1 && result.taskCount === 0, `contenteditable send should include exactly one output guidance line without template bloat ${JSON.stringify(result)}`);
	  assert(result.currentEarthquakeCount === 0 && result.currentTaskCount === 0 && result.currentOutputCount === 0, `contenteditable field should be cleared after native send ${JSON.stringify(result)}`);
	  assert(result.badgeVisible && result.composerVisible, `Prism layer and icon should stay visible on the empty follow-up composer ${JSON.stringify(result)}`);
	  assert(result.dangerousReplacementEventCount === 0, `contenteditable replacement events should not expose full prompt data to append-prone host editors ${JSON.stringify(result)}`);
  assert(result.dangerousInsertEventCount === 0, `contenteditable insertText events should not create repeated optimized blocks before send ${JSON.stringify(result)}`);
  if (options.requiresTrustedNativeSend) {
    assert(result.sentTrusted === true, `trusted-only contenteditable send must preserve the original trusted user send ${JSON.stringify(result)}`);
    assert(result.blockedUntrustedSendCount === 0, `trusted-only contenteditable send must not fall back to blocked synthetic send ${JSON.stringify(result)}`);
  }
}

async function assertContenteditablePreviewAdoption(client, url, injectionMode) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const prompt = "Please tell me how many earthquakes there are yearly";
  await clickCenter(client, '[data-testid="prompt"]');
  await client.send("Input.insertText", { text: prompt });
  await waitForEval(client, "window.__appendRisk?.state.model.includes('earthquakes')");
  await clickCenter(client, ".prism-badge");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display === 'none'");
  await evaluate(client, `
    (() => {
      const badge = document.querySelector('.prism-badge');
      badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, pointerType: 'mouse' }));
      return true;
    })();
  `);
  await waitForEval(client, "document.querySelector('.prism-composer').dataset.peek === 'true'");
  await evaluate(client, `
    new Promise((resolve) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
        resolve(true);
      }, 110);
    })
  `);
  await waitForPeekClosed(client);
  await delay(350);
  const result = await evaluate(client, `(() => {
    const currentPrompt = window.__appendRisk.readPrompt();
    const dangerousReplacementEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertReplacementText" && event.dataLength > 0);
    const dangerousInsertEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertText" && event.earthquakeCount > 1);
    return {
      currentPrompt,
      sentCount: window.__appendRisk.state.sent.length,
      taskCount: (currentPrompt.match(/Task:/g) || []).length,
      outputCount: (currentPrompt.match(/Output:/g) || []).length,
      earthquakeCount: (currentPrompt.match(/earthquakes/gi) || []).length,
      stillCollapsed: document.querySelector('.prism-badge').dataset.collapsed === 'true',
      peekClosed: document.querySelector('.prism-composer').dataset.peek !== 'true',
      composerHidden: getComputedStyle(document.querySelector('.prism-composer')).display === 'none',
      dangerousReplacementEventCount: dangerousReplacementEvents.length,
      dangerousInsertEventCount: dangerousInsertEvents.length,
      events: window.__appendRisk.state.events
    };
  })()`);
  assert(result.sentCount === 0, `Control double-tap preview adoption should not send the prompt ${JSON.stringify(result)}`);
  assert(EARTHQUAKE_OPTIMIZED_FLEX_PATTERN.test(result.currentPrompt), `Control double-tap should adopt the compact optimized contenteditable prompt with output guidance ${JSON.stringify(result)}`);
  assert(result.earthquakeCount === 1 && result.taskCount === 0 && result.outputCount === 1, `Control double-tap should adopt exactly one optimized contenteditable prompt without template bloat ${JSON.stringify(result)}`);
  assert(result.stillCollapsed && result.peekClosed && result.composerHidden, `Control double-tap should keep Prism off after adopting the preview ${JSON.stringify(result)}`);
  assert(result.dangerousReplacementEventCount === 0, `preview adoption should not expose full replacement data to append-prone editors ${JSON.stringify(result)}`);
  assert(result.dangerousInsertEventCount === 0, `preview adoption should not create repeated optimized blocks ${JSON.stringify(result)}`);
}

async function assertContenteditablePreviewAdoptionAndSend(client, url, injectionMode, sendSelector = ".send") {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const prompt = "Please tell me how many earthquakes there are yearly";
  await clickCenter(client, '[data-testid="prompt"]');
  await client.send("Input.insertText", { text: prompt });
  await waitForEval(client, "window.__appendRisk?.state.model.includes('earthquakes')");
  await clickCenter(client, ".prism-badge");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display === 'none'");
  await evaluate(client, `
    (() => {
      const badge = document.querySelector('.prism-badge');
      badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11, pointerType: 'mouse' }));
      return true;
    })();
  `);
  await waitForEval(client, "document.querySelector('.prism-composer').dataset.peek === 'true'");
  await evaluate(client, `
    new Promise((resolve) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true }));
        resolve(true);
      }, 110);
    })
  `);
  await waitForPeekClosed(client);
  await waitForEval(client, `/^How many earthquakes occur each year\\s+Output: direct, concise, complete$/i.test(window.__appendRisk.readPrompt())`);
  await clickCenter(client, sendSelector);
  await delay(900);
  const result = await evaluate(client, `(() => {
    const sent = window.__appendRisk.state.sent[0] || "";
    const currentPrompt = window.__appendRisk.readPrompt();
    const blockedSends = window.__appendRisk.state.events.filter((event) => event.blockedUntrustedSend);
    return {
      sent,
      provider: window.__appendRisk.state.provider,
      sentTrusted: window.__appendRisk.state.sentEvents[0]?.trusted ?? null,
      sentEventType: window.__appendRisk.state.sentEvents[0]?.type || "",
      currentPrompt,
      sentCount: window.__appendRisk.state.sent.length,
      blockedUntrustedSendCount: blockedSends.length,
      earthquakeCount: (sent.match(/earthquakes/gi) || []).length,
      currentEarthquakeCount: (currentPrompt.match(/earthquakes/gi) || []).length,
      stillCollapsed: document.querySelector('.prism-badge').dataset.collapsed === 'true',
      composerHidden: getComputedStyle(document.querySelector('.prism-composer')).display === 'none',
      events: window.__appendRisk.state.events
    };
  })()`);
  assert(result.sentCount === 1, `preview-adopted prompt should send exactly once while Prism stays off ${JSON.stringify(result)}`);
  assert(EARTHQUAKE_OPTIMIZED_FLEX_PATTERN.test(result.sent), `preview-adopted prompt should send the optimized prompt with output guidance ${JSON.stringify(result)}`);
  assert(result.currentEarthquakeCount === 0, `preview-adopted prompt should clear after native send ${JSON.stringify(result)}`);
  assert(result.blockedUntrustedSendCount === 0, `preview-adopted send must not depend on untrusted synthetic sends ${JSON.stringify(result)}`);
  assert(result.stillCollapsed && result.composerHidden, `preview adoption send should not turn Prism back on ${JSON.stringify(result)}`);
}

async function assertContenteditableEnterSend(client, url, injectionMode, options = {}) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  if (options.waitForWindowCaptureReady) {
    await waitForEval(client, "window.__appendRisk?.state.windowCaptureReady === true");
  }
  const prompt = "Please tell me how many earthquakes there are yearly";
  await clickCenter(client, '[data-testid="prompt"]');
  await client.send("Input.insertText", { text: prompt });
  await waitForEval(client, "window.__appendRisk?.state.model.includes('earthquakes')");
  await assertPromptStaysRawWhileTyping(client, prompt, "contenteditable Enter");
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await delay(1800);
  const result = await evaluate(client, `(() => {
    const sent = window.__appendRisk.state.sent[0] || "";
    const currentPrompt = window.__appendRisk.readPrompt();
    const dangerousReplacementEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertReplacementText" && event.dataLength > 0);
    const dangerousInsertEvents = window.__appendRisk.state.events
      .filter((event) => event.inputType === "insertText" && event.earthquakeCount > 1);
    const blockedSends = window.__appendRisk.state.events.filter((event) => event.blockedUntrustedSend);
    return {
      sent,
      provider: window.__appendRisk.state.provider,
      sentTrusted: window.__appendRisk.state.sentEvents[0]?.trusted ?? null,
      sentEventType: window.__appendRisk.state.sentEvents[0]?.type || "",
      currentPrompt,
      sentCount: window.__appendRisk.state.sent.length,
	      sentLength: sent.length,
	      badgeVisible: !!(document.querySelector('.prism-badge')?.offsetWidth || document.querySelector('.prism-badge')?.offsetHeight || document.querySelector('.prism-badge')?.getClientRects?.().length),
	      composerVisible: getComputedStyle(document.querySelector('.prism-composer')).display !== 'none',
	      taskCount: (sent.match(/Task:/g) || []).length,
      outputCount: (sent.match(/Output:/g) || []).length,
      earthquakeCount: (sent.match(/earthquakes/gi) || []).length,
      currentTaskCount: (currentPrompt.match(/Task:/g) || []).length,
      currentOutputCount: (currentPrompt.match(/Output:/g) || []).length,
      currentEarthquakeCount: (currentPrompt.match(/earthquakes/gi) || []).length,
      dangerousReplacementEventCount: dangerousReplacementEvents.length,
      dangerousInsertEventCount: dangerousInsertEvents.length,
      blockedUntrustedSendCount: blockedSends.length,
      dangerousReplacementEvents,
      dangerousInsertEvents,
      events: window.__appendRisk.state.events
    };
  })()`);
  assert(result.sentCount === 1, `contenteditable Enter should submit exactly once after Prism optimization ${JSON.stringify(result)}`);
  assert(EARTHQUAKE_OPTIMIZED_FLEX_PATTERN.test(result.sent), `contenteditable Enter should submit the compact optimized prompt with output guidance, not the original or a template ${JSON.stringify(result)}`);
  assert(result.earthquakeCount === 1, `contenteditable Enter should commit exactly one optimized earthquake prompt, not repeated blocks ${JSON.stringify(result)}`);
  assert(result.outputCount === 1 && result.taskCount === 0, `contenteditable Enter should include exactly one output guidance line without template bloat ${JSON.stringify(result)}`);
	  assert(result.currentEarthquakeCount === 0 && result.currentTaskCount === 0 && result.currentOutputCount === 0, `contenteditable field should be cleared after native Enter send ${JSON.stringify(result)}`);
	  assert(result.badgeVisible && result.composerVisible, `Prism layer and icon should stay visible on the empty follow-up composer after Enter ${JSON.stringify(result)}`);
	  assert(result.dangerousReplacementEventCount === 0, `contenteditable Enter replacement events should not expose full prompt data to append-prone host editors ${JSON.stringify(result)}`);
  assert(result.dangerousInsertEventCount === 0, `contenteditable Enter insertText events should not create repeated optimized blocks before send ${JSON.stringify(result)}`);
  if (options.requiresTrustedNativeSend) {
    assert(result.sentTrusted === true, `trusted-only contenteditable Enter must preserve the original trusted user send ${JSON.stringify(result)}`);
    assert(result.blockedUntrustedSendCount === 0, `trusted-only contenteditable Enter must not fall back to blocked synthetic send ${JSON.stringify(result)}`);
  }
}

async function assertNoPromptGalleryStaysNative(client, url, injectionMode) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await delay(700);
  const result = await evaluate(client, `(() => {
    const composer = document.querySelector('.prism-composer');
    const badge = document.querySelector('.prism-badge');
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.03 &&
        r.width > 1 &&
        r.height > 1 &&
        r.bottom > 0 &&
        r.top < innerHeight;
    };
    return {
      composerExists: !!composer,
      badgeExists: !!badge,
      composerVisible: visible(composer),
      badgeVisible: visible(badge),
      editorRect: (() => {
        const r = document.querySelector('.chat-input-editor')?.getBoundingClientRect();
        return r ? { width: r.width, height: r.height, top: r.top, bottom: r.bottom } : null;
      })(),
    };
  })()`);
  assert(!result.composerVisible && !result.badgeVisible, `Prism UI should not appear on an inactive gallery prompt ${JSON.stringify(result)}`);

  await evaluate(client, `(() => {
    const editor = document.querySelector('.chat-input-editor');
    editor.focus();
    editor.textContent = 'Draft a concise answer';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: editor.textContent }));
    return true;
  })()`);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const focusedResult = await evaluate(client, `(() => {
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    const host = document.querySelector('.chat-editor').getBoundingClientRect();
    const badge = document.querySelector('.prism-badge').getBoundingClientRect();
    return {
      root: { left: root.left, top: root.top, width: root.width, height: root.height },
      host: { left: host.left, top: host.top, width: host.width, height: host.height },
      badge: { left: badge.left, top: badge.top, width: badge.width, height: badge.height },
      maxError: Math.max(
        Math.abs(root.left - host.left),
        Math.abs(root.top - host.top),
        Math.abs(root.width - host.width),
        Math.abs(root.height - host.height)
      )
    };
  })()`);
  assert(focusedResult.maxError <= 2, `Prism UI should attach to the focused gallery text box ${JSON.stringify(focusedResult)}`);
}

async function assertHomepagePromptSurvivesSettledLayout(client, url, injectionMode) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-badge')).display !== 'none'");
  await evaluate(client, "window.__settleHomepagePrompt(); true;");
  await delay(700);
  const result = await evaluate(client, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.03 &&
        r.width > 1 &&
        r.height > 1 &&
        r.bottom > 0 &&
        r.top < innerHeight;
    };
    const composer = document.querySelector('.prism-composer');
    const badge = document.querySelector('.prism-badge');
    const host = document.querySelector('[data-testid="homepage-composer"]');
    const rootRect = composer?.getBoundingClientRect();
    const hostRect = host?.getBoundingClientRect();
    const badgeRect = badge?.getBoundingClientRect();
    return {
      composerVisible: visible(composer),
      badgeVisible: visible(badge),
      rootRect: rootRect ? { top: rootRect.top, bottom: rootRect.bottom, width: rootRect.width, height: rootRect.height } : null,
      hostRect: hostRect ? { top: hostRect.top, bottom: hostRect.bottom, width: hostRect.width, height: hostRect.height } : null,
      badgeRect: badgeRect ? { top: badgeRect.top, left: badgeRect.left, width: badgeRect.width, height: badgeRect.height } : null,
      settled: document.body.dataset.settled
    };
  })()`);
  assert(result.composerVisible && result.badgeVisible,
    `ChatGPT-style homepage prompt should keep Prism visible after layout settles ${JSON.stringify(result)}`);
  await evaluate(client, "document.querySelector('.prism-badge').click(); true;");
  await delay(500);
  const collapsedResult = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const composer = document.querySelector('.prism-composer');
    const r = badge?.getBoundingClientRect();
    const style = badge ? getComputedStyle(badge) : null;
    return {
      badgeVisible: !!badge && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03 && r.width > 1 && r.height > 1,
      badgeCollapsed: badge?.dataset.collapsed === 'true',
      composerHidden: !!composer && getComputedStyle(composer).display === 'none'
    };
  })()`);
  assert(collapsedResult.badgeVisible && collapsedResult.badgeCollapsed && collapsedResult.composerHidden,
    `ChatGPT-style homepage prompt should keep the Prism icon visible when turned off ${JSON.stringify(collapsedResult)}`);
  await evaluate(client, "document.querySelector('.prism-badge').click(); true;");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const reopenedResult = await evaluate(client, `(() => {
    const badge = document.querySelector('.prism-badge');
    const composer = document.querySelector('.prism-composer');
    const badgeRect = badge?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    return {
      badgeVisible: !!badge &&
        badgeStyle.display !== 'none' &&
        badgeStyle.visibility !== 'hidden' &&
        Number(badgeStyle.opacity || 1) > 0.03 &&
        badgeRect.width > 1 &&
        badgeRect.height > 1,
      badgeCollapsed: badge?.dataset.collapsed === 'true',
      composerVisible: !!composer &&
        getComputedStyle(composer).display !== 'none' &&
        composerRect.width > 200 &&
        composerRect.height > 30,
      badgeRect: badgeRect ? { top: badgeRect.top, left: badgeRect.left, width: badgeRect.width, height: badgeRect.height } : null,
      composerRect: composerRect ? { top: composerRect.top, left: composerRect.left, width: composerRect.width, height: composerRect.height } : null
    };
  })()`);
  assert(reopenedResult.badgeVisible && !reopenedResult.badgeCollapsed && reopenedResult.composerVisible,
    `ChatGPT-style homepage prompt should show both icon and layer after turning Prism back on ${JSON.stringify(reopenedResult)}`);
}

async function assertPrismTracksMovingPrompt(client, url, injectionMode) {
  await client.send("Page.navigate", { url });
  await waitForEval(client, "document.readyState === 'complete'");
  if (injectionMode === "manual-built-script") await injectBuiltExtensionRuntime(client);
  await evaluate(client, `(() => {
    const prompt = document.querySelector('[data-testid="prompt"]');
    prompt.focus();
    prompt.value = 'Track this prompt while the composer moves';
    prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt.value }));
    return true;
  })()`);
  await waitForEval(client, "Boolean(document.querySelector('.prism-composer'))");
  await waitForEval(client, "getComputedStyle(document.querySelector('.prism-composer')).display !== 'none'");
  const anchorResult = await evaluate(client, `(() => {
    const root = document.querySelector('.prism-composer');
    return {
      anchor: root.dataset.anchor,
      position: getComputedStyle(root).position,
      parentIsHost: root.parentElement === document.querySelector('[data-testid="moving-composer"]')
    };
  })()`);
  assert(anchorResult.anchor === "host" && anchorResult.position === "absolute" && anchorResult.parentIsHost,
    `Prism skin should be host-anchored so it inherits native composer movement ${JSON.stringify(anchorResult)}`);
  const immediateResult = await evaluate(client, `(() => {
    window.__moveComposer(26);
    const host = document.querySelector('[data-testid="moving-composer"]').getBoundingClientRect();
    const root = document.querySelector('.prism-composer').getBoundingClientRect();
    return {
      dx: Math.abs(root.left - host.left),
      dyError: Math.abs(root.top - host.top),
      dw: Math.abs(root.width - host.width),
      dh: Math.abs(root.height - host.height)
    };
  })()`);
  assert(immediateResult.dx <= 2 && immediateResult.dyError <= 2 && immediateResult.dw <= 2 && immediateResult.dh <= 2,
    `Prism skin should move with the native composer immediately, before the next animation frame ${JSON.stringify(immediateResult)}`);
  const result = await evaluate(client, `new Promise((resolve) => {
    const samples = [];
    let frame = 0;
    function sample() {
      const dy = Math.round(Math.sin(frame / 2) * 18);
      window.__moveComposer(dy);
      requestAnimationFrame(() => {
        const host = document.querySelector('[data-testid="moving-composer"]').getBoundingClientRect();
        const root = document.querySelector('.prism-composer').getBoundingClientRect();
        samples.push({
          frame,
          dy,
          dx: Math.abs(root.left - host.left),
          dyError: Math.abs(root.top - host.top),
          dw: Math.abs(root.width - host.width),
          dh: Math.abs(root.height - host.height)
        });
        frame += 1;
        if (frame < 10) sample();
        else resolve({
          samples,
          maxTopError: Math.max(...samples.map((entry) => entry.dyError)),
          maxLeftError: Math.max(...samples.map((entry) => entry.dx)),
          maxWidthError: Math.max(...samples.map((entry) => entry.dw)),
          maxHeightError: Math.max(...samples.map((entry) => entry.dh))
        });
      });
    }
    sample();
  })`);
  assert(result.maxTopError <= 2 && result.maxLeftError <= 2 && result.maxWidthError <= 2 && result.maxHeightError <= 2,
    `Prism skin should stay visually attached to a moving prompt surface ${JSON.stringify(result)}`);
}

async function clickCenter(client, selector) {
  const rect = await evaluate(client, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2
    };
  })()`);
  assert(rect, `Missing element to click: ${selector}`);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function waitForDevToolsPort(userDataDir, chromeProcess) {
  const file = resolve(userDataDir, "DevToolsActivePort");
  let exited = false;
  chromeProcess.once("exit", () => {
    exited = true;
  });
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) {
      const [port] = (await readFile(file, "utf8")).trim().split("\n");
      return Number(port);
    }
    if (exited) {
      throw new Error(`Chrome exited before exposing DevTools. ${chromeLog.trim()}`);
    }
    await delay(100);
  }
  throw new Error(`Chrome did not expose a DevTools port. ${chromeLog.trim()}`);
}

async function firstPageTarget(port) {
  for (let i = 0; i < 40; i += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((target) => target.type === "page");
    if (page) return page;
    await delay(100);
  }
  throw new Error("No Chrome page target found.");
}

async function waitForEval(client, expression) {
  for (let i = 0; i < 80; i += 1) {
    const value = await evaluate(client, expression).catch(() => false);
    if (value) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for expression: ${expression}\n${client.diagnostics()}\n${chromeLog.trim()}`);
}

async function waitForPeekClosed(client) {
  await waitForEval(client, `(() => {
    const composer = document.querySelector('.prism-composer');
    return composer && composer.dataset.peek !== 'true';
  })()`);
}

async function tryWaitForEval(client, expression, timeoutMs) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let i = 0; i < attempts; i += 1) {
    const value = await evaluate(client, expression).catch(() => false);
    if (value) return true;
    await delay(100);
  }
  return false;
}

async function injectBuiltExtensionRuntime(client) {
  const css = await readFile(resolve(extensionPath, "src/content.css"), "utf8");
  const core = await readFile(resolve(extensionPath, "src/prism-core.js"), "utf8");
  const content = await readFile(resolve(extensionPath, "src/content.js"), "utf8");
  const pageBridge = await readFile(resolve(extensionPath, "src/page-bridge.js"), "utf8");
  const manifest = JSON.parse(await readFile(resolve(extensionPath, "manifest.json"), "utf8"));
  const pageBridgeUrl = `data:text/javascript;base64,${Buffer.from(pageBridge).toString("base64")}`;
  await evaluate(client, `
    (() => {
      window.__PRISM_TEST__ = true;
      window.chrome = {
        runtime: {
          getManifest() { return { version: ${JSON.stringify(manifest.version)} }; },
          getURL(path) {
            return path === "src/page-bridge.js" ? ${JSON.stringify(pageBridgeUrl)} : "";
          }
        },
        storage: {
          local: {
            get(_keys, cb) { if (typeof cb === "function") cb({}); },
            set() {}
          },
          sync: {
            get(_keys, cb) { if (typeof cb === "function") cb({}); },
            set() {}
          },
          onChanged: {
            addListener() {}
          }
        }
      };
      return true;
    })();
  `);
  await evaluate(client, `
    (() => {
    const style = document.createElement('style');
    style.dataset.prismInjected = 'true';
    style.textContent = ${JSON.stringify(css)};
    document.documentElement.append(style);
    return true;
    })();
  `);
  await evaluate(client, `
    (() => {
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(core)};
    document.documentElement.append(script);
    script.remove();
    return true;
    })();
  `);
  await evaluate(client, `
    (() => {
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(content)};
    document.documentElement.append(script);
    script.remove();
    return true;
    })();
  `);
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Runtime.evaluate failed";
    throw new Error(detail);
  }
  return response.result.value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
