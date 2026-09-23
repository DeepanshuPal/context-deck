import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseStreamUrl, streamLink} from "@context-deck/core";
import {createApp, EXTENSION_ORIGIN} from "../dist/server.js";

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-version"], {stdio: "ignore"}); } catch { ffmpeg = false; }
const start = (opts) => new Promise((ok) => { const app = createApp(opts); app.server.listen(0, "127.0.0.1", () => ok({...app, base: `http://127.0.0.1:${app.server.address().port}`})); });
const stop = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });
const ext = (base, path, body, origin = EXTENSION_ORIGIN) => fetch(`${base}${path}`, body === undefined ? {headers: {origin}} : {method: "POST", headers: {origin, "content-type": "application/json"}, body: JSON.stringify(body)});

test("stream URLs are canonicalised and deep links reopen the moment", () => {
  assert.deepEqual(parseStreamUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=x"), {site: "youtube", id: "dQw4w9WgXcQ", locator: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"});
  assert.equal(parseStreamUrl("https://youtu.be/dQw4w9WgXcQ")?.locator, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(parseStreamUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")?.site, "youtube");
  assert.deepEqual(parseStreamUrl("https://www.netflix.com/watch/81234567?trackId=1"), {site: "netflix", id: "81234567", locator: "https://www.netflix.com/watch/81234567"});
  assert.equal(parseStreamUrl("https://www.netflix.com/in/watch/81234567")?.id, "81234567");
  for (const bad of ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/shorts/abc", "https://evil.com/watch?v=dQw4w9WgXcQ", "https://www.netflix.com/browse", "not a url"]) assert.equal(parseStreamUrl(bad), undefined, bad);
  assert.equal(streamLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 83_400), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=82s");
  assert.equal(streamLink("https://www.netflix.com/watch/81234567", 500), "https://www.netflix.com/watch/81234567?t=0");
});

test("extension bridge: origin rules, encounter + media storage, Anki deep link to the video moment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-stream-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir});
  try {
    // Only this extension's fixed origin may use the bridge, and only the bridge endpoints.
    assert.equal((await ext(app.base, "/api/ext/hello")).status, 200);
    assert.equal((await ext(app.base, "/api/ext/hello", undefined, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status, 403);
    assert.equal((await ext(app.base, "/api/ext/hello", undefined, "https://evil.example")).status, 403);
    assert.equal((await ext(app.base, "/api/encounters")).status, 403, "extension can't read the whole deck");
    assert.equal((await ext(app.base, "/api/send-to-anki", {})).status, 403);
    assert.equal((await ext(app.base, "/api/ext/encounter", {url: "https://www.youtube.com/watch?v=abcdefghijk", term: "x", cue: {text: "x"}}, "https://evil.example")).status, 403);
    assert.equal((await ext(app.base, "/api/ext/encounter", {url: "https://evil.example/watch?v=abcdefghijk", term: "x", cue: {text: "x"}})).status, 400);

    const jpeg = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x36", "-frames:v", "1", "-f", "mjpeg", "-"], {maxBuffer: 1e7});
    const webm = ffmpeg ? execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1.5", "-c:a", "libopus", "-f", "webm", "-"], {maxBuffer: 1e7}) : Buffer.alloc(0);
    const res = await ext(app.base, "/api/ext/encounter", {
      url: "https://www.youtube.com/watch?v=abcdefghijk&t=10s", title: "Clase de español", term: "sabía", definition: "(saber) knew",
      cue: {text: "No sabía que estabas aquí.", startMs: 12_300, endMs: 14_100},
      frame: `data:image/jpeg;base64,${jpeg.toString("base64")}`, audio: `data:audio/webm;codecs=opus;base64,${webm.toString("base64")}`
    });
    assert.equal(res.status, 201);
    const saved = await res.json();
    assert.deepEqual(saved.errors, []);
    assert.ok(existsSync(saved.screenshotPath) && saved.screenshotPath.endsWith(".jpg"));
    assert.ok(existsSync(saved.audioClipPath) && saved.audioClipPath.endsWith(".mp3"), "browser audio is turned into mp3 for Anki");
    assert.equal(readFileSync(saved.screenshotPath).subarray(0, 2).toString("hex"), "ffd8");

    const view = app.store.recentEncounters()[0];
    assert.equal(view.sourceKind, "stream");
    assert.equal(view.sourceLocator, "https://www.youtube.com/watch?v=abcdefghijk");
    assert.equal(view.openUrl, "https://www.youtube.com/watch?v=abcdefghijk&t=11s");
    const card = app.store.card(saved.id);
    assert.equal(card.deepLink, "https://www.youtube.com/watch?v=abcdefghijk&t=11s");

    // Text-only save (e.g. Netflix, copy-protected): no media, still a full encounter. Bad media data is refused, not stored.
    const nf = await (await ext(app.base, "/api/ext/encounter", {url: "https://www.netflix.com/watch/81234567", title: "La casa", term: "aquí", cue: {text: "Estoy aquí.", startMs: 60_000, endMs: 61_000}, frame: "data:text/html;base64,PGI+"})).json();
    assert.equal(nf.screenshotPath, null); assert.equal(nf.audioClipPath, null);
    assert.match(nf.errors[0], /frame/);
    assert.equal(app.store.card(nf.id).deepLink, "https://www.netflix.com/watch/81234567?t=59");

    // Same video saved twice -> one source, two encounters (history is append-only).
    await ext(app.base, "/api/ext/encounter", {url: "https://youtu.be/abcdefghijk", term: "que", cue: {text: "No sabía que estabas aquí.", startMs: 12_300, endMs: 14_100}});
    const list = app.store.recentEncounters();
    assert.equal(list.length, 3);
    assert.equal(new Set(list.filter((e) => e.sourceKind === "stream" && e.sourceLocator.includes("youtube")).map((e) => e.sourceId)).size, 1);
  } finally { await stop(app.server); }
});
