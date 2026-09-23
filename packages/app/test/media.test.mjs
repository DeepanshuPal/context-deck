import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {existsSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApp} from "../dist/server.js";

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-version"], {stdio: "ignore"}); } catch { ffmpeg = false; }
const start = (opts) => new Promise((ok) => { const app = createApp(opts); app.server.listen(0, "127.0.0.1", () => ok({...app, base: `http://127.0.0.1:${app.server.address().port}`})); });
const stop = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });
const post = (url, body) => fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});

function makeScene(dir) {
  const video = join(dir, "scene.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  writeFileSync(join(dir, "scene.srt"), "1\n00:00:01,000 --> 00:00:03,000\nNo sabía que estabas aquí.\n");
  return video;
}

test("saving from an opened file cuts a frame and audio clip, streams media, and reopens deep links", {skip: !ffmpeg && "ffmpeg not installed"}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-media-"));
  const video = makeScene(dir);
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir});
  const opened = await (await post(`${app.base}/api/open-media`, {path: video})).json();
  assert.equal(opened.kind, "video"); assert.match(opened.subtitles.text, /sabía/);
  const ranged = await fetch(`${app.base}${opened.url}`, {headers: {range: "bytes=0-99"}});
  assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  const saved = await (await post(`${app.base}/api/encounters`, {source: {kind: "video", title: "scene.mp4", locator: video}, cue: {index: 0, startMs: 1000, endMs: 3000, text: "No sabía que estabas aquí."}, term: "sabía", frameMs: 2000})).json();
  assert.ok(saved.screenshotPath && existsSync(saved.screenshotPath), "frame written");
  assert.ok(saved.audioClipPath && existsSync(saved.audioClipPath), "audio written");
  const img = await fetch(`${app.base}/api/card-media/${saved.screenshotPath.split("/").pop()}`);
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg");
  const source = await (await fetch(`${app.base}/api/sources/${saved.sourceId}`)).json();
  assert.equal(source.available, true); assert.equal(source.media.path, video);
  await stop(app.server);
});

test("media endpoint refuses files that were never opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-media-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir});
  assert.equal((await fetch(`${app.base}/api/media?path=${encodeURIComponent("/etc/passwd")}`)).status, 404);
  assert.equal((await post(`${app.base}/api/open-media`, {path: "/etc/passwd"})).status, 400);
  assert.equal((await fetch(`${app.base}/api/card-media/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  await stop(app.server);
});

test("Send to Anki pushes new cards once, notices deletions in Anki, and re-sends only on request", async () => {
  const notes = new Map(); let nextId = 1000;
  const anki = createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
    const m = JSON.parse(b); let result = null;
    if (m.action === "addNote") { result = ++nextId; notes.set(result, m.params.note); }
    if (m.action === "notesInfo") result = m.params.notes.map((id) => notes.has(id) ? {noteId: id} : {});
    res.end(JSON.stringify({result, error: null})); }); });
  await new Promise((ok) => anki.listen(0, "127.0.0.1", ok));
  const dir = mkdtempSync(join(tmpdir(), "cd-anki-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir, ankiConnect: `http://127.0.0.1:${anki.address().port}`});
  const saved = await (await post(`${app.base}/api/encounters`, {source: {kind: "video", title: "ep1", locator: "local:ep1"}, cue: {index: 0, startMs: 1000, endMs: 2000, text: "Hola <b>amigo</b>"}, term: "amigo", definition: "friend"})).json();
  const first = await (await post(`${app.base}/api/send-to-anki`, {})).json();
  assert.equal(first.sent, 1);
  const [noteId, note] = [...notes.entries()][0];
  assert.match(note.fields.Front, /&lt;b&gt;amigo/); assert.match(note.fields.Back, /contextdeck:\/\/source\//);
  assert.equal((await (await post(`${app.base}/api/send-to-anki`, {})).json()).sent, 0);
  notes.delete(noteId); // user deletes the card inside Anki
  const sync = await (await post(`${app.base}/api/sync-anki`, {})).json();
  assert.deepEqual(sync, {checked: 1, deletedInAnki: 1, inAnki: 0});
  let list = await (await fetch(`${app.base}/api/encounters`)).json();
  assert.equal(list.length, 1, "encounter history survives"); assert.equal(list[0].cardStatus, "deleted");
  assert.equal((await (await post(`${app.base}/api/send-to-anki`, {})).json()).sent, 0, "deleted cards are not re-sent automatically");
  assert.equal((await post(`${app.base}/api/encounters/${saved.id}/resend`, {})).status, 200);
  list = await (await fetch(`${app.base}/api/encounters`)).json();
  assert.equal(list[0].cardStatus, "in-anki"); assert.equal(notes.size, 1);
  await stop(app.server); await new Promise((ok) => anki.close(ok));
});

test("Send to Anki explains when Anki is closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-anki-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir, ankiConnect: "http://127.0.0.1:9"});
  await post(`${app.base}/api/encounters`, {source: {kind: "video", title: "ep1", locator: "local:ep1"}, cue: {index: 0, startMs: 0, endMs: 1, text: "Hola"}, term: "hola"});
  const res = await post(`${app.base}/api/send-to-anki`, {});
  assert.equal(res.status, 502); assert.match((await res.json()).error, /AnkiConnect/);
  await stop(app.server);
});
