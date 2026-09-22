import {mkdirSync, writeFileSync} from "node:fs";
import {EncounterStore} from "./store.js";
import {parseSubtitles} from "./subtitles.js";
import {cardsToAnkiFile} from "./anki.js";

const subtitles = parseSubtitles(`1\n00:00:02,000 --> 00:00:05,000\nNo sabía que estabas aquí.\n\n2\n00:00:05,100 --> 00:00:08,000\nTe estaba buscando.`);
const store = new EncounterStore();
const source = {kind: "video" as const, title: "Demo scene", locator: "/media/demo.mp4", language: "es", durationMs: 8000};
const first = store.capture({source, cue: subtitles[0], selectedText: "sabía", definition: "I knew"});
store.capture({source, cue: subtitles[1], selectedText: "buscando", definition: "looking for"});
store.setState("sabía", "learning");
const card = store.card(first.id);
store.markExported(first.id, "demo-note-1");
store.markCardDeleted(first.id);
mkdirSync("output", {recursive: true});
writeFileSync("output/context-deck.txt", cardsToAnkiFile([card]));
writeFileSync("output/terms.json", JSON.stringify(store.listTerms(), null, 2));
console.log(`Captured ${store.listTerms().length} terms. Deep link: ${card.deepLink}`);
store.close();
