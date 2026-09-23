import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, writeFileSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {zipSync, strToU8} from "fflate";
import {createApp} from "../dist/server.js";

const start = (opts) => new Promise((ok) => { const app = createApp(opts); app.server.listen(0, "127.0.0.1", () => ok({...app, base: `http://127.0.0.1:${app.server.address().port}`})); });
const stop = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });
const sc = (glosses) => ({type: "structured-content", content: [{tag: "div", data: {content: "preamble"}, content: "Etymology: Latin"},
  {tag: "ol", data: {content: "glosses"}, content: glosses.map((g) => ({tag: "li", content: [{tag: "div", content: [{tag: "div", data: {content: "tags"}, content: [{tag: "span", data: {content: "tag"}, content: "vt"}]}, g,
    {tag: "details", data: {content: "details-entry-examples"}, content: [{tag: "summary", content: "1 example"}, "Sé que volverá."]}]}]}))}]});
// A tiny dictionary in the same Yomitan format 3 layout as the wty packs.
const zipBytes = () => zipSync({
  "index.json": strToU8(JSON.stringify({title: "test-es-en", format: 3, revision: "1", sourceLanguage: "es", targetLanguage: "en", attribution: "https://kaikki.org/"})),
  "term_bank_1.json": strToU8(JSON.stringify([
    ["saber", "", "v", "v", 10, [sc(["to know", "to know how to"])], 1, ""],
    ["sabía", "", "non-lemma", "v", 0, [["saber", ["first/third-person singular imperfect indicative"]]], 2, ""],
    ["gratis", "", "adj", "", 0, ["free, without charge"], 3, ""]
  ]))
});

test("imports a Yomitan zip, strips tags and examples, and follows inflections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-dict-"));
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir});
  const up = await fetch(`${app.base}/api/dictionaries/upload?name=test.zip`, {method: "POST", body: zipBytes()});
  assert.equal(up.status, 202);
  let d; for (let i = 0; i < 50; i++) { d = await (await fetch(`${app.base}/api/dictionaries`)).json(); if (d.job.state === "done" || d.job.state === "error") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(d.job.state, "done", d.job.error); assert.equal(d.installed[0].title, "test-es-en"); assert.equal(d.installed[0].entryCount, 2);
  const r = await (await fetch(`${app.base}/api/lookup?term=${encodeURIComponent("Sabía,")}`)).json();
  assert.equal(r.lemma, "saber"); assert.match(r.via, /imperfect/);
  assert.equal(r.suggestion, "(saber) to know; to know how to");
  assert.deepEqual((await (await fetch(`${app.base}/api/lookup?term=gratis`)).json()).senses[0].glosses, ["free, without charge"]);
  assert.equal(await (await fetch(`${app.base}/api/lookup?term=nada`)).json(), null);
  // Re-importing the same dictionary replaces it instead of doubling entries.
  await fetch(`${app.base}/api/dictionaries/upload?name=test.zip`, {method: "POST", body: zipBytes()});
  for (let i = 0; i < 50; i++) { d = await (await fetch(`${app.base}/api/dictionaries`)).json(); if (d.job.state === "done") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(d.installed.length, 1); assert.equal(d.installed[0].entryCount, 2);
  assert.equal((await fetch(`${app.base}/api/dictionaries/${d.installed[0].id}`, {method: "DELETE"})).status, 200);
  assert.equal(await (await fetch(`${app.base}/api/lookup?term=saber`)).json(), null);
  await stop(app.server);
});

test("catalog download goes through the fetcher and reports bad archives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-dict-"));
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return new Response(url.includes("/es/") ? zipBytes() : strToU8("not a zip"), {headers: {"content-length": "0"}}); };
  const app = await start({dbPath: join(dir, "deck.db"), captureDir: dir, fetcher});
  const wait = async () => { let d; for (let i = 0; i < 50; i++) { d = await (await fetch(`${app.base}/api/dictionaries`)).json(); if (!["downloading", "importing"].includes(d.job.state)) return d; await new Promise((r) => setTimeout(r, 50)); } return d; };
  await fetch(`${app.base}/api/dictionaries/download`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "es"})});
  let d = await wait(); assert.equal(d.job.state, "done", d.job.error);
  assert.match(calls[0], /huggingface\.co\/datasets\/daxida\/wty-release\/resolve\/main\/latest\/dict\/es\/en\/wty-es-en\.zip$/);
  await fetch(`${app.base}/api/dictionaries/download`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "fr"})});
  d = await wait(); assert.equal(d.job.state, "error"); assert.equal(d.installed.length, 1, "a failed import doesn't touch installed dictionaries");
  assert.equal((await fetch(`${app.base}/api/dictionaries/download`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "xx"})})).status, 400);
  await stop(app.server);
});
