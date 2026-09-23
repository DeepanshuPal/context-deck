/**
 * Offline dictionaries in the Yomitan format (format 3). Wiktionary-derived packs from
 * wiktionary-to-yomitan (wty) use it, and so do JMdict and many community dictionaries.
 * We keep only what's needed for lookup: headword, part of speech, plain-text glosses and inflection links.
 */
export interface DictionaryIndex {title: string; format?: number; revision?: string; sourceLanguage?: string; targetLanguage?: string; attribution?: string; url?: string}
export interface ParsedTerm {term: string; reading: string; pos: string; glosses: string[]; score: number}
export interface ParsedForm {form: string; lemma: string; note: string}

type Node = string | number | null | undefined | Node[] | {tag?: string; type?: string; content?: Node; data?: Record<string, string>};

const textOf = (node: Node, skipNested = false): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, skipNested)).join("");
  if (skipNested && (node.tag === "ol" || node.tag === "ul" || node.tag === "details")) return "";
  if (node.data && ["tags", "tag", "backlink", "preamble"].includes(node.data.content)) return "";
  if (node.tag === "br") return " ";
  return textOf(node.content, skipNested);
};

function findGlossLists(node: Node, out: Node[][]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) findGlossLists(n, out); return; }
  if (node.data?.content === "glosses") { out.push(Array.isArray(node.content) ? node.content : [node.content]); return; }
  findGlossLists(node.content, out);
}

/** Plain-text senses from one glossary item (string or structured content). */
export function glossesFromItem(item: unknown): string[] {
  if (typeof item === "string") return item.trim() ? [item.trim()] : [];
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const obj = item as {type?: string; text?: string; content?: Node};
  if (obj.type === "text" && obj.text) return [obj.text.trim()];
  if (obj.type !== "structured-content") return [];
  const lists: Node[][] = [];
  findGlossLists(obj.content, lists);
  if (!lists.length) { const t = textOf(obj.content).replace(/\s+/g, " ").trim(); return t ? [t.slice(0, 500)] : []; }
  return lists.flat().map((li) => textOf(li, true).replace(/\s+/g, " ").trim()).filter(Boolean).map((t) => t.slice(0, 500));
}

/** Parse one term_bank_N.json array into dictionary entries and inflection links. */
export function parseTermBank(rows: unknown[]): {terms: ParsedTerm[]; forms: ParsedForm[]} {
  const terms: ParsedTerm[] = []; const forms: ParsedForm[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const [term, reading, defTags, rules, score, glossary] = row as [string, string, string, string, number, unknown[]];
    const glosses: string[] = [];
    for (const item of Array.isArray(glossary) ? glossary : []) {
      if (Array.isArray(item) && typeof item[0] === "string") {
        forms.push({form: term, lemma: item[0], note: Array.isArray(item[1]) ? item[1].join("; ") : ""});
      } else glosses.push(...glossesFromItem(item));
    }
    if (glosses.length) terms.push({term, reading: reading ?? "", pos: String(defTags || rules || "").split(" ")[0] ?? "", glosses, score: Number(score) || 0});
  }
  return {terms, forms};
}

export const dictKey = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase();

export interface LookupSense {pos: string; glosses: string[]; dictionary: string}
export interface LookupResult {query: string; lemma: string; via?: string; senses: LookupSense[]; suggestion: string}
