(function () {
  "use strict";
  if (window.__prismPageBridgeInstalled) return;
  window.__prismPageBridgeInstalled = true;
  try { document.documentElement.dataset.prismPageBridge = "ready"; } catch {}

  function getText(el) {
    return (el?.innerText || el?.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function valuesMatch(actual, expected) {
    const a = String(actual || "").replace(/\s+/g, " ").trim();
    const e = String(expected || "").replace(/\s+/g, " ").trim();
    return a === e;
  }

  function candidateInstances(el) {
    const out = [];
    let node = el;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const instance = node.__vueParentComponent || node.__vue_app__?._instance || null;
      if (instance) out.push(instance);
    }
    return out;
  }

  function replaceViaLexicalEditor(el, value) {
    const editor = el?.__lexicalEditor;
    if (!editor || typeof editor.parseEditorState !== "function" || typeof editor.setEditorState !== "function") return false;
    const state = {
      root: {
        children: [
          {
            children: value
              ? [{ detail: 0, format: 0, mode: "normal", style: "", text: value, type: "text", version: 1 }]
              : [],
            direction: value ? "ltr" : null,
            format: "",
            indent: 0,
            type: "paragraph",
            version: 1,
            textFormat: 0,
            textStyle: ""
          }
        ],
        direction: value ? "ltr" : null,
        format: "",
        indent: 0,
        type: "root",
        version: 1
      }
    };
    try {
      editor.setEditorState(editor.parseEditorState(JSON.stringify(state)));
      if (typeof editor.focus === "function") editor.focus();
      return true;
    } catch {
      return false;
    }
  }

  function exposedTargets(instance) {
    const out = [];
    let cur = instance;
    for (let depth = 0; cur && depth < 18; depth += 1, cur = cur.parent) {
      out.push(cur.exposed, cur.proxy, cur.ctx);
      if (cur.subTree?.component) out.push(cur.subTree.component.exposed, cur.subTree.component.proxy, cur.subTree.component.ctx);
    }
    return out.filter(Boolean);
  }

  function callEditorApi(el, value) {
    if (replaceViaLexicalEditor(el, value)) return true;
    let sawInstance = false;
    for (const instance of candidateInstances(el)) {
      sawInstance = true;
      for (const target of exposedTargets(instance)) {
        try {
          if (typeof target.replaceAll === "function") {
            target.replaceAll(value);
            return true;
          }
          if (typeof target.clear === "function" && typeof target.insertText === "function") {
            target.clear();
            target.insertText(value);
            return true;
          }
        } catch {}
      }
    }
    return sawInstance ? "no-api" : "no-instance";
  }

  window.addEventListener("PrismPageBridgeReplace", (event) => {
    const detail = event.detail || {};
    const id = String(detail.id || "");
    const value = String(detail.value || "");
    const selector = `[data-prism-bridge-id="${CSS.escape(id)}"]`;
    const el = id ? document.querySelector(selector) : null;
    let ok = false;
    let reason = el ? "not-called" : "no-element";
    if (el) {
      const result = callEditorApi(el, value);
      ok = result === true;
      reason = ok ? "called" : String(result || "failed");
    }
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("PrismPageBridgeReplaceResult", {
        detail: { id, ok: ok && valuesMatch(getText(el), value), reason, text: getText(el) }
      }));
    }, 0);
  }, false);
})();
