import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync} from "node:fs";
import {homedir, platform} from "node:os";
import {dirname, extname, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {EncounterStore, parseStreamUrl, ankiNotesThatExist, cardsToAnkiFile, parseBrowserCapture, pushToAnkiConnect} from "@context-deck/core";
import {tmpdir} from "node:os";
import {isAbsolute, basename} from "node:path";
import {CATALOG, catalogUrl, runDictionaryJob, type DictionaryJob} from "./dictionaries.js";
import {createWriteStream, writeFileSync} from "node:fs";
import {pipeline} from "node:stream/promises";
import {canPickNatively, transcodeToMp3, extractClip, findSiblingSubtitles, hasFfmpeg, isMediaFile, mediaKind, pickFileNatively, streamFile} from "./media.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The Context Deck browser extension. Its ID is fixed by the public key in apps/extension/manifest.json. */
export const EXTENSION_ORIGIN = "chrome-extension://mbcfobjmnbiojojpdgiagioofoajmnhp";
/** Port the Mac app listens on so the extension can find it (npm start uses 4173). */
export const BRIDGE_PORT = 47317;
const allowedOrigin = (origin: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === EXTENSION_ORIGIN;
const MEDIA_DATA = /^data:(image\/(?:jpeg|webp|png)|audio\/(?:webm|ogg|mp4))(?:;codecs=[\w.,"-]+)?;base64,([A-Za-z0-9+/=]+)$/;
const EXT: Record<string, string> = {"image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a"};
const MIME: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"};

export const defaultDbPath = () => process.env.CONTEXT_DECK_DB ?? (platform() === "darwin"
  ? join(homedir(), "Library", "Application Support", "Context Deck", "deck.db")
  : join(homedir(), ".context-deck", "deck.db"));
export const defaultCaptureDir = () => process.env.CONTEXT_DECK_CAPTURES ?? join(homedir(), "Downloads", "context-deck");

export interface AppOptions {dbPath?: string; captureDir?: string; uiDir?: string; port?: number; mediaDir?: string; ankiConnect?: string;
  /** Host-provided native picker (the Mac app passes Electron's dialog). */
  pickFile?: (kind: "media" | "dictionary") => Promise<string | null>;
  /** Host hook: put the browser extension in a folder the user can load in Chrome; returns that folder. */
  setupExtension?: () => Promise<string>;
  fetcher?: typeof fetch}
export interface ImportResult {imported: number; skipped: number; errors: {file: string; error: string}[]}

export function importCaptureFolder(store: EncounterStore, dir: string): ImportResult {
  const result: ImportResult = {imported: 0, skipped: 0, errors: []};
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    try {
      const outcome = store.importBrowserCapture(parseBrowserCapture(JSON.parse(readFileSync(join(dir, file), "utf8"))));
      outcome.created ? result.imported++ : result.skipped++;
    } catch (error) {
      result.errors.push({file, error: error instanceof Error ? error.message.slice(0, 200) : String(error)});
    }
  }
  return result;
}

const readBody = (req: IncomingMessage, limit = 1_000_000) => new Promise<string>((ok, fail) => {
  let size = 0; const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { fail(new Error("Body too large")); req.destroy(); } else chunks.push(chunk); });
  req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  req.on("error", fail);
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  res.end(JSON.stringify(body));
};

export function createApp(options: AppOptions = {}): {server: Server; store: EncounterStore; dbPath: string; captureDir: string; mediaDir: string} {
  const dbPath = options.dbPath ?? defaultDbPath();
  const captureDir = options.captureDir ?? defaultCaptureDir();
  const uiDir = resolve(options.uiDir ?? join(here, "..", "..", "..", "apps", "desktop"));
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), {recursive: true});
  const store = new EncounterStore(dbPath);
  const mediaDir = options.mediaDir ?? (dbPath === ":memory:" ? join(tmpdir(), "context-deck-media") : join(dirname(dbPath), "media"));
  mkdirSync(mediaDir, {recursive: true});
  const ankiConnect = options.ankiConnect ?? process.env.CONTEXT_DECK_ANKICONNECT ?? "http://127.0.0.1:8765";
  const opened = new Set<string>();
  let extensionSeenAt = 0;
  let dictJob: DictionaryJob = {state: "idle", label: "", bytes: 0, total: 0, entries: 0, files: 0};
  const ankiDown = (message: string) => /fetch failed|ECONNREFUSED/i.test(message);
  const ANKI_CLOSED = "Anki isn't reachable. Open Anki with the AnkiConnect add-on installed, then try again.";
  /** Mark cards whose notes were deleted inside Anki. Encounters are never touched. */
  const reconcile = async () => {
    const live = store.liveAnkiNotes();
    const existing = await ankiNotesThatExist(live.map((l) => l.noteId), ankiConnect);
    let deleted = 0;
    for (const l of live) if (!existing.has(l.noteId)) { store.markCardDeleted(l.encounterId); deleted++; }
    return {checked: live.length, deletedInAnki: deleted, inAnki: live.length - deleted};
  };
  const startDictJob = (label: string, source: {url?: string; path?: string; removeAfter?: boolean}) => {
    if (dictJob.state === "downloading" || dictJob.state === "importing") throw new Error("A dictionary is already being added. Wait for it to finish.");
    dictJob = {state: "downloading", label, bytes: 0, total: 0, entries: 0, files: 0};
    void runDictionaryJob(store, dictJob, source, options.fetcher);
  };
  const allowedMedia = (path: string) => opened.has(path) || store.hasSourceLocator(path);
  const openMedia = (path: string) => {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile() || !isMediaFile(path)) throw new Error("Not a readable local audio/video file");
    opened.add(path);
    const subs = findSiblingSubtitles(path);
    return {path, name: basename(path), kind: mediaKind(path), url: `/api/media?path=${encodeURIComponent(path)}`,
      subtitles: subs ? {name: basename(subs), text: readFileSync(subs, "utf8")} : undefined};
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const host = (req.headers.host ?? "").split(":")[0];
      // Localhost only, and reject cross-site requests from other webpages.
      if (host !== "127.0.0.1" && host !== "localhost") return json(res, 403, {error: "Forbidden host"});
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin) && (req.method !== "GET" || url.pathname.startsWith("/api/"))) return json(res, 403, {error: "Forbidden origin"});
      if (origin === EXTENSION_ORIGIN && !url.pathname.startsWith("/api/ext/") && url.pathname !== "/api/lookup") return json(res, 403, {error: "Forbidden origin"});

      if (url.pathname === "/api/pick-media" && req.method === "POST") {
        const path = options.pickFile ? await options.pickFile("media") : await pickFileNatively("Choose a video or audio file for Context Deck");
        return path ? json(res, 200, openMedia(path)) : json(res, 200, {cancelled: true});
      }
      if (url.pathname === "/api/open-media" && req.method === "POST") return json(res, 200, openMedia(String(JSON.parse(await readBody(req)).path ?? "")));
      if (url.pathname === "/api/media" && req.method === "GET") {
        const path = url.searchParams.get("path") ?? "";
        if (!allowedMedia(path) || !existsSync(path)) return json(res, 404, {error: "Media not available"});
        return streamFile(req, res, path);
      }
      if (url.pathname.startsWith("/api/card-media/") && req.method === "GET") {
        const file = join(mediaDir, basename(decodeURIComponent(url.pathname.slice("/api/card-media/".length))));
        if (!existsSync(file)) return json(res, 404, {error: "Not found"});
        return streamFile(req, res, file);
      }
      if (url.pathname.startsWith("/api/sources/") && req.method === "GET") {
        const source = store.source(decodeURIComponent(url.pathname.slice("/api/sources/".length)));
        if (!source) return json(res, 404, {error: "Unknown source"});
        const available = isAbsolute(source.locator) && existsSync(source.locator);
        return json(res, 200, {...source, available, media: available ? openMedia(source.locator) : undefined});
      }
      if (url.pathname === "/api/send-to-anki" && req.method === "POST") {
        let sync;
        try { sync = await reconcile(); } catch (error) { const m = (error as Error).message; return json(res, ankiDown(m) ? 502 : 500, {error: ankiDown(m) ? ANKI_CLOSED : m}); }
        const sent: string[] = []; const failed: {term: string; error: string}[] = [];
        for (const card of store.unexportedCards()) {
          try { const noteId = await pushToAnkiConnect(card, "Context Deck", ankiConnect); store.markExported(card.encounterId, String(noteId)); sent.push(card.term); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ankiDown(message)) return json(res, 502, {error: ANKI_CLOSED, sent: sent.length});
            failed.push({term: card.term, error: message.slice(0, 200)});
          }
        }
        return json(res, 200, {sent: sent.length, failed, sync});
      }
      if (url.pathname === "/api/sync-anki" && req.method === "POST") {
        try { return json(res, 200, await reconcile()); } catch (error) { const m = (error as Error).message; return json(res, ankiDown(m) ? 502 : 500, {error: ankiDown(m) ? ANKI_CLOSED : m}); }
      }
      if (/^\/api\/encounters\/[^/]+\/resend$/.test(url.pathname) && req.method === "POST") {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        try { const noteId = await pushToAnkiConnect(store.card(id), "Context Deck", ankiConnect); store.markExported(id, String(noteId)); return json(res, 200, {noteId}); }
        catch (error) { const m = (error as Error).message; return json(res, ankiDown(m) ? 502 : 400, {error: ankiDown(m) ? ANKI_CLOSED : m}); }
      }
      if (url.pathname === "/api/extension" && req.method === "GET") return json(res, 200, {connected: Date.now() - extensionSeenAt < 5 * 60_000, lastSeen: extensionSeenAt || null, bridge: (server.address() as {port?: number} | null)?.port === BRIDGE_PORT || (server.address() as {port?: number} | null)?.port === 4173});
      if (url.pathname === "/api/extension/setup" && req.method === "POST") {
        const folder = options.setupExtension ? await options.setupExtension() : resolve(here, "..", "..", "..", "apps", "extension");
        return json(res, 200, {folder});
      }
      if (origin === EXTENSION_ORIGIN) extensionSeenAt = Date.now();
      if (url.pathname === "/api/ext/hello" && req.method === "GET") return json(res, 200, {app: "context-deck", dictionaries: store.listDictionaries().length, ffmpeg: await hasFfmpeg()});
      if (url.pathname === "/api/ext/encounter" && req.method === "POST") {
        const body = JSON.parse(await readBody(req, 12_000_000));
        const ref = parseStreamUrl(String(body.url ?? ""));
        if (!ref) return json(res, 400, {error: "Only YouTube and Netflix watch pages are supported"});
        const term = String(body.term ?? "").trim().slice(0, 200);
        const text = String(body.cue?.text ?? "").trim().slice(0, 2000);
        if (!term || !text) return json(res, 400, {error: "term and cue.text are required"});
        const startMs = Math.max(0, Math.round(Number(body.cue?.startMs) || 0));
        const endMs = Math.max(startMs, Math.round(Number(body.cue?.endMs) || startMs));
        const encounter = store.capture({
          source: {kind: "stream", title: String(body.title ?? "").trim().slice(0, 300) || (ref.site === "youtube" ? "YouTube video" : "Netflix"), locator: ref.locator, language: String(body.language ?? "und").slice(0, 20)},
          cue: {index: 0, startMs, endMs, text}, selectedText: term,
          // Saved while the app was closed (no lookup happened): fill in the dictionary definition now.
          definition: String(body.definition ?? "").trim().slice(0, 4000) || store.lookup(term)?.suggestion || undefined
        });
        const saved: {screenshotPath?: string; audioClipPath?: string} = {}; const errors: string[] = [];
        for (const [field, key] of [["frame", "screenshotPath"], ["audio", "audioClipPath"]] as const) {
          if (!body[field]) continue;
          const m = MEDIA_DATA.exec(String(body[field]));
          if (!m || (field === "frame") !== m[1].startsWith("image/")) { errors.push(`${field}: unsupported data`); continue; }
          const file = join(mediaDir, `${encounter.id}.${EXT[m[1]]}`);
          writeFileSync(file, Buffer.from(m[2], "base64"));
          saved[key] = file;
        }
        if (saved.audioClipPath && !saved.audioClipPath.endsWith(".m4a") && await hasFfmpeg()) {
          try { saved.audioClipPath = await transcodeToMp3(saved.audioClipPath); } catch (e) { errors.push(`audio: ${(e as Error).message.slice(0, 200)}`); }
        }
        store.attachMedia(encounter.id, saved);
        return json(res, 201, {...store.getEncounter(encounter.id), errors});
      }
      if (url.pathname === "/api/lookup" && req.method === "GET") return json(res, 200, store.lookup(url.searchParams.get("term") ?? ""));
      if (url.pathname === "/api/dictionaries" && req.method === "GET") return json(res, 200, {installed: store.listDictionaries(), catalog: CATALOG, job: dictJob});
      if (url.pathname === "/api/dictionaries/download" && req.method === "POST") {
        const code = String(JSON.parse(await readBody(req)).code ?? "");
        const entry = CATALOG.find((c) => c.code === code);
        if (!entry) return json(res, 400, {error: "Unknown language"});
        startDictJob(`${entry.name} → English`, {url: catalogUrl(code)});
        return json(res, 202, dictJob);
      }
      if (url.pathname === "/api/dictionaries/import-file" && req.method === "POST") {
        const path = options.pickFile ? await options.pickFile("dictionary") : await pickFileNatively("Choose a Yomitan dictionary .zip");
        if (!path) return json(res, 200, {cancelled: true});
        startDictJob(basename(path), {path});
        return json(res, 202, dictJob);
      }
      if (url.pathname === "/api/dictionaries/upload" && req.method === "POST") {
        const temp = join(tmpdir(), `context-deck-upload-${Date.now()}.zip`);
        await pipeline(req, createWriteStream(temp));
        startDictJob(url.searchParams.get("name") ?? "dictionary.zip", {path: temp, removeAfter: true});
        return json(res, 202, dictJob);
      }
      if (url.pathname.startsWith("/api/dictionaries/") && req.method === "DELETE") {
        store.removeDictionary(Number(url.pathname.split("/").pop()));
        return json(res, 200, {ok: true});
      }
      if (url.pathname === "/api/encounters" && req.method === "GET") return json(res, 200, store.recentEncounters());
      if (url.pathname === "/api/encounters" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const term = String(body.term ?? "").trim();
        const cue = body.cue ?? {};
        if (!term || typeof cue.text !== "string" || !cue.text.trim()) return json(res, 400, {error: "term and cue.text are required"});
        const kind = body.source?.kind === "audio" ? "audio" : "video";
        const locator = String(body.source?.locator ?? body.source?.title ?? "local").slice(0, 1000);
        const encounter = store.capture({
          source: {kind, title: String(body.source?.title ?? "Untitled media").slice(0, 300), locator, language: String(body.source?.language ?? "und")},
          cue: {index: Number(cue.index) || 0, startMs: Math.max(0, Math.round(Number(cue.startMs) || 0)), endMs: Math.max(0, Math.round(Number(cue.endMs) || 0)), text: cue.text.trim()},
          selectedText: term,
          definition: String(body.definition ?? "").trim() || undefined
        });
        let clip: {errors: string[]} | undefined;
        if (isAbsolute(locator) && allowedMedia(locator) && existsSync(locator) && await hasFfmpeg()) {
          const extracted = await extractClip({media: locator, startMs: encounter.startMs, endMs: encounter.endMs, frameMs: Number(body.frameMs) || undefined, outDir: mediaDir, id: encounter.id, video: kind === "video"});
          store.attachMedia(encounter.id, extracted);
          clip = {errors: extracted.errors};
        }
        return json(res, 201, {...store.getEncounter(encounter.id), clip});
      }
      if (url.pathname === "/api/export.tsv" && req.method === "GET") {
        const cards = store.allCards();
        for (const card of cards) store.markExported(card.encounterId);
        res.writeHead(200, {"content-type": "text/tab-separated-values; charset=utf-8", "content-disposition": 'attachment; filename="context-deck-anki.txt"', "cache-control": "no-store"});
        return res.end(cardsToAnkiFile(cards));
      }
      if (url.pathname === "/api/import-captures" && req.method === "POST") return json(res, 200, {...importCaptureFolder(store, captureDir), captureDir});
      if (url.pathname === "/api/import-capture" && req.method === "POST") {
        const outcome = store.importBrowserCapture(parseBrowserCapture(JSON.parse(await readBody(req))));
        return json(res, 200, {created: outcome.created});
      }
      if (url.pathname === "/api/info" && req.method === "GET") return json(res, 200, {dbPath, captureDir, mediaDir, ffmpeg: await hasFfmpeg(), canPick: Boolean(options.pickFile) || canPickNatively()});

      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = resolve(uiDir, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
        if (!file.startsWith(uiDir + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, {error: "Not found"});
        res.writeHead(200, {"content-type": MIME[extname(file)] ?? "application/octet-stream"});
        return res.end(readFileSync(file));
      }
      return json(res, 404, {error: "Not found"});
    } catch (error) {
      return json(res, 400, {error: error instanceof Error ? error.message.slice(0, 300) : "Bad request"});
    }
  });
  server.on("close", () => store.close());
  return {server, store, dbPath, captureDir, mediaDir};
}
