import {execFile} from "node:child_process";
import {existsSync, statSync, createReadStream, readdirSync} from "node:fs";
import {extname, join, parse} from "node:path";
import {platform} from "node:os";
import type {IncomingMessage, ServerResponse} from "node:http";

const run = (bin: string, args: string[], timeout = 60_000) => new Promise<string>((ok, fail) =>
  execFile(bin, args, {timeout, maxBuffer: 4_000_000}, (error, stdout, stderr) => error ? fail(new Error(`${error.message}\n${String(stderr).slice(-400)}`)) : ok(String(stdout))));

export const ffmpegBinary = () => process.env.CONTEXT_DECK_FFMPEG ?? "ffmpeg";

let ffmpegCheck: Promise<boolean> | undefined;
export const hasFfmpeg = () => ffmpegCheck ??= run(ffmpegBinary(), ["-version"], 10_000).then(() => true, () => false);

export interface ClipRequest {media: string; startMs: number; endMs: number; frameMs?: number; outDir: string; id: string; video: boolean}
export interface ClipResult {screenshotPath?: string; audioClipPath?: string; errors: string[]}

/** Cut a still frame and a short audio clip from the user's own local file with their installed ffmpeg. */
export async function extractClip(req: ClipRequest): Promise<ClipResult> {
  const result: ClipResult = {errors: []};
  const pad = 250;
  const from = Math.max(0, req.startMs - pad) / 1000;
  const length = Math.max(0.5, (req.endMs - req.startMs + pad * 2) / 1000);
  const ff = ffmpegBinary();
  if (req.video) {
    const out = join(req.outDir, `${req.id}.jpg`);
    const at = (req.frameMs ?? (req.startMs + req.endMs) / 2) / 1000;
    try {
      await run(ff, ["-y", "-loglevel", "error", "-ss", at.toFixed(3), "-i", req.media, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", out]);
      if (existsSync(out)) result.screenshotPath = out;
    } catch (e) { result.errors.push(`frame: ${(e as Error).message.slice(0, 200)}`); }
  }
  const mp3 = join(req.outDir, `${req.id}.mp3`);
  try {
    await run(ff, ["-y", "-loglevel", "error", "-ss", from.toFixed(3), "-t", length.toFixed(3), "-i", req.media, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4", mp3]);
    if (existsSync(mp3)) result.audioClipPath = mp3;
  } catch {
    const m4a = join(req.outDir, `${req.id}.m4a`);
    try {
      await run(ff, ["-y", "-loglevel", "error", "-ss", from.toFixed(3), "-t", length.toFixed(3), "-i", req.media, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "96k", m4a]);
      if (existsSync(m4a)) result.audioClipPath = m4a;
    } catch (e) { result.errors.push(`audio: ${(e as Error).message.slice(0, 200)}`); }
  }
  return result;
}

/** Native file dialog. macOS uses AppleScript; Linux uses zenity when present. Returns null when cancelled or unsupported. */
export async function pickFileNatively(prompt: string): Promise<string | null> {
  try {
    if (platform() === "darwin") {
      const out = await run("osascript", ["-e", `POSIX path of (choose file with prompt "${prompt.replace(/"/g, "")}")`], 600_000);
      return out.trim() || null;
    }
    if (platform() === "linux") return (await run("zenity", ["--file-selection", `--title=${prompt}`], 600_000)).trim() || null;
  } catch { return null; }
  return null;
}
export const canPickNatively = () => platform() === "darwin" || (platform() === "linux" && Boolean(process.env.DISPLAY));

const MEDIA_TYPES: Record<string, string> = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".jpg": "image/jpeg"};
export const mediaKind = (path: string): "video" | "audio" => (MEDIA_TYPES[extname(path).toLowerCase()] ?? "video/").startsWith("audio") ? "audio" : "video";
export const isMediaFile = (path: string) => extname(path).toLowerCase() in MEDIA_TYPES;

/** Find subtitles next to a media file: same name with .srt/.vtt, including language suffixes like movie.es.srt. */
export function findSiblingSubtitles(media: string): string | undefined {
  const {dir, name} = parse(media);
  for (const ext of [".srt", ".vtt"]) { const p = join(dir, name + ext); if (existsSync(p)) return p; }
  try {
    return readdirSync(dir).filter((f) => f.startsWith(name + ".") && /\.(srt|vtt)$/i.test(f)).map((f) => join(dir, f))[0];
  } catch { return undefined; }
}

/** Stream a local file with HTTP Range support so the player can seek. */
export function streamFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  const size = statSync(path).size;
  const type = MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, {"content-range": `bytes */${size}`}); res.end(); return; }
    res.writeHead(206, {"content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes"});
    createReadStream(path, {start, end}).pipe(res);
  } else {
    res.writeHead(200, {"content-type": type, "content-length": size, "accept-ranges": "bytes"});
    createReadStream(path).pipe(res);
  }
}
