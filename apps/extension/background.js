// Context Deck extension service worker.
// Talks only to the Context Deck app on this computer (127.0.0.1). Nothing is sent anywhere else.
const PORTS = [47317, 4173]; // Mac app, then `npm start`
const QUEUE_KEY = "pendingEncounters";
const CAPTURE_ID = "context-deck-capture";
let base = null;

async function findApp() {
  const candidates = base ? [base, ...PORTS.map((p) => `http://127.0.0.1:${p}`).filter((b) => b !== base)] : PORTS.map((p) => `http://127.0.0.1:${p}`);
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/api/ext/hello`, {signal: AbortSignal.timeout(1500)});
      const body = await res.json();
      if (res.ok && body.app === "context-deck") { base = candidate; return {base, ...body}; }
    } catch {}
  }
  base = null;
  return null;
}

async function call(path, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!base && !(await findApp())) throw Object.assign(new Error("Context Deck app isn't running"), {offline: true});
    try {
      const res = await fetch(`${base}${path}`, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), {status: res.status});
      return body;
    } catch (error) {
      if (error.status) throw error;
      base = null; // app restarted or moved port; look again once
    }
  }
  throw Object.assign(new Error("Context Deck app isn't running"), {offline: true});
}

async function queued() { return (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] ?? []; }

/** Send encounters saved while the app was closed. Oldest first; stops at the first failure. */
async function flushQueue() {
  const items = await queued();
  let sent = 0;
  while (items.length) {
    try { await call("/api/ext/encounter", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(items[0])}); }
    catch (error) { if (error.offline) break; items.shift(); continue; } // a rejected item would block the queue forever
    items.shift(); sent++;
  }
  await chrome.storage.local.set({[QUEUE_KEY]: items});
  return {sent, left: items.length};
}

async function save(encounter) {
  await flushQueue();
  try {
    const saved = await call("/api/ext/encounter", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(encounter)});
    return {ok: true, queued: false, id: saved.id, errors: saved.errors ?? []};
  } catch (error) {
    if (!error.offline) return {ok: false, error: error.message};
    const items = await queued(); items.push(encounter);
    await chrome.storage.local.set({[QUEUE_KEY]: items});
    return {ok: true, queued: true, pending: items.length};
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message?.type === "lookup") {
      try { return {ok: true, result: await call(`/api/lookup?term=${encodeURIComponent(message.term)}`)}; }
      catch (error) { return {ok: false, offline: Boolean(error.offline), error: error.message}; }
    }
    if (message?.type === "save") return save(message.encounter);
    if (message?.type === "status") {
      const app = await findApp();
      if (app) await flushQueue();
      return {app, pending: (await queued()).length};
    }
    return {ok: false, error: "unknown message"};
  })().then(reply, (error) => reply({ok: false, error: String(error?.message ?? error)}));
  return true;
});

// Right-click "Save selection to Context Deck" on any page: kept from 0.1 (files land in Downloads/context-deck).
chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({id: CAPTURE_ID, title: "Save selection to Context Deck", contexts: ["selection"]}));
const capture = async (info, tab) => {
  if (info.menuItemId !== CAPTURE_ID || !info.selectionText || !tab?.url || !tab.title || !/^https?:/.test(tab.url)) return;
  const record = {version: 1, source: {kind: "web", title: tab.title, locator: tab.url, language: "und"}, selectedText: info.selectionText.trim(), sentence: info.selectionText.trim(), capturedAt: new Date().toISOString()};
  const key = `capture-${Date.now()}`;
  await chrome.storage.local.set({[key]: record});
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(record, null, 2))}`;
  await chrome.downloads.download({url, filename: `context-deck/${key}.json`, saveAs: false});
};
chrome.contextMenus.onClicked.addListener(capture);
self.contextDeckCapture = capture;
self.contextDeckFlush = flushQueue;
