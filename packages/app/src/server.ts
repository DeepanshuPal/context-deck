import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync} from "node:fs";
import {homedir, platform} from "node:os";
import {dirname, extname, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {EncounterStore, cardsToAnkiFile, parseBrowserCapture, pushToAnkiConnect} from "@context-deck/core";
import {tmpdir} from "node:os";
import {isAbsolute, basename} from "node:path";
import {canPickNatively, extractClip, findSiblingSubtitles, hasFfmpeg, isMediaFile, mediaKind, pickFileNatively, streamFile} from "./media.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"};

export const defaultDbPath = () => process.env.CONTEXT_DECK_DB ?? (platform() === "darwin"
  ? join(homedir(), "Library", "Application Support", "Context Deck", "deck.db")
  : join(homedir(), ".context-deck", "deck.db"));
export const defaultCaptureDir = () => process.env.CONTEXT_DECK_CAPTURES ?? join(homedir(), "Downloads", "context-deck");

export interface AppOptions {dbPath?: string; captureDir?: string; uiDir?: string; port?: number; mediaDir?: string; ankiConnect?: string}
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
      if (req.method !== "GET" && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, {error: "Forbidden origin"});

      if (url.pathname === "/api/pick-media" && req.method === "POST") {
        const path = await pickFileNatively("Choose a video or audio file for Context Deck");
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
        const sent: string[] = []; const failed: {term: string; error: string}[] = [];
        for (const card of store.unexportedCards()) {
          try { const noteId = await pushToAnkiConnect(card, "Context Deck", ankiConnect); store.markExported(card.encounterId, String(noteId)); sent.push(card.term); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/fetch failed|ECONNREFUSED/i.test(message)) return json(res, 502, {error: "Anki isn't reachable. Open Anki with the AnkiConnect add-on installed, then try again.", sent: sent.length});
            failed.push({term: card.term, error: message.slice(0, 200)});
          }
        }
        return json(res, 200, {sent: sent.length, failed});
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
      if (url.pathname === "/api/info" && req.method === "GET") return json(res, 200, {dbPath, captureDir, mediaDir, ffmpeg: await hasFfmpeg(), canPick: canPickNatively()});

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const {server, dbPath, captureDir} = createApp();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Context Deck running at http://127.0.0.1:${port}`);
    console.log(`Database: ${dbPath}`);
    console.log(`Extension captures folder: ${captureDir}`);
  });
}
