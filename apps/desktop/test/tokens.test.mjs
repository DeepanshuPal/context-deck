import assert from "node:assert/strict";
import test from "node:test";
import {tokenize, phrase} from "../tokens.js";
test("tokenizes spaced text and joins phrases with original spacing", () => {
  const t = tokenize("No sabía que estabas aquí.", "es");
  const words = t.filter((x) => x.word).map((x) => x.text);
  assert.deepEqual(words, ["No", "sabía", "que", "estabas", "aquí"]);
  const i = t.findIndex((x) => x.text === "sabía"), j = t.findIndex((x) => x.text === "estabas");
  assert.equal(phrase(t, j, i), "sabía que estabas");
});
test("segments unspaced Japanese into several words", () => {
  const words = tokenize("今日は雨が降っています", "ja").filter((x) => x.word);
  assert.ok(words.length >= 3);
});
