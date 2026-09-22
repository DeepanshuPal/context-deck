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

export async function pushToAnkiConnect(card: AnkiCard, deckName = "Context Deck", endpoint = "http://127.0.0.1:8765"): Promise<number> {
  const response = await fetch(endpoint, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({
    action: "addNote", version: 6, params: {note: {deckName, modelName: "Basic", fields: {
      Front: `${card.term}<br><small>${card.sentence}</small>`,
      Back: `${card.definition}<br><a href="${card.deepLink}">Open original context</a>`
    }, options: {allowDuplicate: false}, tags: ["context-deck"]}}
  })});
  if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}`);
  const body = await response.json() as {result: number | null; error: string | null};
  if (body.error || body.result === null) throw new Error(body.error ?? "AnkiConnect rejected note");
  return body.result;
}
