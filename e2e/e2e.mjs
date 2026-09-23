// v0.7 end-to-end: real Chrome + the real extension on YouTube/Netflix-shaped pages (served for www.youtube.com / www.netflix.com
// through a host-resolver rule), the real app server, the real Spanish Wiktionary pack, and an AnkiConnect mock.
import puppeteer from "puppeteer-core";
import {spawn, execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {existsSync, mkdirSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createApp} from "../packages/app/dist/server.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const WORK = process.env.E2E_WORK ?? "/tmp/context-deck-e2e";
const DICT = process.env.E2E_DICT ?? join(WORK, "wty-es-en.zip");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

const SHOTS = process.env.E2E_SHOTS ?? join(WORK, "shots"); mkdirSync(SHOTS, {recursive: true});
const ROOT = join(WORK, "run"); rmSync(ROOT, {recursive: true, force: true}); mkdirSync(ROOT, {recursive: true});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, x) => console.log(`STEP ${step}: ${typeof x === "string" ? x : JSON.stringify(x)}`);
const check = (cond, msg) => { if (!cond) { console.log(`FAIL: ${msg}`); process.exitCode = 1; throw new Error(msg); } };
const children = []; process.on("exit", () => children.forEach((c) => { try { c.kill(); } catch {} }));

// AnkiConnect mock
const notes = new Map(); let nextId = 1000;
createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => { const {action, params} = JSON.parse(b); let result = null;
  if (action === "addNote") { const id = nextId++; notes.set(id, params.note); result = id; }
  if (action === "notesInfo") result = params.notes.map((id) => notes.has(id) ? {noteId: id} : {});
  res.end(JSON.stringify({result, error: null})); }); }).listen(8866, "127.0.0.1");

// Test media and a self-signed cert for www.youtube.com / www.netflix.com (mapped to the local fixture server).
mkdirSync(WORK, {recursive: true});
if (!existsSync(join(WORK, "scene.mp4"))) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=330:beep_factor=4", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", join(WORK, "scene.mp4")]);
if (!existsSync(join(WORK, "cert.pem"))) execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(WORK, "key.pem"), "-out", join(WORK, "cert.pem"), "-days", "2", "-subj", "/CN=www.youtube.com", "-addext", "subjectAltName=DNS:www.youtube.com,DNS:www.netflix.com"], {stdio: "ignore"});
if (!existsSync(DICT)) execFileSync("curl", ["-sSfL", "-o", DICT, "https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/es/en/wty-es-en.zip"]);
const fixture = spawn("node", [join(HERE, "fixture.mjs")], {cwd: WORK, stdio: "inherit"}); children.push(fixture);
await sleep(700);
const startApp = () => new Promise((ok) => { const a = createApp({dbPath: `${ROOT}/deck.db`, captureDir: `${ROOT}/caps`, ankiConnect: "http://127.0.0.1:8866"}); a.server.listen(47317, "127.0.0.1", () => ok(a)); });
let app = await startApp();
const A = "http://127.0.0.1:47317";
// Real Spanish pack through the app's own upload endpoint.
await fetch(`${A}/api/dictionaries/upload?name=wty-es-en.zip`, {method: "POST", body: await import("node:fs").then((f) => f.readFileSync(DICT))});
for (let i = 0; i < 120; i++) { const j = (await (await fetch(`${A}/api/dictionaries`)).json()).job; if (j.state === "done") break; if (j.state === "error") throw new Error(j.error); await sleep(500); }
log(1, {dictionaries: (await (await fetch(`${A}/api/dictionaries`)).json()).installed.map((d) => `${d.title} ${d.entry_count ?? d.entryCount}`)});

const browser = await puppeteer.launch({executablePath: CHROME, headless: true, pipe: true, enableExtensions: true,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors",
    "--host-resolver-rules=MAP www.youtube.com 127.0.0.1:4443, MAP www.netflix.com 127.0.0.1:4443"]});
const extId = await browser.installExtension(join(REPO, "apps", "extension"));
check(extId === "mbcfobjmnbiojojpdgiagioofoajmnhp", `fixed extension id (got ${extId})`);
log(2, `extension installed with fixed id ${extId}`);

const shadow = (page, sel) => page.evaluate((sel) => { const h = document.getElementById("context-deck-host"); const el = h?.shadowRoot.querySelector(sel); return el ? {hidden: el.hidden, text: el.textContent} : null; }, sel);
const hoverWord = async (page, word, click = false, shift = false) => {
  const box = await page.evaluate((word) => { const h = document.getElementById("context-deck-host"); const w = [...h.shadowRoot.querySelectorAll(".w")].find((x) => x.textContent === word); if (!w) return null; const r = w.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; }, word);
  check(box, `word ${word} rendered in overlay`);
  await page.mouse.move(box.x, box.y);
  if (click) { if (shift) await page.keyboard.down("Shift"); await page.mouse.click(box.x, box.y); if (shift) await page.keyboard.up("Shift"); }
};
const waitPop = (page, re, timeout = 15000) => page.waitForFunction((re) => { const p = document.getElementById("context-deck-host")?.shadowRoot.querySelector(".pop"); return p && !p.hidden && new RegExp(re).test(p.textContent); }, {timeout}, re);

// 3. YouTube: overlay replaces captions, hover defines, S saves with frame + audio.
const yt = await browser.newPage(); await yt.setViewport({width: 1100, height: 760});
await yt.goto("https://www.youtube.com/watch?v=abcdefghijk&t=0s");
await yt.evaluate(() => document.querySelector("video").play());
await yt.waitForFunction(() => document.getElementById("context-deck-host")?.shadowRoot.querySelector(".bar:not([hidden])")?.textContent === "No sabía que estabas aquí.", {timeout: 10000});
const nativeHidden = await yt.evaluate(() => getComputedStyle(document.querySelector(".ytp-caption-window-container")).opacity);
check(nativeHidden === "0", "native YouTube captions hidden while the overlay shows them");
await hoverWord(yt, "sabía");
await waitPop(yt, "saber");
const pausedOnHover = await yt.evaluate(() => document.querySelector("video").paused);
check(pausedOnHover, "video pauses while hovering a word");
const popText = (await shadow(yt, ".pop")).text;
const defValue = await yt.evaluate(() => document.getElementById("context-deck-host").shadowRoot.querySelector("textarea").value);
log(3, {pausedOnHover, popup: popText.slice(0, 160), definition: defValue});
await yt.screenshot({path: `${SHOTS}/v07-youtube-hover.png`});
await yt.keyboard.press("s");
await waitPop(yt, "Saved to Context Deck", 25000);
const t1 = await yt.evaluate(() => document.querySelector("video").currentTime);
await yt.screenshot({path: `${SHOTS}/v07-youtube-saved.png`});
let rows = await (await fetch(`${A}/api/encounters`)).json();
const e1 = rows[0];
check(e1.term === "sabía" && e1.sourceKind === "stream" && e1.sentence === "No sabía que estabas aquí.", "YouTube encounter stored");
check(e1.screenshotPath?.endsWith(".jpg") && existsSync(e1.screenshotPath), "frame stored");
check(e1.audioClipPath?.endsWith(".mp3") && existsSync(e1.audioClipPath), "audio clip stored as mp3");
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", e1.audioClipPath]).toString());
const vol = Number(/mean_volume: (-?[\d.]+) dB/.exec((await import("node:child_process")).spawnSync("ffmpeg", ["-i", e1.audioClipPath, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString())?.[1] ?? -999);
log(4, {term: e1.term, definition: e1.definition, startMs: e1.startMs, endMs: e1.endMs, openUrl: e1.openUrl, frame: e1.screenshotPath.split("/").pop(), audioSeconds: dur, meanVolumeDb: vol, resumedAt: t1});
check(vol > -40, `clip has real audio, not silence (${vol} dB)`);
check(dur > 1.5 && dur < 4.5, `clip covers the line (${dur}s for a 2.5s line)`);
check(Math.abs(e1.startMs - 1000) < 400 && Math.abs(e1.endMs - 3500) < 400, `cue timing tracked from captions (${e1.startMs}-${e1.endMs})`);

// 5. Shift-click a phrase, edit the definition, click Save.
await yt.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 4.2; return v.play(); });
await yt.waitForFunction(() => /buscando/.test(document.getElementById("context-deck-host")?.shadowRoot.querySelector(".bar")?.textContent ?? ""), {timeout: 8000});
await hoverWord(yt, "estás", true);
await waitPop(yt, "estar|estás");
await hoverWord(yt, "buscando", true, true);
await waitPop(yt, "estás buscando");
await yt.evaluate(() => { const t = document.getElementById("context-deck-host").shadowRoot.querySelector("textarea"); t.value = "are you looking for"; t.dispatchEvent(new Event("input")); });
await yt.evaluate(() => document.getElementById("context-deck-host").shadowRoot.querySelector(".save").click());
await waitPop(yt, "Saved to Context Deck", 25000);
rows = await (await fetch(`${A}/api/encounters`)).json();
check(rows[0].term === "estás buscando" && rows[0].definition === "are you looking for", "phrase saved with edited definition");
log(5, {term: rows[0].term, definition: rows[0].definition, sentence: rows[0].sentence});

// 6. Netflix-shaped page with copy protection (EME ClearKey media keys): text-only, never frame/audio.
const nf = await browser.newPage(); await nf.setViewport({width: 1100, height: 760});
await nf.goto("https://www.netflix.com/watch/81234567?trackId=14170286");
await nf.waitForFunction(() => window.protectedReady !== undefined, {timeout: 8000});
const prot = await nf.evaluate(() => ({ready: window.protectedReady, keys: Boolean(document.querySelector("video").mediaKeys)}));
check(prot.keys, `fixture video has media keys (${prot.ready})`);
await nf.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 7.1; return v.play(); });
await nf.waitForFunction(() => document.getElementById("context-deck-host")?.shadowRoot.querySelector(".bar:not([hidden])")?.textContent === "Ya lo sé.", {timeout: 10000});
await hoverWord(nf, "sé", true);
await waitPop(nf, "saber");
await nf.screenshot({path: `${SHOTS}/v07-netflix-click.png`});
await nf.keyboard.press("s");
await waitPop(nf, "copy-protected", 15000);
rows = await (await fetch(`${A}/api/encounters`)).json();
check(rows[0].term === "sé" && !rows[0].screenshotPath && !rows[0].audioClipPath, "Netflix save is text only");
log(6, {term: rows[0].term, title: rows[0].sourceTitle, definition: rows[0].definition, openUrl: rows[0].openUrl, media: [rows[0].screenshotPath, rows[0].audioClipPath]});

// 7. App closed: saves wait in the browser, then move into the app when it's back.
await new Promise((ok) => { app.server.close(ok); app.server.closeAllConnections(); });
await yt.bringToFront();
await yt.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 1.2; return v.play(); });
await yt.waitForFunction(() => /sabía/.test(document.getElementById("context-deck-host")?.shadowRoot.querySelector(".bar:not([hidden])")?.textContent ?? ""), {timeout: 8000});
await hoverWord(yt, "aquí", true);
await waitPop(yt, "Open the Context Deck app");
await yt.keyboard.press("s");
await waitPop(yt, "Saved on this browser", 25000);
app = await startApp();
const popup = await browser.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForFunction(() => /Connected/.test(document.getElementById("app").textContent), {timeout: 8000});
await sleep(500);
rows = await (await fetch(`${A}/api/encounters`)).json();
check(rows[0].term === "aquí" && rows.length === 4 && rows[0].definition.length > 0, "queued save arrived after the app came back, with a definition filled in");
log(7, {arrived: rows[0].term, total: rows.length, popup: await popup.evaluate(() => document.body.innerText.split("\n").slice(0, 3).join(" | "))});
await popup.screenshot({path: `${SHOTS}/v07-popup.png`});

// 8. Send to Anki: YouTube card has audio + picture + link to the moment on YouTube; Netflix card links to the episode moment.
const sent = await (await fetch(`${A}/api/send-to-anki`, {method: "POST", headers: {origin: A}})).json();
check(sent.sent === 4, `4 cards sent (${JSON.stringify(sent)})`);
const all = [...notes.values()];
const ytNote = all.find((n) => n.fields.Front.startsWith("sabía"));
const nfNote = all.find((n) => n.fields.Front.startsWith("sé"));
check(/youtube\.com\/watch\?v=abcdefghijk&amp;t=\d+s|youtube\.com\/watch\?v=abcdefghijk&t=\d+s/.test(ytNote.fields.Back), "YouTube card links to the moment");
check(ytNote.audio?.length && ytNote.picture?.length, "YouTube card carries audio and picture");
check(/netflix\.com\/watch\/81234567\?t=\d+/.test(nfNote.fields.Back) && !nfNote.audio?.length && !nfNote.picture?.length, "Netflix card: link, no media");
log(8, {youtubeBack: ytNote.fields.Back, audio: ytNote.audio[0].filename, picture: ytNote.picture[0].filename, netflixBack: nfNote.fields.Back});

// 9. The app shows the stream rows with a link back to the video.
const ui = await browser.newPage(); await ui.setViewport({width: 1280, height: 1000});
await ui.goto(A); await ui.waitForSelector("#rows .row");
const links = await ui.$$eval("#rows a", (as) => as.map((a) => [a.textContent, a.href]));
check(links.some(([t, h]) => t === "Watch on YouTube" && h.includes("&t=")) && links.some(([t]) => t === "Watch on Netflix"), "app rows link back to the videos");
await ui.screenshot({path: `${SHOTS}/v07-app-rows.png`, fullPage: true});
await ui.click("#ext"); await ui.waitForFunction(() => /connected/.test(document.getElementById("ext-state").textContent), {timeout: 5000});
const extState = await ui.$eval("#ext-state", (e) => e.textContent);
check(extState.startsWith("✓"), `app sees the extension as connected (${extState})`);
await ui.click("#ext-setup"); await ui.waitForFunction(() => document.getElementById("ext-folder").textContent.length > 0);
const folder = await ui.$eval("#ext-folder", (e) => e.textContent);
check(existsSync(join(folder, "manifest.json")), `extension folder offered (${folder})`);
await ui.screenshot({path: `${SHOTS}/v07-app-extension-dialog.png`});
log(9, {links, extState, folder});
console.log("ALL STEPS PASSED");
await browser.close(); process.exit(0);
