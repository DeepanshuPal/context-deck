import {build} from "esbuild";
import {cpSync, mkdirSync, rmSync} from "node:fs";
rmSync("dist", {recursive: true, force: true}); rmSync("ui", {recursive: true, force: true}); rmSync("extension", {recursive: true, force: true});
await build({entryPoints: ["src/main.mjs"], bundle: true, platform: "node", format: "esm", target: "node20", outfile: "dist/main.mjs",
  external: ["electron", "better-sqlite3"],
  banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);"}});
mkdirSync("ui");
for (const f of ["index.html", "style.css", "app.js", "tokens.js"]) cpSync(`../desktop/${f}`, `ui/${f}`);
cpSync("../extension", "extension", {recursive: true});
console.log("bundled dist/main.mjs, ui/ and extension/");
