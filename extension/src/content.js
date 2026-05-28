/* Prism content script (v2) — Claw-style UX.
 *
 * - Finds visible prompt fields (textarea or [contenteditable="true"]) on LLM surfaces.
 * - Renders a small circular Prism badge near the bottom-right corner of the active field.
 * - Renders a visual skin aligned to the native composer geometry.
 * - Click badge: collapse composer (badge stays). Click badge again: re-open.
 * - Default state per surface: open. State is remembered per surface key (host+path-prefix).
 * - On Enter (or native send button), Prism optimizes in the bundled engine.
 * - Latency hard cap: HARD_CAP_MS. Beyond that, send original prompt.
 */
(function () {
  "use strict";
  if (shouldSkipPrismExtension()) return;
  if (window.__prismInstalled) return;
  window.__prismInstalled = true;

  const HARD_CAP_MS = 250;
  const PREVIEW_LONG_PRESS_MS = 550;
  const CONTROL_DOUBLE_TAP_MS = 430;
  const INLINE_MODEL_SYNC_DEBOUNCE_MS = 320;
  const INLINE_MODEL_SYNC_MIN_CHARS = 18;
  const DEFAULT_OUTPUT_GUIDANCE = "direct, concise, complete";
  const EXTENSION_VERSION = readExtensionVersion();
  const DEFAULT_GLOBAL = {
    enabled: true,
    mode: "balanced",
    overlayIntensity: 1,
    autoMetrics: true,
    defaultOutputGuidance: true,
    outputGuidanceText: DEFAULT_OUTPUT_GUIDANCE,
    paused: false,
  };

  function readExtensionVersion() {
    try {
      return typeof chrome !== "undefined" ? (chrome.runtime?.getManifest?.().version || "") : "";
    } catch {
      return "";
    }
  }

  function shouldSkipPrismExtension() {
    const documentOptOut = document.querySelector([
      "meta[name='prism-extension'][content='disabled']",
      "meta[name='prism-extension'][content='off']",
      "meta[name='prism-extension'][content='false']",
      "meta[name='prism-extension'][content='0']"
    ].join(","));
    const rootOptOut = String(document.documentElement?.dataset?.prismExtension || "").toLowerCase();
    return !!documentOptOut || ["disabled", "off", "false", "0"].includes(rootOptOut);
  }

  // ---------- state ----------
  let badge = null;
  let composer = null;
  let composerField = null;
  let composerStatus = null;
  let activeField = null;
  let peekState = { active: false, sticky: false, raw: "", output: "", metrics: null, field: null };
  let processing = false;
  let longPressTimer = null;
  let suppressNextBadgeClick = false;
  let lastControlTapAt = 0;
  let positionTimer = null;
  let geometryWatch = 0;
  let geometrySignature = "";
  let geometryResizeObserver = null;
  let observedField = null;
  let composerAnchorHost = null;
  const composerAnchorStates = new WeakMap();
  let refreshingFromResizeObserver = false;
  let forwardingNativeSend = false;
  let lastTrustedSendPrepareAt = 0;
  let lastTrustedSendPrepareField = null;
  let inlineModelSyncTimer = null;
  let inlineModelSyncField = null;
  let inlineModelSyncRaw = "";
  let inlineModelSyncOutput = "";
  let inlineModelSyncMetrics = null;
  let inlineModelSyncInProgress = false;
  let suppressInlineModelSyncUntil = 0;
  let pageBridgeInjected = false;
  let pageBridgeReadyPromise = null;
  let pageBridgeSeq = 0;
  const handledNativeKeydownEvents = new WeakSet();
  const handledNativeSendEvents = new WeakSet();
  const handledNativeSubmitEvents = new WeakSet();
  let settings = { collapsed: false, paused: false };
  let globalSettings = { ...DEFAULT_GLOBAL };

  // ---------- helpers ----------
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  const PROVIDER_ADAPTERS = [
    {
      id: "chatgpt",
      host: /(^|\.)chatgpt\.com$/i,
      fieldSelectors: [
        "#prompt-textarea",
        "[data-testid='prompt-textarea']",
        "[contenteditable='true'][id*='prompt']",
        "textarea[placeholder*='Message']",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "form[data-type='unified-composer']",
        "form",
        "[data-testid*='composer']",
        "[class*='composer']",
        "[class*='prompt']"
      ],
      controlSelectors: [
        "[data-testid*='send']",
        "[data-testid*='voice']",
        "[data-testid*='model']",
        "[aria-label*='Attach']",
        "[aria-label*='Tools']"
      ],
      sendSelectors: ["[data-testid*='send']", "button[aria-label*='Send']"],
      surfaceMode: "outer"
    },
    {
      id: "gemini",
      host: /(^|\.)gemini\.google\.com$/i,
      fieldSelectors: [
        "rich-textarea [contenteditable='true']",
        "[contenteditable='true'][role='textbox']",
        "textarea",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "rich-textarea",
        "[class*='input-area']",
        "[class*='query']",
        "[class*='composer']",
        "form"
      ],
      controlSelectors: [
        "[aria-label*='Tools']",
        "[aria-label*='Add']",
        "[aria-label*='Upload']",
        "[aria-label*='Voice']",
        "[aria-label*='Microphone']",
        "[aria-label*='Model']"
      ],
      sendSelectors: ["button[aria-label*='Send']", "[aria-label*='Submit']"]
    },
    {
      id: "grok",
      host: /(^|\.)grok\.com$/i,
      fieldSelectors: [
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "form",
        "[class*='composer']",
        "[class*='input']",
        "[class*='prompt']"
      ],
      controlSelectors: [
        "[aria-label*='Attach']",
        "[aria-label*='Voice']",
        "[aria-label*='Model']",
        "[aria-haspopup='menu']"
      ],
      sendSelectors: ["button[aria-label*='Send']", "[data-testid*='send']"]
    },
    {
      id: "perplexity",
      host: /(^|\.)perplexity\.ai$/i,
      fieldSelectors: [
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "form",
        "[class*='composer']",
        "[class*='input']",
        "[class*='query']",
        "[class*='search']"
      ],
      controlSelectors: [
        "[aria-label*='Attach']",
        "[aria-label*='Search']",
        "[aria-label*='Focus']",
        "[aria-label*='Model']",
        "[aria-label*='Voice']",
        "[aria-haspopup='menu']"
      ],
      sendSelectors: ["button[aria-label*='Submit']", "button[aria-label*='Send']", "[data-testid*='submit']"]
    },
    {
      id: "kimi",
      host: /(^|\.)kimi\.com$/i,
      fieldSelectors: [
        ".chat-input-editor[contenteditable='true']",
        "[contenteditable='true'][role='textbox']",
        "[contenteditable='true']",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "#chat-box",
        ".chat-editor",
        ".chat-box",
        "[class*='chat-editor']",
        "[class*='chat-input']",
        "[class*='composer']"
      ],
      controlSelectors: [
        ".send-button-container",
        "[class*='send-button']",
        "[class*='model']",
        "[class*='agent']",
        "[aria-haspopup='menu']"
      ],
      sendSelectors: [".send-button-container", "[class*='send-button-container']", "button[aria-label*='Send']", "[data-testid*='send']"]
    },
    {
      id: "claude",
      host: /(^|\.)claude\.ai$/i,
      fieldSelectors: [
        "div.ProseMirror[contenteditable='true']",
        "[contenteditable='true']",
        "textarea",
        "[role='textbox']"
      ],
      surfaceSelectors: [
        "form",
        "[class*='composer']",
        "[class*='input']",
        "[class*='prompt']",
        "[class*='ProseMirror']"
      ],
      controlSelectors: [
        "[aria-label*='Attach']",
        "[aria-label*='Upload']",
        "[aria-label*='Tools']",
        "[aria-label*='Model']",
        "[aria-haspopup='menu']"
      ],
      sendSelectors: ["button[aria-label*='Send']", "[data-testid*='send']"]
    }
  ];

  const GENERIC_ADAPTER = {
    id: "generic",
    fieldSelectors: [],
    surfaceSelectors: [],
    controlSelectors: [],
    sendSelectors: []
  };

  function surfaceAdapter() {
    const forcedProvider = String(document.documentElement?.dataset?.prismProvider || "").toLowerCase();
    if (forcedProvider) {
      const forcedAdapter = PROVIDER_ADAPTERS.find((adapter) => adapter.id === forcedProvider);
      if (forcedAdapter) return forcedAdapter;
    }
    const host = location.hostname;
    return PROVIDER_ADAPTERS.find((adapter) => adapter.host.test(host)) || GENERIC_ADAPTER;
  }

  function providerSelectors(kind) {
    return surfaceAdapter()[kind] || [];
  }

  function querySelectorList(root, selectors) {
    const seen = new Set();
    const out = [];
    for (const selector of selectors.filter(Boolean)) {
      try {
        for (const el of root.querySelectorAll?.(selector) || []) {
          if (seen.has(el)) continue;
          seen.add(el);
          out.push(el);
        }
      } catch {}
    }
    return out;
  }

  function surfaceKey() {
    const path = location.pathname.split("/").slice(0, 3).join("/");
    return (location.host + path).toLowerCase();
  }

  function detectSurfaceModel() {
    const nodes = [
      activeField?.closest?.("form"),
      activeField?.parentElement?.parentElement,
      activeField?.parentElement,
      document.body,
      document.documentElement,
    ].filter(Boolean);

    try {
      const controls = document.querySelectorAll?.("button,[role='button'],select,option");
      for (const node of controls || []) nodes.push(node);
    } catch {}

    const haystack = nodes.map((node) => {
      try {
        return [
          node.getAttribute?.("aria-label"),
          node.getAttribute?.("title"),
          node.getAttribute?.("data-testid"),
          node.value,
          node.innerText,
          node.textContent,
        ].filter(Boolean).join(" ");
      } catch {
        return "";
      }
    }).join(" ").slice(0, 6000);

    const match = haystack.match(/\b(?:GPT[-\s]?(?:5(?:\.\d+)?(?:[-\s]?Codex(?:[-\s]?Max)?)?|4o|4\.1)|gpt-image-\d(?:\.\d+)?|ChatGPT Image|Claude(?:\s+(?:Sonnet|Opus|Haiku))?(?:\s+\d(?:\.\d+)?)?|Gemini(?:\s+\d(?:\.\d+)?)?(?:\s+(?:Pro|Flash))?|Grok(?:\s+\d(?:\.\d+)?)?|Codex|o[134](?:-mini|-pro)?)\b/i);
    return match ? match[0] : "";
  }

  function readGlobalSettings(cb) {
    try {
      chrome.storage?.local.get(["prismSettings"], (localRes) => {
        chrome.storage?.sync?.get(["prismSettings"], (syncRes) => {
          globalSettings = {
            ...DEFAULT_GLOBAL,
            ...(localRes && localRes.prismSettings),
            ...(syncRes && syncRes.prismSettings),
          };
          cb && cb();
        });
      });
    } catch { cb && cb(); }
  }

  function readState(cb) {
    try {
      chrome.storage?.local.get(["prismState", "prismSettings"], (localRes) => {
        chrome.storage?.sync?.get(["prismSettings"], (syncRes) => {
          globalSettings = {
            ...DEFAULT_GLOBAL,
            ...(localRes && localRes.prismSettings),
            ...(syncRes && syncRes.prismSettings),
          };
          const all = (localRes && localRes.prismState) || {};
          const key = surfaceKey();
          const surfaceState = all[key] || { collapsed: false };
          settings = { ...settings, ...surfaceState, sitePaused: !!surfaceState.paused, paused: !!globalSettings.paused || !!surfaceState.paused };
          cb && cb();
        });
      });
    } catch { cb && cb(); }
  }

  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (!["local", "sync"].includes(area)) return;
      if (changes.prismSettings) {
        globalSettings = { ...globalSettings, ...changes.prismSettings.newValue };
      }
      if (changes.prismState) {
        const surfaceState = changes.prismState.newValue?.[surfaceKey()] || {};
        settings = { ...settings, ...surfaceState, sitePaused: !!surfaceState.paused };
      }
      if (!changes.prismSettings && !changes.prismState) return;
      settings.paused = !!globalSettings.paused || !!settings.sitePaused;
      updateBadge();
      schedulePosition();
    });
  } catch {}

  function writeState(patch) {
    settings = { ...settings, ...patch };
    try {
      chrome.storage?.local.get(["prismState"], (res) => {
        const all = (res && res.prismState) || {};
        const key = surfaceKey();
        all[key] = { ...(all[key] || {}), ...patch };
        chrome.storage?.local.set({ prismState: all });
      });
    } catch {}
  }

  function writeGlobalSettings(patch) {
    globalSettings = { ...globalSettings, ...patch };
    try {
      chrome.storage?.sync?.get(["prismSettings"], (res) => {
        const next = { ...((res && res.prismSettings) || {}), ...patch };
        chrome.storage?.sync?.set({ prismSettings: next });
      });
    } catch {}
  }

  const EDITABLE_FIELD_SELECTOR = [
    "textarea",
    "input",
    "div[contenteditable='true']",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
  ].join(",");

  const PROMPT_FIELD_SELECTOR = [
    EDITABLE_FIELD_SELECTOR,
    "[role='textbox']",
  ].join(",");

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      return ["", "text", "search"].includes(type);
    }
    const editable = String(el.getAttribute?.("contenteditable") || "").toLowerCase();
    return !!el.isContentEditable || editable === "true" || editable === "plaintext-only";
  }

  function resolvePromptField(el) {
    if (!el) return null;
    const node = el.nodeType === 1 ? el : el.parentElement;
    if (!node) return null;
    if (isEditableElement(node)) return node;
    const closestEditable = node.closest?.(EDITABLE_FIELD_SELECTOR);
    if (closestEditable && isEditableElement(closestEditable)) return closestEditable;
    const nestedEditable = node.querySelector?.(EDITABLE_FIELD_SELECTOR);
    if (nestedEditable && isEditableElement(nestedEditable)) return nestedEditable;
    return null;
  }

  function getValue(el) {
    const field = resolvePromptField(el) || el;
    if (!field) return "";
    const tag = field.tagName?.toLowerCase();
    if (tag === "textarea" || tag === "input") return field.value || "";
    return field.innerText || field.textContent || "";
  }

  function normalizedValue(s) {
    return String(s || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
  }

  function comparableValue(s) {
    return normalizedValue(s).replace(/\s+/g, " ");
  }

  function valuesMatch(actual, expected) {
    const a = normalizedValue(actual);
    const e = normalizedValue(expected);
    if (a === e) return true;
    return comparableValue(a) === comparableValue(e);
  }

  function dispatchTextEvents(el, value, inputType = "insertReplacementText") {
    try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: value })); }
    catch { el.dispatchEvent(new Event("input", { bubbles: true })); }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  }

  function dispatchReplacementChangeEvents(el, inputType = "insertReplacementText") {
    try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: null })); }
    catch { el.dispatchEvent(new Event("input", { bubbles: true })); }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  }

  function dispatchPlainChangeEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  }

  function selectEditableContents(el) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      try { el.focus(); } catch {}
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function dispatchSyntheticPaste(el, value) {
    try {
      if (!window.DataTransfer || !window.ClipboardEvent) return false;
      const data = new DataTransfer();
      data.setData("text/plain", value);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      return !el.dispatchEvent(event);
    } catch {
      return false;
    }
  }

  function setValue(el, v) {
    el = resolvePromptField(el);
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }

    if (tag === "textarea" || tag === "input") {
      const proto = tag === "textarea" ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
      const tracker = el._valueTracker;
      const previous = el.value;
      if (setter) setter.call(el, v); else el.value = v;
      // React tracks value internally; resetting the tracker makes the next input
      // event observable instead of ignored as a no-op.
      try { tracker?.setValue(previous); } catch {}
      dispatchTextEvents(el, v);
      return valuesMatch(el.value, v);
    }

    if (!isQuillEditor(el) && replaceEditableViaNativeInput(el, v)) return true;
    if (shouldUsePlainEditableReplacement(el)) return replaceEditableDomValuePlain(el, v);

    if (replaceRichEditableValue(el, v)) return true;

    selectEditableContents(el);

    // ProseMirror-like editors often keep a model separate from the DOM. Give
    // their paste/input handlers first chance to update that model before using
    // DOM fallbacks that can look correct but still send stale state.
    dispatchSyntheticPaste(el, v);
    if (valuesMatch(getValue(el), v)) {
      dispatchTextEvents(el, v);
      return true;
    }

    let inserted = false;
    try { inserted = document.execCommand("insertText", false, v); } catch {}
    if (!inserted || !valuesMatch(getValue(el), v)) {
      selectEditableContents(el);
      try { document.execCommand("delete", false); } catch {}
      try { inserted = document.execCommand("insertText", false, v); } catch {}
    }
    if (!inserted || !valuesMatch(getValue(el), v)) {
      // Fallback for editors that block execCommand in content scripts.
      const insertValue = richEditableInsertValue(el, v);
      el.textContent = insertValue;
      el.innerText = insertValue;
    }
    dispatchReplacementChangeEvents(el);
    return valuesMatch(getValue(el), v);
  }

  function replaceRichEditableValue(el, value) {
    const insertValue = richEditableInsertValue(el, value);
    const safeAttempts = [
      ...(shouldUseSyntheticPasteForReplacement(el) ? [() => {
        selectEditableContents(el);
        return dispatchSyntheticPaste(el, insertValue);
      }] : []),
      () => replaceEditableDomValue(el, insertValue),
    ];
    const quillAttempts = [
      () => {
        selectEditableContents(el);
        try { document.execCommand("delete", false); } catch {}
        return document.execCommand("insertText", false, insertValue);
      },
      () => {
        try { document.execCommand("selectAll", false); } catch {}
        try { document.execCommand("delete", false); } catch {}
        return document.execCommand("insertText", false, insertValue);
      },
      () => {
        el.innerHTML = "<p><br></p>";
        el.textContent = "";
        dispatchReplacementChangeEvents(el, "deleteContentBackward");
        selectEditableContents(el);
        return document.execCommand("insertText", false, insertValue);
      },
    ];
    const genericAttempts = safeAttempts;
    const attempts = isQuillEditor(el) ? [...safeAttempts, ...quillAttempts] : genericAttempts;

    for (const attempt of attempts) {
      try {
        const changed = attempt();
        dispatchReplacementChangeEvents(el);
        if (changed && valuesMatch(getValue(el), value)) return true;
        if (valuesMatch(getValue(el), value)) return true;
      } catch {}
    }
    return false;
  }

  function shouldUseSyntheticPasteForReplacement(el) {
    return !isAppendProneEditable(el);
  }

  function shouldUsePlainEditableReplacement(el) {
    return isAppendProneEditable(el);
  }

  function shouldDeferTrustedNativeSend(el, event = null, sendTarget = null) {
    const field = resolvePromptField(el);
    if (!isAppendProneEditable(field)) return false;
    const raw = getValue(field).trim();
    if (hasInlineModelSync(field) || hasOutputGuidance(raw)) return false;
    if (needsInlineModelSyncBeforeTrustedSend(field)) return false;
    return !shouldPreserveOriginalTrustedSend(field, event, sendTarget);
  }

  function shouldPreserveOriginalTrustedSend(field, event = null, sendTarget = null) {
    field = resolvePromptField(field);
    if (!field) return false;
    if (sendTarget && isNonNativeSendControl(sendTarget)) return true;
    return event?.type === "keydown" && isSingleLineRichEditable(field);
  }

  function isNonNativeSendControl(target) {
    const el = target?.closest?.("button,input[type='submit'],input[type='button']") || target;
    const tag = el?.tagName?.toLowerCase();
    if (tag === "button" || tag === "input") return false;
    return !!(el && (matchesProviderSendSelector(el) || looksLikeSendButton(el)));
  }

  function isAppendProneEditable(el) {
    const text = [
      el?.className,
      el?.getAttribute?.("data-lexical-editor"),
      el?.getAttribute?.("data-slate-editor"),
      el?.getAttribute?.("aria-label"),
    ].filter(Boolean).join(" ");
    return /caret-super|selection:bg-super|lexical|slate|chat-input-editor/i.test(text);
  }

  function replaceEditableDomValue(el, value) {
    value = richEditableInsertValue(el, value);
    replaceEditableDomContents(el, value);
    dispatchReplacementChangeEvents(el);
    return valuesMatch(getValue(el), value);
  }

  function replaceEditableDomValuePlain(el, value) {
    value = richEditableInsertValue(el, value);
    replaceEditableDomContents(el, value);
    dispatchPlainChangeEvents(el);
    return valuesMatch(getValue(el), value);
  }

  function replaceEditableDomContents(el, value) {
    value = String(value || "");
    if (isLexicalEditor(el)) {
      const p = document.createElement("p");
      if (value) {
        p.setAttribute("dir", "ltr");
        const span = document.createElement("span");
        span.setAttribute("data-lexical-text", "true");
        span.textContent = value;
        p.appendChild(span);
      } else {
        p.appendChild(document.createElement("br"));
      }
      try {
        el.replaceChildren(p);
        return;
      } catch {}
    }
    try {
      el.replaceChildren(document.createTextNode(String(value || "")));
    } catch {
      el.textContent = String(value || "");
    }
  }

  function isLexicalEditor(el) {
    return String(el?.getAttribute?.("data-lexical-editor") || "").toLowerCase() === "true";
  }

  function replaceEditableViaNativeInput(el, value) {
    const text = richEditableInsertValue(el, value);
    if (valuesMatch(getValue(el), value)) {
      return true;
    }
    if (!selectEditableContents(el)) return false;
    try { document.execCommand("delete", false); } catch {}
    if (!valuesMatch(getValue(el), "")) {
      try {
        el.replaceChildren();
      } catch {
        el.textContent = "";
      }
      dispatchReplacementChangeEvents(el, "deleteContentBackward");
      selectEditableContents(el);
    }
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch {}
    if (!inserted || !valuesMatch(getValue(el), value)) return false;
    return true;
  }

  function richEditableInsertValue(el, value) {
    if (isQuillEditor(el) || isSingleLineRichEditable(el)) {
      return String(value || "").replace(/[ \t]*\n+[ \t]*/g, " ");
    }
    return value;
  }

  function isSingleLineRichEditable(el) {
    const multiline = String(el?.getAttribute?.("aria-multiline") || "").toLowerCase();
    if (multiline === "false") return true;
    const text = [
      el?.className,
      el?.getAttribute?.("data-lexical-editor"),
      el?.getAttribute?.("role"),
    ].filter(Boolean).join(" ");
    return /\bchat-input-editor\b/i.test(text) && /lexical/i.test(text);
  }

  function isQuillEditor(el) {
    return /\bql-editor\b/.test(String(el?.className || ""));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function nativeSendDelay(field) {
    return shouldUsePlainEditableReplacement(field) ? 280 : 90;
  }

  function needsInlineModelSyncBeforeTrustedSend(field) {
    field = resolvePromptField(field);
    return !!field && isAppendProneEditable(field);
  }

  function clearInlineModelSync({ keepLast = false } = {}) {
    if (inlineModelSyncTimer) {
      clearTimeout(inlineModelSyncTimer);
      inlineModelSyncTimer = null;
    }
    if (keepLast) return;
    inlineModelSyncField = null;
    inlineModelSyncRaw = "";
    inlineModelSyncOutput = "";
    inlineModelSyncMetrics = null;
  }

  function hasInlineModelSync(field) {
    field = resolvePromptField(field);
    if (!field || field !== inlineModelSyncField || !inlineModelSyncOutput) return false;
    return valuesMatch(getValue(field), inlineModelSyncOutput);
  }

  function hasOutputGuidance(text) {
    return /(^|\s)Output\s*:/i.test(String(text || ""));
  }

  function markInlineModelSync(state) {
    if (badge) badge.dataset.sync = state || "";
  }

  function ensurePageBridge() {
    if (pageBridgeReadyPromise) return pageBridgeReadyPromise;
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return Promise.resolve(false);
    pageBridgeReadyPromise = new Promise((resolve) => {
      try {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("src/page-bridge.js");
        script.async = false;
        script.onload = () => {
          pageBridgeInjected = true;
          try { script.remove(); } catch {}
          resolve(true);
        };
        script.onerror = () => resolve(false);
        (document.documentElement || document.head || document.body)?.appendChild(script);
        setTimeout(() => resolve(!!window.__prismPageBridgeInstalled || pageBridgeInjected), 350);
      } catch {
        resolve(false);
      }
    });
    return pageBridgeReadyPromise;
  }

  function isPageBridgeReady() {
    return document.documentElement?.dataset?.prismPageBridge === "ready";
  }

  function replaceEditableViaPageBridgeNow(el, value) {
    if (!isPageBridgeReady()) return false;
    const id = `prism-${Date.now().toString(36)}-${(++pageBridgeSeq).toString(36)}`;
    try { el.dataset.prismBridgeId = id; } catch {}
    try {
      window.dispatchEvent(new CustomEvent("PrismPageBridgeReplace", { detail: { id, value } }));
      return valuesMatch(getValue(el), value);
    } catch {
      return false;
    } finally {
      try { delete el.dataset.prismBridgeId; } catch {}
    }
  }

  async function replaceEditableViaPageBridge(el, value) {
    const bridgeReady = await Promise.race([
      ensurePageBridge(),
      sleep(500).then(() => document.documentElement?.dataset?.prismPageBridge === "ready")
    ]);
    if (!bridgeReady && document.documentElement?.dataset?.prismPageBridge !== "ready") return false;
    const id = `prism-${Date.now().toString(36)}-${(++pageBridgeSeq).toString(36)}`;
    try { el.dataset.prismBridgeId = id; } catch {}
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        window.removeEventListener("PrismPageBridgeReplaceResult", onResult, true);
        try { delete el.dataset.prismBridgeId; } catch {}
        resolve(!!ok);
      };
      const onResult = (event) => {
        if (event.detail?.id !== id) return;
        markInlineModelSync(event.detail?.ok ? "bridge-ready" : `bridge-${event.detail?.reason || "failed"}`);
        finish(event.detail?.ok);
      };
      window.addEventListener("PrismPageBridgeReplaceResult", onResult, true);
      try {
        window.dispatchEvent(new CustomEvent("PrismPageBridgeReplace", { detail: { id, value } }));
      } catch {
        finish(false);
      }
      setTimeout(() => finish(false), 700);
    });
  }

  function replaceEditableViaSyntheticPaste(el, value) {
    if (!selectEditableContents(el)) return false;
    return dispatchSyntheticPaste(el, richEditableInsertValue(el, value));
  }

  async function commitInlineModelSyncValue(field, optimizedPrompt, raw) {
    const current = getValue(field);
    if (!valuesMatch(current, raw) && !valuesMatch(current, optimizedPrompt)) return false;
    if (shouldUsePlainEditableReplacement(field) && await replaceEditableViaPageBridge(field, optimizedPrompt)) {
      await sleep(180);
      return valuesMatch(getValue(field), optimizedPrompt);
    }
    if (shouldUsePlainEditableReplacement(field) && replaceEditableViaNativeInput(field, optimizedPrompt)) {
      await sleep(180);
      return valuesMatch(getValue(field), optimizedPrompt);
    }
    const committed = shouldUsePlainEditableReplacement(field)
      ? replaceEditableDomValuePlain(field, optimizedPrompt)
      : setValue(field, optimizedPrompt);
    await sleep(520);
    return !!committed && valuesMatch(getValue(field), optimizedPrompt);
  }

  function commitValueForTrustedNativeSend(field, optimizedPrompt, raw) {
    field = resolvePromptField(field);
    if (!field) return false;
    const current = getValue(field);
    if (valuesMatch(current, optimizedPrompt)) return true;
    if (!valuesMatch(current, raw)) return false;
    if (shouldUsePlainEditableReplacement(field)) {
      if (replaceEditableViaPageBridgeNow(field, optimizedPrompt)) return true;
      if (replaceEditableViaNativeInput(field, optimizedPrompt)) return valuesMatch(getValue(field), optimizedPrompt);
      if (replaceEditableDomValuePlain(field, optimizedPrompt)) return valuesMatch(getValue(field), optimizedPrompt);
      return valuesMatch(getValue(field), optimizedPrompt);
    }
    return !!setValue(field, optimizedPrompt) && valuesMatch(getValue(field), optimizedPrompt);
  }

  function scheduleInlineModelSync(field) {
    field = resolvePromptField(field);
    if (!field || !needsInlineModelSyncBeforeTrustedSend(field)) return;
    if (settings.collapsed || globalSettings.paused || settings.paused || processing) return;
    if (performance.now() < suppressInlineModelSyncUntil || inlineModelSyncInProgress) return;
    const raw = getValue(field).trim();
    if (raw.length < INLINE_MODEL_SYNC_MIN_CHARS || !/\s/.test(raw)) {
      clearInlineModelSync();
      markInlineModelSync("idle");
      return;
    }
    if (field === inlineModelSyncField && inlineModelSyncOutput && valuesMatch(raw, inlineModelSyncOutput)) return;
    if (inlineModelSyncTimer && field === inlineModelSyncField && valuesMatch(raw, inlineModelSyncRaw)) return;
    inlineModelSyncField = field;
    inlineModelSyncRaw = raw;
    inlineModelSyncOutput = "";
    inlineModelSyncMetrics = null;
    clearInlineModelSync({ keepLast: true });
    inlineModelSyncTimer = setTimeout(() => {
      inlineModelSyncTimer = null;
      runInlineModelSync(field, raw);
    }, INLINE_MODEL_SYNC_DEBOUNCE_MS);
    markInlineModelSync("scheduled");
  }

  async function runInlineModelSync(field, raw) {
    field = resolvePromptField(field);
    if (!field || !field.isConnected || !isVisibleField(field)) return;
    if (settings.collapsed || globalSettings.paused || settings.paused || processing) return;
    if (!needsInlineModelSyncBeforeTrustedSend(field)) return;
    if (!valuesMatch(getValue(field), raw)) return;
    const result = previewPrompt(raw);
    const optimizedPrompt = result?.optimizedPrompt || raw;
    if (!String(optimizedPrompt || "").trim() || valuesMatch(optimizedPrompt, raw)) return;

    inlineModelSyncInProgress = true;
    markInlineModelSync("syncing");
    suppressInlineModelSyncUntil = performance.now() + 1200;
    try {
      const committed = await commitInlineModelSyncValue(field, optimizedPrompt, raw);
      if (!committed) {
        markInlineModelSync("failed");
        return;
      }
      inlineModelSyncField = field;
      inlineModelSyncRaw = raw;
      inlineModelSyncOutput = optimizedPrompt;
      inlineModelSyncMetrics = result?.metrics || result?.result?.metrics || null;
      if (composerField && activeField === field) {
        composerField.value = optimizedPrompt;
        autosize();
      }
      markInlineModelSync("ready");
      schedulePosition();
    } finally {
      inlineModelSyncInProgress = false;
    }
  }

  async function commitValue(el, v) {
    el = resolvePromptField(el);
    if (!el) return false;
    const settleMs = shouldUsePlainEditableReplacement(el) ? 360 : (isQuillEditor(el) ? 650 : 180);
    if (shouldUsePlainEditableReplacement(el) && await replaceEditableViaPageBridge(el, v)) {
      await sleep(180);
      if (valuesMatch(getValue(el), v)) return true;
    }
    for (let i = 0; i < 4; i++) {
      if (setValue(el, v)) {
        await sleep(settleMs);
        if (valuesMatch(getValue(el), v)) return true;
      }
      await sleep(35);
    }
    return valuesMatch(getValue(el), v);
  }

  function findSendButton(target) {
    target = resolvePromptField(target) || target;
    const root = adapterClosest(target, "surfaceSelectors") || target?.closest?.("form") || target?.parentElement?.parentElement || document;
    const adapterSend = querySelectorList(root, providerSelectors("sendSelectors"));
    const candidates = [...adapterSend, ...root.querySelectorAll('button, [role="button"], input[type="submit"]')];
    const seen = new Set();
    for (const b of candidates) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (b.closest(".prism-composer")) continue;
      if (matchesProviderSendSelector(b)) return b;
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.getAttribute("title") || "").toLowerCase();
      const text = (b.textContent || "").toLowerCase();
      const dataTest = (b.getAttribute("data-testid") || "").toLowerCase();
      if (/send|submit|message|run/.test(aria + " " + title + " " + text + " " + dataTest)) return b;
    }
    return null;
  }

  function isButtonDisabled(btn) {
    if (!btn) return true;
    const ariaDisabled = String(btn.getAttribute?.("aria-disabled") || "").toLowerCase();
    return !!btn.disabled || ariaDisabled === "true" || btn.dataset?.disabled === "true";
  }

  function dispatchEnter(el) {
    el = resolvePromptField(el) || el;
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function trySend(target) {
    target = resolvePromptField(target) || target;
    for (let i = 0; i < 12; i++) {
      const btn = findSendButton(target);
      if (btn && !isButtonDisabled(btn)) {
        forwardingNativeSend = true;
        try {
          btn.click();
        } finally {
          setTimeout(() => { forwardingNativeSend = false; }, 0);
        }
        return true;
      }
      await sleep(25);
    }
    forwardingNativeSend = true;
    try {
      dispatchEnter(target);
    } finally {
      setTimeout(() => { forwardingNativeSend = false; }, 0);
    }
    return true;
  }

  function scheduleTrustedNativeSendFallback(field, expectedValue) {
    field = resolvePromptField(field);
    if (!field || !needsInlineModelSyncBeforeTrustedSend(field)) return;
    const target = field;
    const expected = String(expectedValue || "").trim();
    if (!expected) return;
    setTimeout(() => {
      if (forwardingNativeSend || processing) return;
      if (!target.isConnected || !isVisibleField(target)) return;
      if (!valuesMatch(getValue(target), expected)) return;
      trySend(target);
    }, nativeSendDelay(target));
  }

  // ---------- field detection ----------
  function isVisibleField(el) {
    const field = resolvePromptField(el);
    if (!field || !field.isConnected) return false;
    if (field.closest(".prism-composer")) return false;
    if (isLikelyAuthOrUtilityField(field)) return false;
    if (!isEditableSurfaceUsable(field)) return false;
    const r = field.getBoundingClientRect();
    const minHeight = field.getAttribute?.("role") === "textbox" || field.isContentEditable ? 18 : 30;
    if (r.width < 220 || r.height < minHeight) return false;
    if (!hasMeaningfulViewportIntersection(r)) return false;
    return true;
  }

  function isEditableSurfaceUsable(field) {
    const style = getComputedStyle(field);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0.03) return false;
    if (style.pointerEvents === "none") return false;
    if (field.disabled || field.readOnly) return false;
    if (String(field.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return false;
    if (String(field.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") return false;
    if (field.closest?.("[hidden],[inert],[aria-hidden='true']")) return false;
    return true;
  }

  function hasMeaningfulViewportIntersection(rect) {
    if (!rect) return false;
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const visibleWidth = Math.max(0, right - left);
    const visibleHeight = Math.max(0, bottom - top);
    const visibleArea = visibleWidth * visibleHeight;
    const fieldArea = Math.max(1, rect.width * rect.height);
    return visibleWidth >= Math.min(180, rect.width * 0.55) &&
      visibleHeight >= Math.min(18, rect.height * 0.45) &&
      visibleArea / fieldArea >= 0.28;
  }

  function shouldAttachPrismToField(field) {
    field = resolvePromptField(field);
    if (!field || !isVisibleField(field)) return false;
    if (peekState.active && peekState.field === field) return true;
    if (fieldHasPromptContent(field)) return true;
    if (isFieldFocused(field)) return true;
    if (isStrongPromptAffordance(field)) return true;
    if (settings.collapsed && field === activeField) return true;
    return isLikelyDockedPromptSurface(field.getBoundingClientRect()) &&
      isLikelyDockedPromptSurface(getPromptSurfaceRect(field));
  }

  function fieldHasPromptContent(field) {
    return normalizedValue(getValue(field)).length > 0;
  }

  function isStrongPromptAffordance(field) {
    const tokens = [
      field.id,
      field.getAttribute?.("data-testid"),
      field.getAttribute?.("placeholder"),
      field.getAttribute?.("aria-placeholder"),
      field.getAttribute?.("aria-label"),
      field.getAttribute?.("name"),
      field.closest?.("form")?.getAttribute?.("data-testid"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/\bask[-_\s]?input\b/.test(tokens)) return true;
    if (/(email|password|search|filter|username|login|sign in|sign up)/.test(tokens)) return false;
    return /prompt-textarea|prompt textarea|ask anything|message chatgpt|chat with chatgpt|send a message|message the model|composer|chat composer/.test(tokens);
  }

  function isFieldFocused(field) {
    try {
      if (field.matches?.(":focus,:focus-within")) return true;
    } catch {}

    const active = document.activeElement;
    if (active) {
      if (active === field || field.contains?.(active)) return true;
      const activeIsPageRoot = active === document.body || active === document.documentElement;
      if (!activeIsPageRoot && active.contains?.(field)) return true;
    }

    const root = field.getRootNode?.();
    const rootActive = root && root !== document ? root.activeElement : null;
    if (rootActive) {
      if (rootActive === field || field.contains?.(rootActive)) return true;
      if (rootActive !== document.body && rootActive !== document.documentElement && rootActive.contains?.(field)) return true;
    }

    const selection = window.getSelection?.();
    const anchor = selection?.anchorNode;
    const anchorEl = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    const activeIsPageRoot = !active || active === document.body || active === document.documentElement;
    return !!(activeIsPageRoot && document.hasFocus?.() && selection?.rangeCount && anchorEl &&
      (anchorEl === field || field.contains?.(anchorEl)));
  }

  function isLikelyDockedPromptSurface(rect) {
    if (!rect) return false;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + viewportHeight;
    const bottomZoneHeight = Math.max(180, Math.min(320, viewportHeight * 0.38));
    const maxPassiveHeight = Math.max(84, Math.min(280, viewportHeight * 0.42));
    return rect.bottom >= viewportBottom - bottomZoneHeight &&
      rect.top < viewportBottom - 16 &&
      rect.height <= maxPassiveHeight;
  }

  function isLikelyAuthOrUtilityField(field) {
    const tag = field.tagName?.toLowerCase();
    const type = String(field.getAttribute?.("type") || "").toLowerCase();
    const autocomplete = String(field.getAttribute?.("autocomplete") || "").toLowerCase();
    const inputMode = String(field.getAttribute?.("inputmode") || "").toLowerCase();
    const text = [
      field.getAttribute?.("placeholder"),
      field.getAttribute?.("aria-label"),
      field.getAttribute?.("name"),
      field.getAttribute?.("id"),
      field.closest?.("form")?.innerText,
      field.closest?.("[role='dialog']")?.innerText,
    ].filter(Boolean).join(" ").toLowerCase();

    if (tag === "input" && !["", "text", "search"].includes(type)) return true;
    if (/(email|password|one-time-code|username|tel|phone|url)/.test([type, autocomplete, inputMode].join(" "))) return true;
    if (/(log in|login|sign in|sign up|continue with|email address|password|phone|verification|captcha)/.test(text)) return true;
    if (tag === "input" && !/(ask|message|prompt|chat|question|anything|search the web|what do you want|what are you)/.test(text)) return true;
    return false;
  }

  function findVisiblePromptField() {
    const seen = new Set();
    const adapterFields = querySelectorList(document, providerSelectors("fieldSelectors"));
    const genericFields = [...document.querySelectorAll(PROMPT_FIELD_SELECTOR)];
    const all = [...adapterFields, ...genericFields]
      .map(resolvePromptField)
      .filter(Boolean)
      .filter((field) => {
        if (seen.has(field)) return false;
        seen.add(field);
        return isVisibleField(field);
      });
    if (!all.length) return null;
    // Prefer the lowest field on the page (chat surfaces put the input at the bottom).
    all.sort((a, b) => fieldRank(b) - fieldRank(a));
    return all[0];
  }

  function fieldRank(field) {
    const r = field.getBoundingClientRect();
    const text = [
      field.getAttribute?.("placeholder"),
      field.getAttribute?.("aria-label"),
      field.getAttribute?.("data-testid"),
      field.id,
      field.className,
      field.closest?.("form")?.getAttribute?.("data-testid"),
      field.closest?.("form")?.className,
    ].filter(Boolean).join(" ");
    let score = r.bottom;
    if (/prompt|composer|message|chat|ask|anything|question|query|search/i.test(text)) score += 260;
    if (providerSelectors("fieldSelectors").some((selector) => matchesSelector(field, selector))) score += 180;
    if (field.closest?.("form")) score += 60;
    return score;
  }

  function matchesSelector(el, selector) {
    try {
      return !!el.matches?.(selector) || !!el.closest?.(selector);
    } catch {
      return false;
    }
  }

  function adapterClosest(field, kind) {
    for (const selector of providerSelectors(kind)) {
      try {
        const hit = field.closest?.(selector);
        if (hit) return hit;
      } catch {}
    }
    return null;
  }

  // ---------- skin/mask overlay geometry ----------
  // Prism behaves like a visual skin over the host AI input pill. The native
  // field remains the real typing surface; Prism only tints the composer and
  // exposes native controls through mask cutouts.
  function getHostSurfaceRect(field) {
    const fieldRect = field.getBoundingClientRect();
    const candidates = new Set([
      adapterClosest(field, "surfaceSelectors"),
      field.closest("form"),
      field.closest("[data-testid*='composer']"),
      field.closest("[data-testid*='prompt']"),
      field.closest("[class*='composer']"),
      field.closest("[class*='prompt']"),
      field.parentElement,
    ].filter(Boolean));

    for (const el of querySelectorList(document, providerSelectors("surfaceSelectors"))) {
      try {
        if (el.contains(field) || field.contains(el)) candidates.add(el);
      } catch {}
    }

    let ancestor = field.parentElement;
    let depth = 0;
    while (ancestor && depth < 10) {
      candidates.add(ancestor);
      ancestor = ancestor.parentElement;
      depth += 1;
    }

    let best = null;
    let bestElement = null;
    let bestScore = -Infinity;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const maxComposerHeight = Math.min(560, Math.max(260, window.innerHeight * 0.72));
      if (r.width < Math.max(260, fieldRect.width * 0.72)) continue;
      if (r.height < 34 || r.height > maxComposerHeight) continue;
      const overlap = Math.min(r.bottom, fieldRect.bottom) - Math.max(r.top, fieldRect.top);
      if (overlap < Math.min(fieldRect.height, r.height) * 0.25) continue;
      const controlCount = countControlsInside(el, r);
      const style = getComputedStyle(el);
      const radius = parseFloat(style.borderRadius) || 0;
      const composerHint = /composer|prompt|input|chat/i.test([
        el.className,
        el.id,
        el.getAttribute?.("data-testid"),
        el.getAttribute?.("aria-label"),
      ].filter(Boolean).join(" "));
      const widthPenalty = Math.max(0, r.width - Math.min(980, window.innerWidth * 0.86)) * 1.8;
      const expectedTallHeight = Math.max(180, fieldRect.height + 72);
      const heightPenalty = Math.max(0, r.height - expectedTallHeight) * 1.4;
      const bottomPenalty = Math.abs(r.bottom - fieldRect.bottom) * 1.3;
      const centerPenalty = Math.abs((r.top + r.height / 2) - (fieldRect.top + fieldRect.height / 2)) * 0.5;
      const edgeSlackPenalty = hostEdgeSlackPenalty(field, el, r);
      const score =
        r.width +
        controlCount * 130 +
        Math.min(radius, 40) * 4 +
        (composerHint ? 180 : 0) -
        widthPenalty -
        heightPenalty -
        bottomPenalty -
        centerPenalty -
        edgeSlackPenalty;
      if (score > bestScore) { best = r; bestElement = el; bestScore = score; }
    }
    const stable = preferOuterHostSurface(field, candidates, bestElement || field, best || fieldRect);
    const refined = refineHostSurface(field, stable.element, stable.rect);
    return normalizeHostSurfaceRect(refined.rect, field, refined.element);
  }

  function preferOuterHostSurface(field, candidates, currentElement, currentRect) {
    if (surfaceAdapter().surfaceMode !== "outer" || !currentElement) {
      return { element: currentElement, rect: currentRect };
    }

    const fieldRect = field.getBoundingClientRect();
    const maxComposerHeight = Math.min(560, Math.max(260, window.innerHeight * 0.72));
    let chosen = { element: currentElement, rect: currentRect, score: currentRect.height || 0 };

    for (const el of candidates) {
      if (!el || el === currentElement) continue;
      if (!el.contains?.(currentElement) && !el.contains?.(field)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < Math.max(260, fieldRect.width * 0.72)) continue;
      if (r.height < 34 || r.height > maxComposerHeight) continue;
      if (r.width < currentRect.width * 0.84 || r.width > currentRect.width + 140) continue;
      if (r.height < currentRect.height - 2) continue;
      const containsField =
        r.left <= fieldRect.left + 2 &&
        r.right >= fieldRect.right - 2 &&
        r.top <= fieldRect.top + 2 &&
        r.bottom >= fieldRect.bottom - 2;
      if (!containsField) continue;

      const visualWeight = surfaceVisualWeight(el);
      if (visualWeight < 2) continue;

      const composerHint = /composer|prompt|input|chat/i.test([
        el.className,
        el.id,
        el.getAttribute?.("data-testid"),
        el.getAttribute?.("aria-label"),
      ].filter(Boolean).join(" "));
      const heightGain = r.height - currentRect.height;
      const score =
        r.height +
        visualWeight * 120 +
        countControlsInside(el, r) * 40 +
        (composerHint ? 120 : 0) +
        Math.max(0, heightGain) * 2;

      if (score > chosen.score) chosen = { element: el, rect: r, score };
    }

    return { element: chosen.element, rect: chosen.rect };
  }

  function hostEdgeSlackPenalty(field, hostElement, hostRect) {
    if (!field || !hostElement || !hostRect?.width) return 0;
    const fieldRect = field.getBoundingClientRect();
    const rects = [fieldRect];
    let controlCount = 0;
    const visit = (el) => {
      if (!el || el === field || el.closest?.(".prism-composer,.prism-badge")) return;
      if (isEditableElement(el) || resolvePromptField(el) === field) return;
      if (!isVisibleControl(el) || !isNativeControlCandidate(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX < hostRect.left || centerX > hostRect.right || centerY < hostRect.top - 10 || centerY > hostRect.bottom + 10) return;
      if (rect.width > Math.max(260, hostRect.width * 0.42) || rect.height > Math.max(84, hostRect.height + 36)) return;
      rects.push(rect);
      controlCount += 1;
    };

    try {
      if (hostElement.matches?.(nativeControlSelector())) visit(hostElement);
      for (const el of hostElement.querySelectorAll?.(nativeControlSelector()) || []) visit(el);
    } catch {}

    if (controlCount < 2) return 0;
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const leftSlack = Math.max(0, left - hostRect.left);
    const rightSlack = Math.max(0, hostRect.right - right);
    const balancedSlack = Math.min(leftSlack, rightSlack);
    const totalSlack = leftSlack + rightSlack;
    return Math.max(0, balancedSlack - 56) * 5 + Math.max(0, totalSlack - hostRect.width * 0.28) * 1.2;
  }

  function refineHostSurface(field, hostElement, hostRect) {
    if (!hostElement || hostElement === field) return { element: hostElement || field, rect: hostRect };
    if (surfaceAdapter().surfaceMode === "outer") return { element: hostElement, rect: hostRect };
    const fieldRect = field.getBoundingClientRect();
    const minimumDetachedHeight = Math.max(24, hostRect.height * 0.12);
    let bestNested = null;
    let bestNestedScore = -Infinity;
    let el = field.parentElement;
    let depth = 0;

    while (el && depth < 10) {
      if (el === hostElement) break;
      const r = el.getBoundingClientRect();
      const containsField =
        r.left <= fieldRect.left + 2 &&
        r.right >= fieldRect.right - 2 &&
        r.top <= fieldRect.top + 2 &&
        r.bottom >= fieldRect.bottom - 2;
      const detachedBelow = hostRect.bottom - r.bottom;
      const usable =
        containsField &&
        detachedBelow >= minimumDetachedHeight &&
        r.width >= Math.max(260, fieldRect.width * 0.72, hostRect.width * 0.68) &&
        r.height >= Math.max(42, fieldRect.height) &&
        r.height < hostRect.height - 12;

      if (usable) {
        const controlCount = countControlsInside(el, r);
        const visualWeight = surfaceVisualWeight(el);
        if (controlCount >= 2 || visualWeight >= 2) {
          const bottomCloseness = Math.abs(r.bottom - fieldRect.bottom);
          const score =
            detachedBelow * 2 +
            controlCount * 150 +
            visualWeight * 90 +
            Math.min(r.width, hostRect.width) * 0.08 -
            bottomCloseness * 0.4;
          if (score > bestNestedScore) {
            bestNested = { element: el, rect: r };
            bestNestedScore = score;
          }
        }
      }

      el = el.parentElement;
      depth += 1;
    }

    return bestNested || { element: hostElement, rect: hostRect };
  }

  function surfaceVisualWeight(el) {
    try {
      const style = getComputedStyle(el);
      let score = 0;
      const radius = parseRadius(style.borderRadius);
      if (radius >= 8) score += 2;
      if (!isTransparent(style.backgroundColor)) score += 2;
      if (style.boxShadow && style.boxShadow !== "none") score += 1;
      const borderWidth = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]
        .map((prop) => Number.parseFloat(style[prop]) || 0)
        .reduce((sum, value) => sum + value, 0);
      if (borderWidth > 0) score += 1;
      return score;
    } catch {
      return 0;
    }
  }

  function normalizeHostSurfaceRect(rect, field, hostElement) {
    return decorateHostRect(rect, hostElement);
  }

  function decorateHostRect(rect, hostElement) {
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      x: rect.x ?? rect.left,
      y: rect.y ?? rect.top,
      hostElement: hostElement || null,
      ...hostRectDecoration(rect, hostElement),
    };
  }

  function hostRectDecoration(rect, hostElement) {
    const radius = hostElement ? parseRadius(getComputedStyle(hostElement).borderRadius) : 0;
    return {
      hostRadius: radius,
      hostRadiusSource: radius ? "computed" : "fallback",
    };
  }

  function parseRadius(value) {
    if (!value) return 0;
    const first = String(value).split(/[ /]/).find(Boolean);
    const parsed = Number.parseFloat(first);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getPromptSurfaceRect(field) {
    const fieldRect = field.getBoundingClientRect();
    const hostRect = getHostSurfaceRect(field);
    const controlRects = getNativeControlRects(field, hostRect);
    const sendRect = getNativeSendRect(field, hostRect, controlRects);
    const layout = isStackedComposer(fieldRect, hostRect, controlRects) ? "stacked" : "pill";

    const inputRowTop = fieldRect.top - 8;
    const inputRowBottom = fieldRect.bottom + 8;
    const inputRowControls = controlRects.filter((r) => {
      const centerY = r.top + r.height / 2;
      return centerY >= inputRowTop && centerY <= inputRowBottom;
    });

    const leftControlRight = inputRowControls
      .filter((r) => r.left <= fieldRect.left + Math.max(120, fieldRect.width * 0.35))
      .filter((r) => r.right <= fieldRect.left + Math.max(180, fieldRect.width * 0.45))
      .reduce((max, r) => Math.max(max, r.right), -Infinity);

    const rightControlLeft = inputRowControls
      .filter((r) => r.left >= fieldRect.left + 80)
      .reduce((min, r) => Math.min(min, r.left), Infinity);

    const bottomControlTop = controlRects
      .filter((r) => r.top > Math.max(fieldRect.top + fieldRect.height * 0.55, hostRect.top + hostRect.height * 0.42))
      .reduce((min, r) => Math.min(min, r.top), Infinity);

    const inputLeft = layout === "stacked"
      ? clamp(fieldRect.left, hostRect.left + 8, hostRect.right - 180)
      : Math.max(hostRect.left + 52, Number.isFinite(leftControlRight) ? leftControlRight + 12 : fieldRect.left);
    const inputRight = layout === "stacked"
      ? clamp(fieldRect.right, inputLeft + 180, hostRect.right - 8)
      : Math.min(
          Number.isFinite(rightControlLeft) ? rightControlLeft - 12 : hostRect.right - 64,
          hostRect.right - 64,
          Math.max(fieldRect.right, hostRect.right - 160)
        );
    const inputTop = layout === "stacked"
      ? clamp(fieldRect.top, hostRect.top + 4, hostRect.bottom - 28)
      : Math.max(hostRect.top + 7, Math.min(fieldRect.top, hostRect.bottom - 48));
    const inputBottom = layout === "stacked"
      ? Math.min(
          Number.isFinite(bottomControlTop) ? bottomControlTop - 4 : fieldRect.bottom,
          Math.max(fieldRect.bottom, inputTop + Math.min(44, Math.max(24, fieldRect.height))),
          hostRect.bottom - 4
        )
      : Math.min(
          Number.isFinite(bottomControlTop) ? bottomControlTop - 8 : hostRect.bottom - 7,
          Math.max(fieldRect.bottom, inputTop + 40)
        );

    const safeInputLeft = clamp(inputLeft, hostRect.left + 12, hostRect.right - 180);
    const safeInputRight = clamp(inputRight, safeInputLeft + 180, hostRect.right - 12);
    const safeInputTop = clamp(inputTop, hostRect.top + 4, hostRect.bottom - 24);
    const safeInputBottom = clamp(inputBottom, safeInputTop + 24, hostRect.bottom - 4);
    const skinRadius = resolveSurfaceSkinRadius(hostRect);

    return {
      left: hostRect.left,
      right: hostRect.right,
      top: hostRect.top,
      bottom: hostRect.bottom,
      width: Math.max(220, hostRect.width),
      height: Math.max(42, hostRect.height),
      x: hostRect.left,
      y: hostRect.top,
      layout,
      skinRadius,
      hostRect,
      hostElement: hostRect.hostElement || null,
      sendRect,
      controlRects,
      inputRect: {
        left: safeInputLeft,
        right: safeInputRight,
        top: safeInputTop,
        bottom: safeInputBottom,
        width: safeInputRight - safeInputLeft,
        height: safeInputBottom - safeInputTop,
      },
    };
  }

  function isStackedComposer(fieldRect, hostRect, controlRects) {
    if (hostRect.height < 84) return false;
    const fieldCenter = fieldRect.top + fieldRect.height / 2;
    const lowerControls = controlRects.filter((r) => r.top > fieldCenter && r.bottom <= hostRect.bottom + 8);
    const hasBottomRow = lowerControls.length >= 2 || lowerControls.some((r) => r.width > 80);
    const fieldLivesHigh = fieldRect.top <= hostRect.top + hostRect.height * 0.45;
    return hasBottomRow && fieldLivesHigh;
  }

  function resolveSurfaceSkinRadius(hostRect) {
    const resolver = window.PrismCore?.resolveSkinRadius;
    if (typeof resolver === "function") {
      return resolver({
        hostRadius: hostRect.hostRadius,
        width: hostRect.width,
        height: hostRect.height,
      });
    }
    const maxPhysicalRadius = Math.max(0, Math.min((hostRect.width || 0) / 2, (hostRect.height || 0) / 2));
    if (!maxPhysicalRadius) return 0;
    const isTall = hostRect.height >= 96;
    const maxUsefulRadius = isTall ? Math.min(56, maxPhysicalRadius) : maxPhysicalRadius;
    if (hostRect.hostRadius > 0) return Math.min(hostRect.hostRadius, maxUsefulRadius);
    return isTall ? Math.min(48, maxUsefulRadius) : Math.min(Math.max(24, hostRect.height / 2), maxUsefulRadius);
  }

  function getNativeControlRects(field, hostRect) {
    const padded = {
      left: hostRect.left - 8,
      right: hostRect.right + 8,
      top: hostRect.top - 12,
      bottom: hostRect.bottom + 12,
    };
    const rects = dedupeControlRects(collectNativeControlRects(getControlSearchRoots(field), field, hostRect, padded));
    if (rects.length) return rects;

    const documentRects = dedupeControlRects(collectNativeControlRects([document.body], field, hostRect, padded));
    if (documentRects.length) return documentRects;

    return getFallbackNativeControlRects(field, hostRect);
  }

  function collectNativeControlRects(roots, field, hostRect, padded) {
    const selector = nativeControlSelector();
    const seen = new Set();
    const candidates = [];
    const addCandidate = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || seen.has(el)) return;
      seen.add(el);
      candidates.push(el);
    };
    for (const root of roots.filter(Boolean)) {
      try {
        if (root.matches?.(selector)) addCandidate(root);
        for (const el of root.querySelectorAll?.(selector) || []) {
          addCandidate(el);
        }
        for (const el of collectVisualControlElements(root, field, hostRect, padded)) {
          addCandidate(el);
        }
      } catch {}
    }

    const items = candidates
      .filter((el) => !el.closest(".prism-composer") && !el.closest(".prism-badge"))
      .filter((el) => !isEditableElement(el) && resolvePromptField(el) !== field)
      .filter((el) => isVisibleControl(el))
      .map((el) => {
        const rect = rectFromDomRect(el.getBoundingClientRect(), controlCornerRadius(el));
        const visualWeight = controlSurfaceVisualWeight(el, rect);
        return {
          el,
          rect,
          rank: controlElementRank(el) + Math.min(40, visualWeight),
          visualWeight,
        };
      })
      .filter(({ el, rect }) => isNativeControlCandidate(el) || isVisualControlSurface(el, rect, field, hostRect))
      .filter(({ rect: r }) => r.width >= 8 && r.height >= 8)
      .filter(({ rect: r }) => r.right >= padded.left && r.left <= padded.right && r.bottom >= padded.top && r.top <= padded.bottom)
      .filter(({ rect: r }) => {
        const centerY = r.top + r.height / 2;
        const nearVerticalBand = centerY >= hostRect.top - 10 && centerY <= hostRect.bottom + 10;
        const verticalOverlap = Math.min(r.bottom, hostRect.bottom) - Math.max(r.top, hostRect.top);
        const overlapsComposer = verticalOverlap >= Math.min(r.height, hostRect.height) * 0.28;
        const compact = r.width <= Math.max(220, hostRect.width * 0.36) && r.height <= Math.max(78, hostRect.height + 34);
        return (nearVerticalBand || overlapsComposer) && compact;
      });

    return normalizeControlItems(items);
  }

  function collectVisualControlElements(root, field, hostRect, padded) {
    const elements = [];
    const scan = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (el.closest?.(".prism-composer") || el.closest?.(".prism-badge")) return;
      if (el === field || el.contains?.(field) || field.contains?.(el)) return;
      const tag = String(el.localName || "").toLowerCase();
      if (["svg", "path", "use", "g", "circle", "rect", "line", "polyline", "polygon"].includes(tag)) return;
      const rect = rectFromDomRect(el.getBoundingClientRect(), controlCornerRadius(el));
      if (rect.width < 8 || rect.height < 8) return;
      if (rect.right < padded.left || rect.left > padded.right || rect.bottom < padded.top || rect.top > padded.bottom) return;
      if (!isVisualControlSurface(el, rect, field, hostRect)) return;
      elements.push(el);
    };

    try { scan(root); } catch {}
    let scanned = 0;
    try {
      for (const el of root.querySelectorAll?.("*") || []) {
        scanned += 1;
        if (scanned > 1400) break;
        scan(el);
      }
    } catch {}
    return elements;
  }

  function getControlSearchRoots(field) {
    const roots = new Set([
      adapterClosest(field, "surfaceSelectors"),
      getControlSearchRoot(field),
      field.closest?.("form"),
      field.closest?.("[data-testid*='composer']"),
      field.closest?.("[data-testid*='prompt']"),
      field.closest?.("[class*='composer']"),
      field.closest?.("[class*='prompt']"),
      field.parentElement,
    ].filter(Boolean));

    const adapterRoot = adapterClosest(field, "surfaceSelectors");
    if (adapterRoot) {
      for (const el of querySelectorList(adapterRoot, providerSelectors("controlSelectors"))) roots.add(el.parentElement || el);
    }

    let ancestor = field.parentElement;
    let depth = 0;
    while (ancestor && depth < 12) {
      roots.add(ancestor);
      ancestor = ancestor.parentElement;
      depth += 1;
    }
    return [...roots];
  }

  function dedupeControlRects(rects) {
    const sorted = rects
      .slice()
      .sort((a, b) => b.width * b.height - a.width * a.height || a.left - b.left || a.top - b.top);
    const kept = [];
    for (const rect of sorted) {
      const duplicate = kept.some((existing) => {
        const samePosition = Math.abs(existing.left - rect.left) <= 2 &&
          Math.abs(existing.top - rect.top) <= 2 &&
          Math.abs(existing.width - rect.width) <= 3 &&
          Math.abs(existing.height - rect.height) <= 3;
        const contained = rect.left >= existing.left - 1 &&
          rect.right <= existing.right + 1 &&
          rect.top >= existing.top - 1 &&
          rect.bottom <= existing.bottom + 1;
        const overlap = intersectionArea(existing, rect);
        const rectArea = Math.max(1, rect.width * rect.height);
        const existingArea = Math.max(1, existing.width * existing.height);
        const nearlySameSurface = overlap / Math.min(rectArea, existingArea) >= 0.82 &&
          Math.abs(existing.width - rect.width) <= Math.max(8, Math.min(existing.width, rect.width) * 0.2) &&
          Math.abs(existing.height - rect.height) <= Math.max(8, Math.min(existing.height, rect.height) * 0.2);
        return samePosition || contained || nearlySameSurface;
      });
      if (!duplicate) kept.push(rect);
    }
    return kept.sort((a, b) => a.left - b.left || a.top - b.top);
  }

  function normalizeControlItems(items) {
    const topLevel = items.filter((item) => !shouldDropControlItem(item, items));
    return dedupeControlRects(topLevel.map((item) => item.rect));
  }

  function shouldDropControlItem(item, items) {
    for (const other of items) {
      if (other === item) continue;
      if (!rectContains(other.rect, item.rect, 2) && !rectMostlyOverlaps(other.rect, item.rect, 0.88)) continue;

      const otherContainsItem = other.el.contains?.(item.el);
      const itemContainsOther = item.el.contains?.(other.el);
      if (otherContainsItem && preferAncestorControl(other, item)) return true;
      if (itemContainsOther && preferDescendantControl(other, item)) return true;
    }
    return false;
  }

  function preferAncestorControl(ancestor, child) {
    if (isPreferredVisualSurface(ancestor, child)) return true;
    const ancestorArea = Math.max(1, ancestor.rect.width * ancestor.rect.height);
    const childArea = Math.max(1, child.rect.width * child.rect.height);
    const childIsBetterControl = isNativeSemanticControl(child.el) &&
      child.rank > ancestor.rank + 8 &&
      ancestorArea > childArea * 1.35;
    if (isNativeSemanticControl(ancestor.el) && !childIsBetterControl) return true;
    return ancestor.rank >= child.rank;
  }

  function preferDescendantControl(descendant, ancestor) {
    if (isPreferredVisualSurface(ancestor, descendant)) return false;
    if (isNativeSemanticControl(ancestor.el) && ancestor.rank >= descendant.rank) return false;
    const ancestorArea = Math.max(1, ancestor.rect.width * ancestor.rect.height);
    const descendantArea = Math.max(1, descendant.rect.width * descendant.rect.height);
    return descendant.rank > ancestor.rank + 12 && ancestorArea > descendantArea * 1.35;
  }

  function isPreferredVisualSurface(surface, fragment) {
    if (!surface?.el?.contains?.(fragment?.el)) return false;
    const surfaceArea = Math.max(1, surface.rect.width * surface.rect.height);
    const fragmentArea = Math.max(1, fragment.rect.width * fragment.rect.height);
    if (surfaceArea <= fragmentArea * 1.12) return false;

    const surfaceWeight = Number.isFinite(surface.visualWeight)
      ? surface.visualWeight
      : controlSurfaceVisualWeight(surface.el, surface.rect);
    const fragmentWeight = Number.isFinite(fragment.visualWeight)
      ? fragment.visualWeight
      : controlSurfaceVisualWeight(fragment.el, fragment.rect);
    if (surfaceWeight < 28) return false;

    const largerSurface =
      surface.rect.width >= fragment.rect.width + 10 ||
      surface.rect.height >= fragment.rect.height + 8 ||
      surfaceArea >= fragmentArea * 1.8;
    if (!largerSurface) return false;

    const style = getComputedStyle(surface.el);
    const paintedSurface = hasVisibleControlPaint(style) || controlCornerRadius(surface.el, style) >= 8;
    return paintedSurface && (surfaceWeight >= fragmentWeight - 18 || controlTextEvidence(surface.el) || surfaceArea >= fragmentArea * 1.8);
  }

  function rectContains(outer, inner, tolerance = 0) {
    return inner.left >= outer.left - tolerance &&
      inner.right <= outer.right + tolerance &&
      inner.top >= outer.top - tolerance &&
      inner.bottom <= outer.bottom + tolerance;
  }

  function rectMostlyOverlaps(a, b, threshold = 0.84) {
    const overlap = intersectionArea(a, b);
    if (!overlap) return false;
    return overlap / Math.min(Math.max(1, a.width * a.height), Math.max(1, b.width * b.height)) >= threshold;
  }

  function intersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function rectFromDomRect(r, radius = null) {
    const rect = {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      x: r.left,
      y: r.top,
    };
    if (Number.isFinite(radius)) rect.radius = radius;
    return rect;
  }

  function makeRect(left, top, width, height) {
    return {
      left,
      right: left + width,
      top,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
    };
  }

  function getFallbackNativeControlRects(field, hostRect) {
    const fieldRect = field.getBoundingClientRect();
    const lowerToolbar = hostRect.height >= 84 && fieldRect.top <= hostRect.top + hostRect.height * 0.46;
    const size = clamp(Math.min(44, hostRect.height - 18), 34, 46);
    const centerY = lowerToolbar
      ? clamp(Math.max(fieldRect.bottom + 24, hostRect.top + hostRect.height * 0.72), hostRect.top + size / 2 + 4, hostRect.bottom - size / 2 - 6)
      : clamp(fieldRect.top + fieldRect.height / 2, hostRect.top + size / 2 + 4, hostRect.bottom - size / 2 - 4);
    const top = centerY - size / 2;
    const rects = [];

    if (hostRect.width >= 300) {
      rects.push(makeRect(hostRect.left + 12, top, size, size));
      if (lowerToolbar && hostRect.width >= 520) {
        rects.push(makeRect(hostRect.left + 12 + size + 8, top, 92, size));
      }
    }

    if (hostRect.width >= 420) {
      const margin = 12;
      const gap = 8;
      const actionSize = size;
      const sendLeft = hostRect.right - margin - actionSize;
      const micLeft = sendLeft - gap - actionSize;
      const modelWidth = Math.min(148, Math.max(96, hostRect.width * 0.16));
      const modelLeft = Math.max(hostRect.left + hostRect.width * 0.58, micLeft - gap - modelWidth);
      if (modelLeft + modelWidth <= micLeft - gap) rects.push(makeRect(modelLeft, top, modelWidth, size));
      rects.push(makeRect(micLeft, top, actionSize, size));
      rects.push(makeRect(sendLeft, top, actionSize, size));
    }

    return dedupeControlRects(rects);
  }

  function nativeControlSelector() {
    return [
      "button",
      "select",
      "summary",
      "label[for]",
      "[role='button']",
      "[role='menuitem']",
      "[role='combobox']",
      "[role='switch']",
      "[role='checkbox']",
      "[aria-haspopup]",
      "[aria-label]",
      "[data-testid]",
      "[tabindex]:not([tabindex='-1'])",
      "input[type='file']",
      "input[type='button']",
      "input[type='submit']",
      ...PROVIDER_ADAPTERS.flatMap((adapter) => adapter.controlSelectors || []),
    ].join(",");
  }

  function isVisualControlSurface(el, rect, field, hostRect) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || !rect) return false;
    if (el === field || el.contains?.(field) || field.contains?.(el)) return false;
    if (isEditableElement(el) || resolvePromptField(el) === field) return false;

    const tag = String(el.localName || "").toLowerCase();
    if (["svg", "path", "use", "g", "circle", "rect", "line", "polyline", "polygon", "br"].includes(tag)) return false;

    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0.01) return false;
    if (style.pointerEvents === "none" && !isNativeSemanticControl(el)) return false;

    const centerY = rect.top + rect.height / 2;
    const nearComposerBand = centerY >= hostRect.top - 14 && centerY <= hostRect.bottom + 14;
    const verticalOverlap = Math.min(rect.bottom, hostRect.bottom) - Math.max(rect.top, hostRect.top);
    const overlapsComposer = verticalOverlap >= Math.min(rect.height, hostRect.height) * 0.24;
    if (!nearComposerBand && !overlapsComposer) return false;

    const compact =
      rect.width <= Math.max(240, hostRect.width * 0.38) &&
      rect.height <= Math.max(84, hostRect.height + 38);
    if (!compact) return false;

    const hasInteractionCue =
      el.tabIndex >= 0 ||
      style.cursor === "pointer" ||
      el.hasAttribute("onclick") ||
      el.hasAttribute("aria-expanded") ||
      el.hasAttribute("aria-pressed") ||
      el.hasAttribute("aria-haspopup") ||
      isNativeSemanticControl(el);
    const weight = controlSurfaceVisualWeight(el, rect, style);
    return hasInteractionCue && weight >= 30;
  }

  function isNativeControlCandidate(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isNativeSemanticControl(el)) return true;

    const tag = el.localName;
    if (tag === "label") {
      return Boolean(el.getAttribute("for")) || Boolean(el.querySelector?.("input,button,select,textarea"));
    }

    const role = String(el.getAttribute("role") || "").toLowerCase();
    if (["menuitem", "combobox", "switch", "checkbox"].includes(role)) return true;
    if (el.hasAttribute("aria-haspopup")) return true;

    const hasName = Boolean(
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("data-testid") ||
      (el.textContent || "").trim()
    );
    if (!hasName) return false;

    const style = getComputedStyle(el);
    const interactionCue =
      el.tabIndex >= 0 ||
      style.cursor === "pointer" ||
      el.hasAttribute("onclick") ||
      el.hasAttribute("aria-expanded") ||
      el.hasAttribute("aria-pressed");

    if (!interactionCue) return false;

    // Icon spans and label fragments inside a real button should not create
    // their own mask holes; the outer native control owns that visible surface.
    if (el.parentElement?.closest?.(nativeSemanticControlSelector())) return false;
    return true;
  }

  function isNativeSemanticControl(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.localName;
    if (tag === "button" || tag === "select" || tag === "summary") return true;
    if (tag === "input") {
      const type = String(el.getAttribute("type") || "").toLowerCase();
      return ["file", "button", "submit"].includes(type);
    }
    const role = String(el.getAttribute("role") || "").toLowerCase();
    return role === "button";
  }

  function nativeSemanticControlSelector() {
    return [
      "button",
      "select",
      "summary",
      "[role='button']",
      "input[type='file']",
      "input[type='button']",
      "input[type='submit']",
    ].join(",");
  }

  function controlElementRank(el) {
    const tag = el.localName;
    const role = String(el.getAttribute("role") || "").toLowerCase();
    if (tag === "button") return 120;
    if (tag === "select") return 116;
    if (tag === "input") return 112;
    if (role === "button") return 106;
    if (role === "combobox") return 100;
    if (role === "menuitem") return 94;
    if (el.hasAttribute("aria-haspopup")) return 90;
    if (tag === "summary") return 86;
    if (tag === "label") return 76;
    if (el.tabIndex >= 0) return 54;
    if (getComputedStyle(el).cursor === "pointer") return 48;
    return 32;
  }

  function controlSurfaceVisualWeight(el, rect, style = null) {
    if (!el || !rect) return 0;
    const computed = style || getComputedStyle(el);
    let weight = 0;

    if (isNativeSemanticControl(el)) weight += 18;
    if (el.tabIndex >= 0) weight += 12;
    if (computed.cursor === "pointer") weight += 12;
    if (el.hasAttribute("onclick")) weight += 8;
    if (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-pressed") || el.hasAttribute("aria-haspopup")) weight += 8;
    if (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-testid")) weight += 5;

    const radius = controlCornerRadius(el, computed);
    if (radius >= 8) weight += 14;
    if (radius >= Math.min(20, rect.height * 0.35)) weight += 8;
    if (hasVisibleColor(computed.backgroundColor)) weight += 16;
    if (hasVisibleBorder(computed)) weight += 7;
    if (computed.boxShadow && computed.boxShadow !== "none") weight += 5;

    const circleLike = Math.abs(rect.width - rect.height) <= 12 && rect.height >= 28;
    const pillLike = rect.width > rect.height * 1.35 && radius >= rect.height * 0.24;
    if (circleLike || pillLike) weight += 8;
    if (controlTextEvidence(el)) weight += 4;
    return weight;
  }

  function controlCornerRadius(el, style = null) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
    const computed = style || getComputedStyle(el);
    return Math.max(
      cssPixelValue(computed.borderTopLeftRadius),
      cssPixelValue(computed.borderTopRightRadius),
      cssPixelValue(computed.borderBottomRightRadius),
      cssPixelValue(computed.borderBottomLeftRadius),
      cssPixelValue(computed.borderRadius)
    );
  }

  function cssPixelValue(value) {
    const parsed = parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function hasVisibleControlPaint(style) {
    return hasVisibleColor(style.backgroundColor) || hasVisibleBorder(style) || Boolean(style.boxShadow && style.boxShadow !== "none");
  }

  function hasVisibleBorder(style) {
    const hasWidth = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
      .some((value) => cssPixelValue(value) > 0);
    if (!hasWidth) return false;
    return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor]
      .some((value) => hasVisibleColor(value));
  }

  function hasVisibleColor(value) {
    const color = String(value || "").trim().toLowerCase();
    if (!color || color === "transparent") return false;
    const rgba = color.match(/^rgba?\((.+)\)$/);
    if (!rgba) return true;
    const parts = rgba[1].split(",").map((part) => part.trim());
    if (parts.length < 4) return true;
    const alpha = Number(parts[3]);
    return !Number.isFinite(alpha) || alpha > 0.01;
  }

  function controlTextEvidence(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return Boolean(
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("data-testid") ||
      (el.textContent || "").trim()
    );
  }

  function getControlSearchRoot(field) {
    const fieldRect = field.getBoundingClientRect();
    let best = field.closest("form") || field.parentElement || document.body;
    let bestScore = -Infinity;
    let el = field.parentElement;
    let depth = 0;
    while (el && depth < 10) {
      const r = el.getBoundingClientRect();
      const controlCount = countControlsInside(el, r);
      const containsField = r.left <= fieldRect.left + 2 && r.right >= fieldRect.right - 2 && r.top <= fieldRect.top + 2 && r.bottom >= fieldRect.bottom - 2;
      const usable =
        containsField &&
        r.width >= Math.max(240, fieldRect.width * 0.8) &&
        r.height >= fieldRect.height &&
        r.height <= Math.min(280, window.innerHeight * 0.55);
      if (usable) {
        const score = controlCount * 120 + r.width - Math.abs(r.bottom - fieldRect.bottom) * 1.4 - Math.max(0, r.height - 180) * 2;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      el = el.parentElement;
      depth += 1;
    }
    return best || document.body;
  }

  function countControlsInside(root, rootRect) {
    try {
      return [...root.querySelectorAll(nativeControlSelector())]
        .filter((el) => !el.closest(".prism-composer") && !el.closest(".prism-badge"))
        .filter((el) => !isEditableElement(el))
        .filter((el) => isNativeControlCandidate(el))
        .filter(isVisibleControl)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width >= 8 && r.height >= 8)
        .filter((r) => {
          const centerY = r.top + r.height / 2;
          return r.right >= rootRect.left - 4 && r.left <= rootRect.right + 4 && centerY >= rootRect.top - 12 && centerY <= rootRect.bottom + 12;
        }).length;
    } catch {
      return 0;
    }
  }

  function isVisibleControl(el) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.01;
  }

  function getNativeSendRect(field, hostRect, controlRects = null) {
    const btn = findSendButton(field);
    if (btn) {
      const r = btn.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) return r;
    }

    // Many modern AI UIs use icon-only send/voice buttons with weak labels.
    // If semantic detection fails, anchor Prism to the rightmost compact native
    // control in the host composer. This keeps the Prism triangle outside the
    // overlay and away from model pickers/status text.
    const rects = controlRects || getNativeControlRects(field, hostRect || getHostSurfaceRect(field));
    const host = hostRect || getHostSurfaceRect(field);
    const compactRightControls = rects
      .filter((r) => r.width <= 72 && r.height <= 72)
      .filter((r) => r.left > host.left + host.width * 0.45)
      .sort((a, b) => b.right - a.right);
    return compactRightControls[0] || null;
  }

  // ---------- inline SVG ----------
  function prismMarkSvg(gradientId = "prismG") {
    return `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ff6ad5"/>
          <stop offset=".5" stop-color="#a48bff"/>
          <stop offset="1" stop-color="#7afdfd"/>
        </linearGradient>
      </defs>
      <path d="M12 3 L21 19 H3 Z" fill="url(#${gradientId})" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" stroke-linejoin="round"/>
      <path d="M3 19 L12 11 L21 19" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="0.9" stroke-linejoin="round"/>
    </svg>`;
  }

  function sendArrowSvg() {
    return `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 4.8v10.4m0-10.4L5.8 9M10 4.8 14.2 9"/>
    </svg>`;
  }

  // ---------- badge ----------
  function mountBadge() {
    const root = document.body || document.documentElement;
    if (badge) {
      if (!badge.isConnected && root) root.appendChild(badge);
      return;
    }
    badge = document.createElement("button");
    badge.type = "button";
    badge.className = "prism-badge";
    badge.innerHTML = prismMarkSvg("prismBadgeG");
    if (EXTENSION_VERSION) badge.dataset.version = EXTENSION_VERSION;
    badge.title = EXTENSION_VERSION ? `Prism ${EXTENSION_VERSION} — click to toggle` : "Prism — click to toggle";
    badge.setAttribute("aria-label", "Toggle Prism composer");
    badge.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      clearLongPressTimer();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!settings.collapsed) return;
        suppressNextBadgeClick = true;
        setTimeout(() => { suppressNextBadgeClick = false; }, 900);
        openPeekPreview({ sticky: false });
      }, PREVIEW_LONG_PRESS_MS);
    });
    badge.addEventListener("pointerup", endBadgePress);
    badge.addEventListener("pointercancel", endBadgePress);
    badge.addEventListener("pointerleave", endBadgePress);
    badge.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      clearLongPressTimer();
      if (settings.collapsed) openPeekPreview({ sticky: true });
    });
    badge.addEventListener("click", (event) => {
      if (suppressNextBadgeClick) {
        suppressNextBadgeClick = false;
        event.preventDefault();
        return;
      }
      closePeekPreview();
      const nextCollapsed = !settings.collapsed;
      if (!nextCollapsed) {
        const field = findVisiblePromptField() || relaxedActivePromptField();
        if (field) activeField = field;
      }
      writeState({ collapsed: nextCollapsed });
      refresh();
    });
    root.appendChild(badge);
  }

  function endBadgePress() {
    clearLongPressTimer();
    if (peekState.active && !peekState.sticky) closePeekPreview();
  }

  function clearLongPressTimer() {
    if (!longPressTimer) return;
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function updateBadge() {
    if (!badge) return;
    badge.dataset.state = settings.paused ? "paused" : "on";
    badge.dataset.collapsed = String(!!settings.collapsed);
  }

  function positionBadge(rect) {
    if (!badge) return;
    const margin = 12;
    const width = 30;
    const height = 30;
    if (!rect) {
      badge.style.left = `${window.innerWidth - width - 18}px`;
      badge.style.top = `${window.innerHeight - height - 18}px`;
      badge.style.display = "grid";
      return;
    }

    const centerTop = (rect?.sendRect || rect).top + (rect?.sendRect || rect).height / 2 - height / 2;
    const rightOfComposer = Math.max(rect.right + 8, rect.sendRect ? rect.sendRect.right + 8 : -Infinity);
    const candidates = [
      { left: rightOfComposer, top: centerTop },
      { left: rect.left - width - 8, top: centerTop },
      { left: clamp(rect.right - width, margin, window.innerWidth - width - margin), top: rect.top - height - 8 },
      { left: clamp(rect.right - width, margin, window.innerWidth - width - margin), top: rect.bottom + 8 },
      { left: window.innerWidth - width - 18, top: window.innerHeight - height - 18 },
    ];
    const fitsViewport = (candidate) => candidate.left >= margin &&
      candidate.left + width <= window.innerWidth - margin &&
      candidate.top >= margin &&
      candidate.top + height <= window.innerHeight - margin;
    const outsideComposer = (candidate) => {
      const badgeRect = {
        left: candidate.left,
        right: candidate.left + width,
        top: candidate.top,
        bottom: candidate.top + height,
        width,
        height,
      };
      return intersectionArea(badgeRect, rect) / (width * height) <= 0.12;
    };
    const chosen = candidates.find((candidate) => fitsViewport(candidate) && outsideComposer(candidate)) ||
      candidates.find(fitsViewport) ||
      candidates[candidates.length - 1];
    badge.style.left = `${clamp(chosen.left, margin, window.innerWidth - width - margin)}px`;
    badge.style.top = `${clamp(chosen.top, margin, window.innerHeight - height - margin)}px`;
    badge.style.display = "grid";
  }

  // ---------- off-state rewrite peek ----------
  function openPeekPreview({ sticky = false } = {}) {
    if (!settings.collapsed) return false;
    const field = (activeField && activeField.isConnected && isVisibleField(activeField)) ? activeField : findVisiblePromptField();
    if (!field) return false;
    const raw = getValue(field).trim();
    if (!raw) return false;
    const result = previewPrompt(raw);
    const output = result?.optimizedPrompt || raw;
    activeField = field;
    mountComposer();
    composerField.value = raw;
    peekState = {
      active: true,
      sticky,
      raw,
      output,
      metrics: result?.metrics || result?.result?.metrics || null,
      field,
    };
    const rect = getPromptSurfaceRect(field);
    positionComposer(field, rect);
    positionBadge(rect);
    updatePeekLayer();
    geometrySignature = geometryKey(rect);
    document.addEventListener("keydown", handlePeekKeydown, true);
    setTimeout(() => {
      document.addEventListener("pointerdown", handlePeekOutsidePointer, true);
    }, 0);
    return true;
  }

  function closePeekPreview() {
    clearLongPressTimer();
    document.removeEventListener("pointerdown", handlePeekOutsidePointer, true);
    document.removeEventListener("keydown", handlePeekKeydown, true);
    lastControlTapAt = 0;
    peekState = { active: false, sticky: false, raw: "", output: "", metrics: null, field: null };
    if (composer) {
      composer.dataset.peek = "false";
      composer.dataset.peekSticky = "false";
    }
    if (settings.collapsed) hideComposer();
    else schedulePosition();
  }

  function handlePeekOutsidePointer(event) {
    if (!peekState.active) return;
    if (badge?.contains(event.target) || composer?.contains(event.target)) return;
    closePeekPreview();
  }

  function handlePeekKeydown(event) {
    if (!peekState.active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePeekPreview();
      return;
    }
    const isControl = event.key === "Control" || event.code === "ControlLeft" || event.code === "ControlRight";
    if (!isControl || event.repeat) return;
    const now = performance.now();
    if (lastControlTapAt && now - lastControlTapAt <= CONTROL_DOUBLE_TAP_MS) {
      event.preventDefault();
      event.stopPropagation();
      try { event.stopImmediatePropagation(); } catch {}
      lastControlTapAt = 0;
      adoptPeekText();
      return;
    }
    lastControlTapAt = now;
  }

  function updatePeekLayer() {
    if (!composer) return;
    const text = composer.querySelector(".prism-peek-text");
    if (text) text.textContent = peekState.output || "";
    const metrics = peekState.metrics || {};
    const tokenDelta = Number(metrics.tokenDelta || 0);
    const tip = composer.querySelector(".prism-peek-tooltip");
    if (tip) {
      tip.textContent = tokenDelta
        ? `Double-tap Control to use this rewrite (${tokenDelta > 0 ? "+" : ""}${tokenDelta} tokens)`
        : "Double-tap Control to use this rewrite";
    }
    composer.dataset.peek = String(!!peekState.active);
    composer.dataset.peekSticky = String(!!peekState.sticky);
    composer.dataset.empty = String(!peekState.raw.trim());
  }

  function previewPrompt(raw) {
    try {
      const surfaceModel = detectSurfaceModel();
      return (window.PrismOptimizer && typeof window.PrismOptimizer.optimize === "function")
        ? window.PrismOptimizer.optimize(raw, optimizerOptions(surfaceModel))
        : { optimizedPrompt: raw, metrics: null, result: null };
    } catch {
      return { optimizedPrompt: raw, metrics: null, result: null };
    }
  }

  function optimizerOptions(surfaceModel) {
    return {
      model: surfaceModel,
      mode: globalSettings.mode || "balanced",
      defaultOutputGuidance: globalSettings.defaultOutputGuidance !== false,
      outputGuidanceText: normalizeOutputGuidanceSetting(globalSettings.outputGuidanceText),
    };
  }

  function normalizeOutputGuidanceSetting(value) {
    const text = String(value || "")
      .replace(/^Output:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.]+$/u, "");
    return text || DEFAULT_OUTPUT_GUIDANCE;
  }

  async function adoptPeekText() {
    const output = peekState.output || "";
    const raw = peekState.raw || output;
    if (!peekState.active || !output) return;
    const field = (peekState.field && peekState.field.isConnected && isVisibleField(peekState.field)) ? peekState.field : findVisiblePromptField();
    if (!field) return;
    activeField = field;
    const committed = await commitValue(field, output);
    if (committed) {
      composerField.value = output;
      persistLastMetrics(raw, output, peekState.metrics);
      schedulePosition();
      closePeekPreview();
    }
  }

  // ---------- composer ----------
  function mountComposer() {
    if (composer) return;
    composer = document.createElement("div");
    composer.className = "prism-composer";
    composer.innerHTML = `
      <div class="prism-composer-shell">
        <div class="prism-skin-layer" aria-hidden="true"></div>
        <div class="prism-peek-layer" aria-hidden="true">
          <div class="prism-peek-text"></div>
        </div>
        <div class="prism-input-zone">
          <span class="prism-inline-mark" aria-hidden="true">${prismMarkSvg("prismComposerG")}</span>
          <textarea class="prism-composer-input" rows="1" placeholder="Chat with Prism"></textarea>
          <span class="prism-composer-status">Ready</span>
          <button class="prism-composer-icon-button prism-composer-send" type="button" aria-label="Rewrite prompt" title="Rewrite prompt">
            ${sendArrowSvg()}
          </button>
        </div>
      </div>
      <div class="prism-peek-tooltip" role="tooltip">Double-tap Control to use this rewrite</div>
    `;
    composerField = composer.querySelector(".prism-composer-input");
    composerStatus = composer.querySelector(".prism-composer-status");

    composerField.addEventListener("input", () => {
      autosize();
      composer.dataset.empty = String(!composerField.value.trim());
      schedulePosition();
    });

    composerField.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        optimizeAndCommit({ submitAfter: false });
      }
    });

    composer.querySelector(".prism-composer-send").addEventListener("click", () => optimizeAndCommit({ submitAfter: false }));
    composer.querySelector(".prism-input-zone").addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      composerField.focus();
    });

    document.documentElement.appendChild(composer);
  }

  function autosize() {
    if (!composer || !composerField) return;
    composerField.style.height = "100%";
  }

  function syncComposerWithField(field, rect) {
    if (!composer || !composerField) return;
    const styles = getComputedStyle(field);
    const radius = Number.isFinite(rect?.skinRadius) && rect.skinRadius > 0 ? `${rect.skinRadius}px` : ((styles.borderRadius && parseFloat(styles.borderRadius)) ? styles.borderRadius : "16px");
    const fontFamily = styles.fontFamily || "";
    const fontSize = styles.fontSize || "";
    const lineHeight = styles.lineHeight || "";
    const color = isTransparent(styles.color) ? "#f5edf3" : styles.color;
    const background = readableBackground(field) || "rgba(28, 22, 42, 0.86)";
    const minHeight = Math.round(clamp(rect.inputRect?.height || rect.height || 44, 38, 72));
    const fieldRect = field.getBoundingClientRect();
    const inputRect = rect?.inputRect || fieldRect;
    const adjustedPadding = (value, consumed) => `${Math.max(0, (parseFloat(value) || 0) - Math.max(0, consumed || 0))}px`;

    composer.style.setProperty("--prism-host-radius", radius);
    composer.style.setProperty("--prism-host-text", color);
    composer.style.setProperty("--prism-host-bg", background);
    composer.style.setProperty("--prism-host-min-height", `${minHeight}px`);
    composer.style.setProperty("--prism-peek-padding-top", adjustedPadding(styles.paddingTop, inputRect.top - fieldRect.top));
    composer.style.setProperty("--prism-peek-padding-right", adjustedPadding(styles.paddingRight, fieldRect.right - inputRect.right));
    composer.style.setProperty("--prism-peek-padding-bottom", adjustedPadding(styles.paddingBottom, fieldRect.bottom - inputRect.bottom));
    composer.style.setProperty("--prism-peek-padding-left", adjustedPadding(styles.paddingLeft, inputRect.left - fieldRect.left));
    if (fontFamily) composerField.style.fontFamily = fontFamily;
    if (fontSize) composerField.style.fontSize = fontSize;
    const peekText = composer.querySelector(".prism-peek-text");
    if (peekText) {
      if (fontFamily) peekText.style.fontFamily = fontFamily;
      if (fontSize) peekText.style.fontSize = fontSize;
      if (lineHeight) peekText.style.lineHeight = lineHeight;
      peekText.style.fontWeight = styles.fontWeight || "";
      peekText.style.letterSpacing = styles.letterSpacing || "";
      peekText.style.textAlign = styles.textAlign || "";
      peekText.style.color = color;
    }
    composerField.placeholder = field.getAttribute?.("placeholder") || field.getAttribute?.("aria-label") || "";
    composerField.style.color = color;
  }

  function isTransparent(c) {
    if (!c) return true;
    if (c === "transparent") return true;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 4 && parts[3] === 0) return true;
    return false;
  }

  function readableBackground(field) {
    let cur = field;
    let depth = 0;
    while (cur && depth < 6) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (!isTransparent(bg)) return bg;
      cur = cur.parentElement;
      depth += 1;
    }
    return null;
  }

  function positionComposer(field, rect) {
    if (!composer || !field) return;
    syncComposerWithField(field, rect);
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    const viewportLeft = rect.left;
    const viewportTop = rect.top;
    const anchor = resolveComposerAnchor(field, rect);
    const left = anchor ? anchor.left : viewportLeft;
    const top = anchor ? anchor.top : viewportTop;
    const input = rect.inputRect || rect;
    if (anchor) {
      composer.dataset.anchor = "host";
      composer.style.position = "absolute";
    } else {
      composer.dataset.anchor = "viewport";
      composer.style.position = "fixed";
    }
    composer.style.display = "block";
    composer.style.width = `${width}px`;
    composer.style.left = "0px";
    composer.style.height = `${height}px`;
    composer.style.top = "0px";
    composer.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    composer.dataset.expanded = "native";
    composer.dataset.layout = rect.layout || "pill";
    composer.style.setProperty("--prism-host-radius", `${Number.isFinite(rect.skinRadius) && rect.skinRadius > 0 ? rect.skinRadius : resolveSurfaceSkinRadius({ width, height, hostRadius: 0 })}px`);

    renderDynamicSkinHoles(rect, viewportLeft, viewportTop, width, height);

    composer.style.setProperty("--prism-input-left", `${Math.max(8, input.left - viewportLeft)}px`);
    composer.style.setProperty("--prism-input-top", `${Math.max(4, input.top - viewportTop)}px`);
    composer.style.setProperty("--prism-input-width", `${Math.max(160, input.width)}px`);
    composer.style.setProperty("--prism-input-height", `${Math.max(24, input.height)}px`);
    composer.dataset.peekTipPosition = viewportTop + height + 42 <= window.innerHeight - 8 ? "below" : "above";
    autosize();
    composer.dataset.empty = String(!composerField.value.trim());
    if (peekState.active) updatePeekLayer();
  }

  function resolveComposerAnchor(field, rect) {
    const host = rect?.hostElement || rect?.hostRect?.hostElement || null;
    if (!canAnchorComposerToHost(field, rect, host)) {
      releaseComposerHostAnchor();
      return null;
    }

    prepareComposerHostAnchor(host);
    if (composer.parentElement !== host) host.appendChild(composer);
    composerAnchorHost = host;

    const hostRect = host.getBoundingClientRect();
    const style = getComputedStyle(host);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    return {
      left: rect.left - hostRect.left - borderLeft,
      top: rect.top - hostRect.top - borderTop,
    };
  }

  function canAnchorComposerToHost(field, rect, host) {
    if (!composer || !field || !rect || !host || !host.isConnected) return false;
    if (host === document.documentElement || host === document.body) return false;
    if (host === field) return false;
    if (host.closest?.(".prism-composer,.prism-badge")) return false;
    if (isEditableElement(host) || resolvePromptField(host) === host) return false;
    const tag = host.tagName?.toLowerCase();
    if (!tag || /^(input|textarea|button|select|option|svg|path|html|body)$/i.test(tag)) return false;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width < 220 || hostRect.height < 34) return false;
    return Math.abs(hostRect.left - rect.left) <= 4 &&
      Math.abs(hostRect.top - rect.top) <= 4 &&
      Math.abs(hostRect.width - rect.width) <= 4 &&
      Math.abs(hostRect.height - rect.height) <= 4;
  }

  function prepareComposerHostAnchor(host) {
    if (composerAnchorHost && composerAnchorHost !== host) restoreComposerHostAnchor(composerAnchorHost);
    let state = composerAnchorStates.get(host);
    if (!state) {
      state = { inlinePosition: host.style.position || "", changedPosition: false };
      composerAnchorStates.set(host, state);
    }
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
      state.changedPosition = true;
    }
  }

  function releaseComposerHostAnchor() {
    if (composerAnchorHost) restoreComposerHostAnchor(composerAnchorHost);
    composerAnchorHost = null;
    if (composer) {
      composer.dataset.anchor = "viewport";
      if (composer.parentElement !== document.documentElement) document.documentElement.appendChild(composer);
    }
  }

  function restoreComposerHostAnchor(host) {
    const state = composerAnchorStates.get(host);
    if (!state?.changedPosition) return;
    if (host.isConnected && host.style.position === "relative") host.style.position = state.inlinePosition;
    state.changedPosition = false;
  }

  function estimatedComposerTextHeight() {
    if (!composerField) return 24;
    const style = getComputedStyle(composerField);
    const fontSize = parseFloat(style.fontSize) || 16;
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.32;
    const explicitLines = composerField.value.split("\n").length;
    const inputWidth = parseFloat(getComputedStyle(composer).getPropertyValue("--prism-input-width")) || composerField.clientWidth || 360;
    const averageCharWidth = Math.max(7, fontSize * 0.52);
    const wrappedLines = composerField.value
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * averageCharWidth / Math.max(80, inputWidth - 116))), 0);
    const lines = Math.max(explicitLines, wrappedLines);
    return Math.ceil(lines * lineHeight);
  }

  function renderDynamicSkinHoles(rect, composerLeft, composerTop, composerWidth, composerHeight) {
    const layer = composer?.querySelector(".prism-skin-layer");
    if (!layer) return;
    layer.textContent = "";
    const skinRadius = Number.isFinite(rect.skinRadius) && rect.skinRadius > 0
      ? rect.skinRadius
      : resolveSurfaceSkinRadius({ width: composerWidth, height: composerHeight, hostRadius: 0 });
    layer.style.borderRadius = `${skinRadius}px`;
    layer.style.opacity = String(clamp(Number(globalSettings.overlayIntensity || 1), 0.35, 1));

    // Tight, button-sized holes. Nested icon/label fragments are discarded so
    // Gemini-style toolbars do not render dark duplicate "button shadows".
    const padding = 2;
    let holes = (rect.controlRects || [])
      .map((r) => ({
        x: clamp(r.left - composerLeft - padding, 0, composerWidth),
        y: clamp(r.top - composerTop - padding, 0, composerHeight),
        w: clamp(r.width + padding * 2, 0, composerWidth),
        h: clamp(r.height + padding * 2, 0, composerHeight),
        r: Number.isFinite(r.radius) ? r.radius + padding : null,
      }))
      .map((h) => ({
        ...h,
        w: Math.min(h.w, composerWidth - h.x),
        h: Math.min(h.h, composerHeight - h.y),
      }))
      .filter((h) => h.w > 10 && h.h > 10)
      .filter((h) => {
        const input = rect.inputRect;
        if (!input) return true;
        const inputX = input.left - composerLeft;
        const inputY = input.top - composerTop;
        const holeRect = { left: h.x, right: h.x + h.w, top: h.y, bottom: h.y + h.h, width: h.w, height: h.h };
        const inputRect = { left: inputX, right: inputX + input.width, top: inputY, bottom: inputY + input.height, width: input.width, height: input.height };
        const overlap = intersectionArea(holeRect, inputRect);
        return overlap / Math.max(1, h.w * h.h) < 0.18;
      });

    holes = normalizeSkinHoles(holes);

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "prism-skin-svg");
    svg.setAttribute("viewBox", `0 0 ${composerWidth} ${composerHeight}`);
    svg.setAttribute("width", String(composerWidth));
    svg.setAttribute("height", String(composerHeight));
    svg.setAttribute("aria-hidden", "true");

    const defs = document.createElementNS(svgNS, "defs");
    const linear = document.createElementNS(svgNS, "linearGradient");
    linear.setAttribute("id", "prismSkinLinear");
    linear.setAttribute("x1", "0");
    linear.setAttribute("x2", "1");
    linear.innerHTML = `
      <stop offset="0" stop-color="rgba(126,65,54,0.52)"/>
      <stop offset="0.48" stop-color="rgba(38,32,50,0.48)"/>
      <stop offset="1" stop-color="rgba(101,61,173,0.52)"/>
    `;
    const mask = document.createElementNS(svgNS, "mask");
    mask.setAttribute("id", "prismSkinMask");
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    const base = document.createElementNS(svgNS, "rect");
    base.setAttribute("x", "0");
    base.setAttribute("y", "0");
    base.setAttribute("width", String(composerWidth));
    base.setAttribute("height", String(composerHeight));
    base.setAttribute("rx", String(skinRadius));
    base.setAttribute("fill", "white");
    mask.appendChild(base);
    for (const h of holes) {
      const cut = document.createElementNS(svgNS, "rect");
      cut.setAttribute("x", String(h.x));
      cut.setAttribute("y", String(h.y));
      cut.setAttribute("width", String(h.w));
      cut.setAttribute("height", String(h.h));
      cut.setAttribute("rx", String(Number.isFinite(h.r)
        ? Math.min(h.r, h.w / 2, h.h / 2)
        : Math.min(24, h.w / 2, h.h / 2)));
      cut.setAttribute("fill", "black");
      mask.appendChild(cut);
    }
    defs.appendChild(linear);
    defs.appendChild(mask);
    svg.appendChild(defs);

    const skin = document.createElementNS(svgNS, "rect");
    skin.setAttribute("x", "0");
    skin.setAttribute("y", "0");
    skin.setAttribute("width", String(composerWidth));
    skin.setAttribute("height", String(composerHeight));
    skin.setAttribute("rx", String(skinRadius));
    skin.setAttribute("fill", "url(#prismSkinLinear)");
    skin.setAttribute("mask", "url(#prismSkinMask)");
    svg.appendChild(skin);

    layer.appendChild(svg);
  }

  function normalizeSkinHoles(holes) {
    const sorted = holes
      .filter((h) => h.w >= 26 && h.h >= 26)
      .sort((a, b) => b.w * b.h - a.w * a.h || a.x - b.x || a.y - b.y);
    const kept = [];
    for (const hole of sorted) {
      const duplicate = kept.some((existing) => {
        const overlap = intersectionArea(
          { left: existing.x, right: existing.x + existing.w, top: existing.y, bottom: existing.y + existing.h, width: existing.w, height: existing.h },
          { left: hole.x, right: hole.x + hole.w, top: hole.y, bottom: hole.y + hole.h, width: hole.w, height: hole.h }
        );
        const smallerArea = Math.min(existing.w * existing.h, hole.w * hole.h);
        return overlap / Math.max(1, smallerArea) >= 0.78;
      });
      if (!duplicate) kept.push(hole);
    }
    return kept.sort((a, b) => a.x - b.x || a.y - b.y);
  }

  function hideComposer() {
    releaseComposerHostAnchor();
    if (composer) composer.style.display = "none";
  }

  function hideBadge() {
    if (badge) badge.style.display = "none";
  }

  function rectNearViewport(rect, slack = 96) {
    if (!rect) return false;
    return rect.right > -slack &&
      rect.left < window.innerWidth + slack &&
      rect.bottom > -slack &&
      rect.top < window.innerHeight + slack;
  }

  function relaxedActivePromptField() {
    const field = resolvePromptField(activeField);
    return badgeAnchorRectForField(field) ? field : null;
  }

  function badgeAnchorRectForField(field) {
    field = resolvePromptField(field);
    if (!field || !field.isConnected || field.closest(".prism-composer")) return null;
    if (isLikelyAuthOrUtilityField(field)) return null;
    const fieldRect = field.getBoundingClientRect?.();
    const minHeight = field.getAttribute?.("role") === "textbox" || field.isContentEditable ? 18 : 30;
    if (!fieldRect || fieldRect.width < 220 || fieldRect.height < minHeight) return null;
    if (!rectNearViewport(fieldRect)) return null;
    const promptLike = fieldHasPromptContent(field) ||
      isFieldFocused(field) ||
      isStrongPromptAffordance(field) ||
      isLikelyDockedPromptSurface(fieldRect);
    if (!promptLike) return null;
    try {
      return getPromptSurfaceRect(field);
    } catch {
      return rectFromDomRect(fieldRect, controlCornerRadius(field));
    }
  }

  function collapsedBadgeAnchorRect() {
    if (!settings.collapsed) return null;
    return badgeAnchorRectForField(activeField);
  }

  function keepCollapsedBadgeVisible() {
    const rect = collapsedBadgeAnchorRect();
    if (!rect) return false;
    mountBadge();
    updateBadge();
    hideComposer();
    positionBadge(rect);
    geometrySignature = geometryKey(rect);
    return true;
  }

  function removePrismUiForPageOptOut() {
    activeField = null;
    geometrySignature = "";
    if (badge) {
      badge.remove();
      badge = null;
    }
    if (composer) {
      releaseComposerHostAnchor();
      composer.remove();
      composer = null;
      composerField = null;
      composerStatus = null;
    }
  }

  // ---------- optimize ----------
  async function optimizeAndCommit({ submitAfter = false } = {}) {
    if (processing || !composerField || !activeField) return;
    const raw = composerField.value.trim();
    if (!raw) { composerField.focus(); return; }

    processing = true;
    composer.dataset.processing = "true";

    if (globalSettings.paused || settings.paused) {
      composer.dataset.status = "ready";
      composerStatus.textContent = "Paused";
      const committed = await commitValue(activeField, raw);
      if (committed) {
        composerField.value = "";
        autosize();
        schedulePosition();
        if (submitAfter) setTimeout(() => trySend(activeField), nativeSendDelay(activeField));
      }
      processing = false;
      composer.dataset.processing = "false";
      return;
    }

    composer.dataset.status = "optimizing";
    composerStatus.textContent = "Optimizing";

    let optimizedPrompt = raw;
    let optimizationMetrics = null;
    try {
      const start = performance.now();
      const surfaceModel = detectSurfaceModel();
      const localOpt = (window.PrismOptimizer && typeof window.PrismOptimizer.optimize === "function")
        ? window.PrismOptimizer.optimize(raw, optimizerOptions(surfaceModel))
        : { optimizedPrompt: raw };
      const localElapsed = performance.now() - start;
      if (localElapsed <= HARD_CAP_MS) {
        optimizedPrompt = localOpt.optimizedPrompt || raw;
        optimizationMetrics = localOpt.metrics || localOpt.result?.metrics || null;
      } else {
        optimizedPrompt = raw;
      }

      const elapsed = performance.now() - start;
      if (elapsed > HARD_CAP_MS && optimizedPrompt === raw) {
        console.warn("[Prism] slow_path", elapsed.toFixed(1), "ms — sending original");
      }
    } catch (e) {
      console.warn("[Prism] optimize failed", e);
    }

    persistLastMetrics(raw, optimizedPrompt, optimizationMetrics);

    const committed = await commitValue(activeField, optimizedPrompt);
    if (!committed) {
      console.warn("[Prism] optimized prompt did not commit to native field; keeping composer text for retry");
      composer.dataset.status = "ready";
      composerStatus.textContent = "Retry";
      composer.dataset.processing = "false";
      processing = false;
      composerField.focus();
      return;
    }

    composerField.value = submitAfter ? "" : optimizedPrompt;
    autosize();
    schedulePosition();
    composer.dataset.empty = String(!composerField.value.trim());
    composer.dataset.status = submitAfter ? "sent" : "rewritten";
    composerStatus.textContent = submitAfter ? "Sent" : "Rewritten";

    if (submitAfter) setTimeout(() => trySend(activeField), nativeSendDelay(activeField));
    setTimeout(() => {
      composer.dataset.status = "ready";
      composerStatus.textContent = "Ready";
      composer.dataset.processing = "false";
      processing = false;
    }, 900);
  }

  function persistLastMetrics(input, output, metrics) {
    if (globalSettings.autoMetrics === false) return;
    try {
      const analyzedBefore = metrics?.before || window.PrismCore?.analyzePrompt?.(input);
      const analyzedAfter = metrics?.after || window.PrismCore?.analyzePrompt?.(output);
      const payload = {
        at: new Date().toISOString(),
        surface: location.host,
        model: detectSurfaceModel(),
        strategy: metrics?.strategy || "local",
        beforeTokens: analyzedBefore?.tokens || 0,
        afterTokens: analyzedAfter?.tokens || 0,
        valuePerToken: analyzedAfter?.valuePerToken || 0,
        valuePerTokenDelta: metrics?.valuePerTokenDelta ?? ((analyzedAfter?.valuePerToken || 0) - (analyzedBefore?.valuePerToken || 0)),
        tokenDelta: metrics?.tokenDelta ?? ((analyzedAfter?.tokens || 0) - (analyzedBefore?.tokens || 0)),
        tokenReduction: metrics?.tokenReduction || 0,
        protectedArtifacts: metrics?.protectedArtifacts || analyzedAfter?.artifacts?.count || 0,
        decision: metrics?.decision || "apply",
        confidence: metrics?.confidence ?? null,
        riskReasons: metrics?.riskReasons || [],
      };
      chrome.storage?.local.set({ prismLastMetrics: payload });
    } catch {}
  }

  // ---------- modal/popup layering ----------
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
    return r;
  }

  function numericZIndex(el) {
    const z = getComputedStyle(el).zIndex;
    const n = Number.parseInt(z, 10);
    return Number.isFinite(n) ? n : null;
  }

  function upperLayerSelectors() {
    // Keep this intentionally narrow. Broad selectors like [class*=menu]
    // accidentally match normal app chrome and made Prism disappear permanently.
    return [
      "dialog[open]",
      "[aria-modal='true']",
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='menu']",
      "[role='listbox']",
      "[role='tooltip']",
      "[data-radix-popper-content-wrapper]",
      "[data-headlessui-state]"
    ].join(",");
  }

  function visibleUpperLayerRecords() {
    const explicit = [...document.querySelectorAll(upperLayerSelectors())]
      .filter((el) => !el.closest(".prism-composer") && !el.closest(".prism-badge"))
      .filter((el) => !activeField || !el.contains?.(activeField))
      .map((el) => {
        const rect = visibleRect(el);
        if (!rect) return null;
        const style = getComputedStyle(el);
        return {
          el,
          rect,
          z: numericZIndex(el),
          blocksPrism: isBlockingUpperLayer(el, rect, style),
        };
      })
      .filter(Boolean);

    const generic = [];
    for (const el of document.querySelectorAll("body > *")) {
      if (el.closest?.(".prism-composer") || el.closest?.(".prism-badge")) continue;
      if (activeField && el.contains?.(activeField)) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed") continue;
      const r = visibleRect(el);
      if (!r) continue;
      const z = numericZIndex(el);
      const coversScreen = r.width > window.innerWidth * 0.65 && r.height > window.innerHeight * 0.55;
      const looksLikeBackdrop = /rgba\([^)]*,\s*0\.[2-9]/.test(style.backgroundColor) || Number(style.opacity) < 0.98;
      if ((z != null && z >= 1000 && coversScreen && looksLikeBackdrop) || (coversScreen && looksLikeBackdrop)) {
        generic.push({
          el,
          rect: r,
          z,
          blocksPrism: coversScreen && looksLikeBackdrop,
        });
      }
    }
    return [...explicit, ...generic];
  }

  function isBlockingUpperLayer(el, rect, style) {
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    if (el.matches?.("dialog[open],[aria-modal='true'],[role='alertdialog']")) return true;
    const fixedOrSticky = style.position === "fixed" || style.position === "sticky";
    const coversMostScreen = rect.width > window.innerWidth * 0.55 && rect.height > window.innerHeight * 0.45;
    const backdropLike = /rgba\([^)]*,\s*0\.[2-9]/.test(style.backgroundColor) || Number(style.opacity) < 0.98;
    if (role === "dialog" && (fixedOrSticky || coversMostScreen || backdropLike)) return true;
    return coversMostScreen && backdropLike;
  }

  function detectUpperLayerState() {
    let maxZ = null;
    let blocksPrism = false;
    for (const record of visibleUpperLayerRecords()) {
      maxZ = Math.max(maxZ ?? 0, record.z == null ? 10000 : record.z);
      blocksPrism = blocksPrism || record.blocksPrism;
    }
    return { maxZ, blocksPrism };
  }

  function applyLayering() {
    const { maxZ: upperZ, blocksPrism } = detectUpperLayerState();
    const defaultComposerZ = 999;
    const defaultBadgeZ = 1000;
    let composerZ = defaultComposerZ;
    let badgeZ = defaultBadgeZ;
    let visibility = "visible";
    if (upperZ != null) {
      composerZ = Math.max(10, Math.min(defaultComposerZ, upperZ - 2));
      badgeZ = Math.max(11, Math.min(defaultBadgeZ, upperZ - 1));
    }
    if (blocksPrism) visibility = "hidden";
    document.documentElement.style.setProperty("--prism-composer-z", String(composerZ));
    document.documentElement.style.setProperty("--prism-badge-z", String(badgeZ));
    document.documentElement.style.setProperty("--prism-layer-visibility", visibility);
  }

  // ---------- refresh / scheduling ----------
  function refresh() {
    if (shouldSkipPrismExtension()) {
      removePrismUiForPageOptOut();
      return;
    }
    if (globalSettings.enabled === false) {
      if (badge) badge.style.display = "none";
      hideComposer();
      return;
    }
    applyLayering();
    const visibleCandidate = (activeField && activeField.isConnected && isVisibleField(activeField)) ? activeField : findVisiblePromptField();
    const relaxedCandidate = visibleCandidate ? null : (!settings.collapsed ? relaxedActivePromptField() : null);
    const candidate = visibleCandidate || relaxedCandidate;
    const relaxedRect = relaxedCandidate ? badgeAnchorRectForField(relaxedCandidate) : null;
    if (!candidate || (!relaxedRect && !shouldAttachPrismToField(candidate))) {
      if (keepCollapsedBadgeVisible()) return;
      activeField = null;
      geometrySignature = "";
      hideBadge();
      hideComposer();
      return;
    }
    const field = candidate;
    activeField = field;
    observeGeometry(field);
    startGeometryWatch();
    const rect = relaxedRect || getPromptSurfaceRect(field);
    mountBadge();
    mountComposer();
    updateBadge();
    if (settings.collapsed) {
      if (peekState.active) {
        positionComposer(field, rect);
      } else {
        hideComposer();
      }
      positionBadge(rect);
    } else {
      positionComposer(field, rect);
      // Badge stays visible at the corner of the field for one-click collapse.
      positionBadge(rect);
    }
    geometrySignature = geometryKey(rect);
  }

  function schedulePosition() {
    if (positionTimer) cancelAnimationFrame(positionTimer);
    positionTimer = requestAnimationFrame(refresh);
  }

  function observeGeometry(field) {
    if (!window.ResizeObserver || observedField === field) return;
    geometryResizeObserver?.disconnect();
    const observer = new ResizeObserver(() => refreshFromResizeObserver());
    const observed = new Set([field, document.body, document.documentElement, getControlSearchRoot(field)]);
    let el = field.parentElement;
    let depth = 0;
    while (el && depth < 8) {
      observed.add(el);
      el = el.parentElement;
      depth += 1;
    }
    for (const node of observed) {
      try { observer.observe(node); } catch {}
    }
    geometryResizeObserver = observer;
    observedField = field;
  }

  function refreshFromResizeObserver() {
    if (refreshingFromResizeObserver) return;
    refreshingFromResizeObserver = true;
    try {
      if (positionTimer) {
        cancelAnimationFrame(positionTimer);
        positionTimer = null;
      }
      refresh();
    } finally {
      refreshingFromResizeObserver = false;
    }
  }

  function startGeometryWatch() {
    if (geometryWatch) return;
    const tick = () => {
      geometryWatch = requestAnimationFrame(tick);
      if (!activeField || !activeField.isConnected) {
        schedulePosition();
        return;
      }
      if (!isVisibleField(activeField) || !shouldAttachPrismToField(activeField)) {
        schedulePosition();
        return;
      }
      const rect = getPromptSurfaceRect(activeField);
      const key = geometryKey(rect);
      if (needsInlineModelSyncBeforeTrustedSend(activeField)) ensurePageBridge();
      if (key === geometrySignature) return;
      geometrySignature = key;
      if (settings.collapsed) {
        if (peekState.active) {
          mountComposer();
          positionComposer(activeField, rect);
        }
        positionBadge(rect);
        return;
      }
      mountComposer();
      positionComposer(activeField, rect);
      positionBadge(rect);
    };
    geometryWatch = requestAnimationFrame(tick);
  }

  function geometryKey(rect) {
    const parts = [
      rectKey(rect),
      rect.inputRect ? rectKey(rect.inputRect) : "",
      composerField ? `${composerField.value.length}:${Math.round(composerField.scrollHeight || 0)}` : "0:0",
      `${window.innerWidth}x${window.innerHeight}`,
    ];
    for (const control of rect.controlRects || []) parts.push(rectKey(control));
    return parts.join("|");
  }

  function rectKey(rect) {
    return [
      Math.round(rect.left ?? rect.x ?? 0),
      Math.round(rect.top ?? rect.y ?? 0),
      Math.round(rect.width ?? 0),
      Math.round(rect.height ?? 0),
    ].join(",");
  }

  // ---------- integrate with native send paths ----------
  function looksLikeSendButton(b) {
    if (!b || b.closest(".prism-composer")) return false;
    if (matchesProviderSendSelector(b)) return true;
    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
    const title = (b.getAttribute("title") || "").toLowerCase();
    const text = (b.textContent || "").toLowerCase();
    const dataTest = (b.getAttribute("data-testid") || "").toLowerCase();
    return /send|submit|message|run/.test(aria + " " + title + " " + text + " " + dataTest);
  }

  function matchesProviderSendSelector(el) {
    return providerSelectors("sendSelectors").some((selector) => matchesSelector(el, selector));
  }

  function closestNativeSendTarget(target) {
    const selectors = [
      "button",
      "[role='button']",
      "input[type='submit']",
      ...providerSelectors("sendSelectors")
    ].filter(Boolean).join(",");
    try {
      return target.closest?.(selectors) || null;
    } catch {
      return target.closest?.("button,[role='button'],input[type='submit']") || null;
    }
  }

  function stopHostSend(e) {
    e.preventDefault();
    e.stopPropagation();
    try { e.stopImmediatePropagation(); } catch {}
  }

  function isTrustedNativeSendEvent(e) {
    return !!e?.isTrusted;
  }

  function shouldPrepareTrustedNativeSend(e, field) {
    if (!isTrustedNativeSendEvent(e)) return false;
    if (e.type === "pointerdown" || e.type === "keydown" || e.type === "submit") return true;
    if (e.type !== "click") return false;
    return field !== lastTrustedSendPrepareField || performance.now() - lastTrustedSendPrepareAt > 650;
  }

  function optimizeInlineForTrustedSend(field) {
    field = resolvePromptField(field);
    if (!field || globalSettings.paused || settings.paused) return false;
    if (needsInlineModelSyncBeforeTrustedSend(field)) ensurePageBridge();
    const raw = getValue(field).trim();
    if (!raw) return false;
    if (hasInlineModelSync(field)) {
      lastTrustedSendPrepareAt = performance.now();
      lastTrustedSendPrepareField = field;
      persistLastMetrics(inlineModelSyncRaw || raw, inlineModelSyncOutput || raw, inlineModelSyncMetrics);
      if (composerField) {
        composerField.value = "";
        autosize();
      }
      if (composer) {
        composer.dataset.empty = "true";
        composer.dataset.status = "sent";
      }
      if (composerStatus) composerStatus.textContent = "Sent";
      schedulePosition();
      scheduleTrustedNativeSendFallback(field, inlineModelSyncOutput || raw);
      return true;
    }
    if (hasOutputGuidance(raw)) {
      lastTrustedSendPrepareAt = performance.now();
      lastTrustedSendPrepareField = field;
      if (composerField) {
        composerField.value = "";
        autosize();
      }
      if (composer) {
        composer.dataset.empty = "true";
        composer.dataset.status = "sent";
      }
      if (composerStatus) composerStatus.textContent = "Sent";
      schedulePosition();
      scheduleTrustedNativeSendFallback(field, raw);
      return true;
    }
    const result = previewPrompt(raw);
    const optimizedPrompt = result?.optimizedPrompt || raw;
    if (!String(optimizedPrompt || "").trim()) return false;
    const committed = commitValueForTrustedNativeSend(field, optimizedPrompt, raw);
    if (!committed) return false;
    lastTrustedSendPrepareAt = performance.now();
    lastTrustedSendPrepareField = field;
    persistLastMetrics(raw, optimizedPrompt, result?.metrics || result?.result?.metrics || null);
    if (composerField) {
      composerField.value = "";
      autosize();
    }
    if (composer) {
      composer.dataset.empty = "true";
      composer.dataset.status = "sent";
    }
    if (composerStatus) composerStatus.textContent = "Sent";
    schedulePosition();
    scheduleTrustedNativeSendFallback(field, optimizedPrompt);
    return true;
  }

  function prepareTrustedNativeSend(field) {
    field = resolvePromptField(field);
    if (!field) return false;
    activeField = field;
    mountComposer();
    if (composerField) composerField.value = getValue(field).trim();
    return optimizeInlineForTrustedSend(field);
  }

  function deferTrustedNativeSend(field, raw) {
    field = resolvePromptField(field);
    if (!field || processing) return false;
    activeField = field;
    mountComposer();
    composerField.value = raw;
    optimizeAndCommit({ submitAfter: true });
    return true;
  }

  function handleNativeFieldInput(e) {
    if (inlineModelSyncInProgress) return;
    if (settings.collapsed || globalSettings.paused || settings.paused || processing) return;
    const target = resolvePromptField(e.target);
    if (!target) return;
    if (target.closest && target.closest(".prism-composer")) return;
    if (!isVisibleField(target)) return;
    activeField = target;
    clearInlineModelSync();
    markInlineModelSync("idle");
    if (needsInlineModelSyncBeforeTrustedSend(target)) ensurePageBridge();
  }

  function handleNativeFieldTyping(e) {
    if (e.defaultPrevented && e.type !== "keyup") return;
    if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") return;
    if (e.metaKey || e.altKey) return;
    handleNativeFieldInput(e);
  }

  window.addEventListener("beforeinput", handleNativeFieldInput, true);
  document.addEventListener("beforeinput", handleNativeFieldInput, true);
  document.addEventListener("input", handleNativeFieldInput, true);
  window.addEventListener("keyup", handleNativeFieldTyping, true);
  document.addEventListener("keyup", handleNativeFieldTyping, true);

  // Intercept native Enter on the native field. Window capture is required for
  // apps that submit from an early window listener before document listeners run.
  function handleNativeFieldKeydown(e) {
    if (forwardingNativeSend) return;
    if (settings.collapsed) return;
    if (!(e.key === "Enter" && !e.shiftKey)) return;
    if (handledNativeKeydownEvents.has(e)) return;
    const target = resolvePromptField(e.target);
    if (!target) return;
    if (target.closest && target.closest(".prism-composer")) return;
    if (!isVisibleField(target)) return;
    handledNativeKeydownEvents.add(e);
    if (processing) {
      stopHostSend(e);
      return;
    }
    // Mirror the native field's content into the composer so the user sees
    // exactly what's being optimized, then run the same path.
    const raw = getValue(target).trim();
    if (!raw) return;
    if (isTrustedNativeSendEvent(e)) {
      if (shouldDeferTrustedNativeSend(target, e)) {
        stopHostSend(e);
        deferTrustedNativeSend(target, raw);
        return;
      }
      prepareTrustedNativeSend(target);
      return;
    }
    stopHostSend(e);
    activeField = target;
    mountComposer();
    composerField.value = raw;
    optimizeAndCommit({ submitAfter: true });
  }

  function handleNativeSendEvent(e) {
    if (forwardingNativeSend) return;
    if (settings.collapsed) return;
    if (handledNativeSendEvents.has(e)) return;
    const button = closestNativeSendTarget(e.target);
    if (!button || button.closest(".prism-composer")) return;
    if (!looksLikeSendButton(button)) return;
    handledNativeSendEvents.add(e);
    if (processing) {
      stopHostSend(e);
      return;
    }
    const field = findVisiblePromptField();
    if (!field) return;
    const raw = getValue(field).trim();
    if (!raw) return;
    if (isTrustedNativeSendEvent(e)) {
      if (shouldPrepareTrustedNativeSend(e, field) && shouldDeferTrustedNativeSend(field, e, button)) {
        stopHostSend(e);
        deferTrustedNativeSend(field, raw);
        return;
      }
      if (shouldPrepareTrustedNativeSend(e, field)) prepareTrustedNativeSend(field);
      return;
    }
    stopHostSend(e);
    activeField = field;
    mountComposer();
    composerField.value = raw;
    optimizeAndCommit({ submitAfter: true });
  }

  window.addEventListener("keydown", handleNativeFieldKeydown, true);
  document.addEventListener("keydown", handleNativeFieldKeydown, true);
  document.addEventListener("pointerdown", handleNativeSendEvent, true);
  window.addEventListener("pointerdown", handleNativeSendEvent, true);
  document.addEventListener("mousedown", handleNativeSendEvent, true);
  window.addEventListener("mousedown", handleNativeSendEvent, true);
  document.addEventListener("click", handleNativeSendEvent, true);
  window.addEventListener("click", handleNativeSendEvent, true);
  function handleNativeSubmitEvent(e) {
    if (forwardingNativeSend) return;
    if (settings.collapsed) return;
    if (handledNativeSubmitEvents.has(e)) return;
    const field = findVisiblePromptField();
    if (!field) return;
    const raw = getValue(field).trim();
    if (!raw) return;
    handledNativeSubmitEvents.add(e);
    if (isTrustedNativeSendEvent(e)) {
      if (shouldDeferTrustedNativeSend(field, e)) {
        stopHostSend(e);
        deferTrustedNativeSend(field, raw);
        return;
      }
      prepareTrustedNativeSend(field);
      return;
    }
    if (processing) return;
    stopHostSend(e);
    activeField = field;
    mountComposer();
    composerField.value = raw;
    optimizeAndCommit({ submitAfter: true });
  }
  window.addEventListener("submit", handleNativeSubmitEvent, true);
  document.addEventListener("submit", handleNativeSubmitEvent, true);

  if (window.__PRISM_TEST__) {
    window.__PrismContentTest = {
      resolvePromptField,
      findVisiblePromptField,
      getValue,
      setValue,
      commitValue,
      getPromptSurfaceRect,
      trySend,
      detectSurfaceModel,
      surfaceAdapter,
    };
  }

  // ---------- DOM observation ----------
  const obs = new MutationObserver((mutations) => {
    if (shouldSkipPrismExtension()) {
      removePrismUiForPageOptOut();
      return;
    }
    if (mutations.every((mutation) => mutation.target.closest?.(".prism-composer,.prism-badge"))) return;
    if (mutations.some((mutation) => mutationTouchesActiveGeometry(mutation))) {
      refreshFromResizeObserver();
      return;
    }
    schedulePosition();
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-expanded", "aria-label", "aria-disabled", "disabled", "data-state", "data-testid"],
    childList: true,
    subtree: true,
  });

  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, true);
  document.addEventListener("scroll", schedulePosition, true);
  document.addEventListener("focusin", schedulePosition, true);
  document.addEventListener("input", schedulePosition, true);
  window.visualViewport?.addEventListener("resize", schedulePosition);
  window.visualViewport?.addEventListener("scroll", schedulePosition);

  function mutationTouchesActiveGeometry(mutation) {
    if (!activeField || !activeField.isConnected) return false;
    const target = mutation.target;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
    if (target === document.documentElement || target === document.body) return false;
    if (target === activeField || target.contains?.(activeField) || activeField.contains?.(target)) return true;
    const root = getControlSearchRoot(activeField);
    return root && root !== document.body && (target === root || root.contains?.(target));
  }

  // ---------- boot ----------
  readState(() => {
    refresh();
  });
})();
