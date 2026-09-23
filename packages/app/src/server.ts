import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync} from "node:fs";
import {homedir, platform} from "node:os";
import {dirname, extname, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {EncounterStore, cardsToAnkiFile, parseBrowserCapture} from "@context-deck/core";

const here = dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"};

export const defaultDbPath = () => process.env.CONTEXT_DECK_DB ?? (platform() === "darwin"
  ? join(homedir(), "Library", "Application Support", "Context Deck", "deck.db")
  : join(homedir(), ".context-deck", "deck.db"));
export const defaultCaptureDir = () => process.env.CONTEXT_DECK_CAPTURES ?? join(homedir(), "Downloads", "context-deck");

export interface AppOptions {dbPath?: string; captureDir?: string; uiDir?: string; port?: number}
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

export function createApp(options: AppOptions = {}): {server: Server; store: EncounterStore; dbPath: string; captureDir: string} {
  const dbPath = options.dbPath ?? defaultDbPath();
  const captureDir = options.captureDir ?? defaultCaptureDir();
  const uiDir = resolve(options.uiDir ?? join(here, "..", "..", "..", "apps", "desktop"));
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), {recursive: true});
  const store = new EncounterStore(dbPath);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const host = (req.headers.host ?? "").split(":")[0];
      // Localhost only, and reject cross-site requests from other webpages.
      if (host !== "127.0.0.1" && host !== "localhost") return json(res, 403, {error: "Forbidden host"});
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, {error: "Forbidden origin"});

      if (url.pathname === "/api/encounters" && req.method === "GET") return json(res, 200, store.recentEncounters());
      if (url.pathname === "/api/encounters" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const term = String(body.term ?? "").trim();
        const cue = body.cue ?? {};
        if (!term || typeof cue.text !== "string" || !cue.text.trim()) return json(res, 400, {error: "term and cue.text are required"});
        const kind = body.source?.kind === "audio" ? "audio" : "video";
        const encounter = store.capture({
          source: {kind, title: String(body.source?.title ?? "Untitled media").slice(0, 300), locator: String(body.source?.locator ?? body.source?.title ?? "local").slice(0, 1000), language: String(body.source?.language ?? "und")},
          cue: {index: Number(cue.index) || 0, startMs: Math.max(0, Math.round(Number(cue.startMs) || 0)), endMs: Math.max(0, Math.round(Number(cue.endMs) || 0)), text: cue.text.trim()},
          selectedText: term,
          definition: String(body.definition ?? "").trim() || undefined
        });
        return json(res, 201, encounter);
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
      if (url.pathname === "/api/info" && req.method === "GET") return json(res, 200, {dbPath, captureDir});

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
  return {server, store, dbPath, captureDir};
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
