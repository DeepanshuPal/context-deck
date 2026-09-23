import {createReadStream, createWriteStream, existsSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {Unzip, UnzipInflate, strFromU8} from "fflate";
import {parseTermBank, type DictionaryIndex, type EncounterStore} from "@context-deck/core";

/** Free Wiktionary-derived packs (source language -> English), built by wiktionary-to-yomitan from kaikki.org data. */
export const CATALOG: {code: string; name: string}[] = [
  ["ar", "Arabic"], ["zh", "Chinese"], ["nl", "Dutch"], ["fr", "French"], ["de", "German"], ["el", "Greek"], ["hi", "Hindi"],
  ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["la", "Latin"], ["pl", "Polish"], ["pt", "Portuguese"], ["ru", "Russian"],
  ["es", "Spanish"], ["sv", "Swedish"], ["tr", "Turkish"]
].map(([code, name]) => ({code, name}));
export const catalogUrl = (code: string) => `https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/${code}/en/wty-${code}-en.zip`;

export interface DictionaryJob {state: "idle" | "downloading" | "importing" | "done" | "error"; label: string; bytes: number; total: number; entries: number; files: number; error?: string; title?: string}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Stream a Yomitan dictionary zip into the database one term bank at a time. */
export async function importDictionaryZip(store: EncounterStore, zipPath: string, job: DictionaryJob): Promise<string> {
  job.state = "importing";
  let index: DictionaryIndex | undefined; let dictId: number | undefined; let failure: Error | undefined;
  const pending: Promise<void>[] = [];
  const ensure = () => dictId ??= store.beginDictionary(index ?? {title: basename(zipPath).replace(/\.zip$/i, "")});
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const name = file.name.split("/").pop() ?? "";
    const wanted = name === "index.json" || /^term_bank_\d+\.json$/.test(name);
    if (!wanted) return;
    const chunks: Uint8Array[] = [];
    pending.push(new Promise<void>((done) => {
      file.ondata = (error, data, final) => {
        if (error) { failure = error; done(); return; }
        chunks.push(data);
        if (!final) return;
        try {
          const json = JSON.parse(strFromU8(concat(chunks)));
          if (name === "index.json") {
            if (!json.title) throw new Error("index.json has no title");
            index = json;
          } else {
            const {terms, forms} = parseTermBank(json);
            store.addDictionaryRows(ensure(), terms, forms);
            job.entries += terms.length; job.files++;
          }
        } catch (e) { failure = e as Error; }
        done();
      };
      file.start();
    }));
  };
  try {
    for await (const chunk of createReadStream(zipPath, {highWaterMark: 1 << 20})) {
      unzip.push(chunk as Uint8Array);
      job.bytes += (chunk as Uint8Array).length;
    }
    unzip.push(new Uint8Array(0), true);
    await Promise.all(pending);
  } catch (e) { failure ??= e as Error; }
  if (failure || !job.files) {
    if (dictId !== undefined) store.removeDictionary(dictId); // never leave a half-imported dictionary behind
    throw failure ?? new Error("No term banks found. Is this a Yomitan-format dictionary zip?");
  }
  return index?.title ?? basename(zipPath);
}

export async function downloadFile(url: string, job: DictionaryJob, fetcher: typeof fetch = fetch): Promise<string> {
  job.state = "downloading";
  const response = await fetcher(url, {redirect: "follow"});
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  job.total = Number(response.headers.get("content-length")) || 0;
  const target = join(tmpdir(), `context-deck-dict-${Date.now()}.zip`);
  const counter = new TransformStream<Uint8Array, Uint8Array>({transform(chunk, ctl) { job.bytes += chunk.length; ctl.enqueue(chunk); }});
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counter) as never), createWriteStream(target));
  return target;
}

/** Run a download-and/or-import in the background, updating `job` as it goes. */
export async function runDictionaryJob(store: EncounterStore, job: DictionaryJob, source: {url?: string; path?: string; removeAfter?: boolean}, fetcher?: typeof fetch): Promise<void> {
  let temp: string | undefined = source.removeAfter ? source.path : undefined;
  try {
    const zip = source.path ?? (temp = await downloadFile(source.url!, job, fetcher));
    job.bytes = 0; job.total = 0;
    const {statSync} = await import("node:fs"); job.total = statSync(zip).size;
    job.title = await importDictionaryZip(store, zip, job);
    job.state = "done";
  } catch (e) {
    job.state = "error"; job.error = (e as Error).message.slice(0, 300);
  } finally {
    if (temp && existsSync(temp)) rmSync(temp, {force: true});
  }
}
