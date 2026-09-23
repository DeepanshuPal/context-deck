import type {AnkiCard} from "./types.js";

const quote = (value: string | number | undefined) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export const cardToTsv = (card: AnkiCard): string => [
  card.term,
  card.definition,
  card.sentence,
  card.sourceTitle,
  card.deepLink,
  card.screenshotPath ?? "",
  card.audioClipPath ?? ""
].map(quote).join("\t");

export const ankiHeader = "#separator:Tab\n#html:false\n#columns:Term\tDefinition\tSentence\tSource\tContextLink\tScreenshot\tAudio";
export const cardsToAnkiFile = (cards: AnkiCard[]) => `${ankiHeader}\n${cards.map(cardToTsv).join("\n")}\n`;

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]!));
const base = (p: string) => p.split(/[\\/]/).pop()!;

/** Add one note through a locally running AnkiConnect. Frame and audio are copied into Anki's media folder by Anki itself. */
export async function pushToAnkiConnect(card: AnkiCard, deckName = "Context Deck", endpoint = "http://127.0.0.1:8765"): Promise<number> {
  const call = async (action: string, params: unknown) => {
    const response = await fetch(endpoint, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({action, version: 6, params})});
    if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}`);
    const body = await response.json() as {result: unknown; error: string | null};
    if (body.error) throw new Error(body.error);
    return body.result;
  };
  await call("createDeck", {deck: deckName});
  const note: Record<string, unknown> = {deckName, modelName: "Basic", fields: {
    Front: `${esc(card.term)}<br><small>${esc(card.sentence)}</small>`,
    Back: `${esc(card.definition)}<br><small>${esc(card.sourceTitle)}</small><br><a href="${esc(card.deepLink)}">Open original context</a>`
  }, options: {allowDuplicate: false}, tags: ["context-deck"]};
  if (card.screenshotPath) note.picture = [{path: card.screenshotPath, filename: `context-deck-${base(card.screenshotPath)}`, fields: ["Back"]}];
  if (card.audioClipPath) note.audio = [{path: card.audioClipPath, filename: `context-deck-${base(card.audioClipPath)}`, fields: ["Front"]}];
  const result = await call("addNote", {note});
  if (typeof result !== "number") throw new Error("AnkiConnect rejected note");
  return result;
}

/** Which of these note ids still exist in Anki. AnkiConnect returns an empty object for notes that were deleted. */
export async function ankiNotesThatExist(noteIds: number[], endpoint = "http://127.0.0.1:8765"): Promise<Set<number>> {
  if (!noteIds.length) return new Set();
  const response = await fetch(endpoint, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({action: "notesInfo", version: 6, params: {notes: noteIds}})});
  if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}`);
  const body = await response.json() as {result: ({noteId?: number} | null)[] | null; error: string | null};
  if (body.error || !Array.isArray(body.result)) throw new Error(body.error ?? "AnkiConnect notesInfo failed");
  return new Set(body.result.map((n) => n?.noteId).filter((id): id is number => typeof id === "number"));
}
