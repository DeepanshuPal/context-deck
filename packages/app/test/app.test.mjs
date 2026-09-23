import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, writeFileSync, mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApp} from "../dist/server.js";

const start = (opts) => new Promise((ok) => { const app = createApp(opts); app.server.listen(0, "127.0.0.1", () => ok({...app, base: `http://127.0.0.1:${app.server.address().port}`})); });
const stop = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });

test("saves persist across restarts and export returns Anki TSV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-")); const dbPath = join(dir, "deck.db");
  let app = await start({dbPath, captureDir: join(dir, "caps")});
  const post = await fetch(`${app.base}/api/encounters`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({source: {kind: "video", title: "ep1.mp4", locator: "local:ep1.mp4:10"}, cue: {index: 0, startMs: 2000, endMs: 4000, text: "No sabía nada."}, term: "sabía", definition: "I knew"})});
  assert.equal(post.status, 201);
  await stop(app.server);
  app = await start({dbPath, captureDir: join(dir, "caps")});
  const list = await (await fetch(`${app.base}/api/encounters`)).json();
  assert.equal(list.length, 1); assert.equal(list[0].term, "sabía");
  const tsv = await (await fetch(`${app.base}/api/export.tsv`)).text();
  assert.match(tsv, /^#separator:Tab/); assert.match(tsv, /contextdeck:\/\/source\/.+t=2000/);
  const ui = await fetch(`${app.base}/`); assert.equal(ui.status, 200);
  await stop(app.server);
});

test("imports extension captures once and reports bad files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-")); const caps = join(dir, "caps"); mkdirSync(caps);
  writeFileSync(join(caps, "capture-1.json"), JSON.stringify({version: 1, source: {kind: "web", title: "Artículo", locator: "https://example.com/a", language: "und"}, selectedText: "prueba", sentence: "Esto es una prueba.", capturedAt: "2026-09-23T07:00:00.000Z"}));
  writeFileSync(join(caps, "capture-2.json"), "{broken");
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: caps});
  const first = await (await fetch(`${app.base}/api/import-captures`, {method: "POST"})).json();
  assert.equal(first.imported, 1); assert.equal(first.errors.length, 1);
  const again = await (await fetch(`${app.base}/api/import-captures`, {method: "POST"})).json();
  assert.equal(again.imported, 0); assert.equal(again.skipped, 1);
  await stop(app.server);
});

test("rejects cross-site writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir});
  const res = await fetch(`${app.base}/api/import-captures`, {method: "POST", headers: {origin: "https://evil.example"}});
  assert.equal(res.status, 403);
  await stop(app.server);
});
