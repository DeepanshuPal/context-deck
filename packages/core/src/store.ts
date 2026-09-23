import Database from "better-sqlite3";
import {createHash, randomUUID} from "node:crypto";
import type {AnkiCard, CaptureInput, Encounter, EncounterView, LearningState, Source, TermSummary} from "./types.js";
import type {BrowserCapture} from "./browser-capture.js";
import {streamLink} from "./stream.js";
import {dictKey, type DictionaryIndex, type LookupResult, type LookupSense, type ParsedForm, type ParsedTerm} from "./dictionary.js";

const now = () => new Date().toISOString();
const normalize = (value: string) => value.trim().toLocaleLowerCase().normalize("NFKC");
const sourceId = (kind: string, locator: string) => createHash("sha256").update(`${kind}\0${locator}`).digest("hex").slice(0, 24);

export class EncounterStore {
  private db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    // The Mac app and `npm start` may share one database file; wait for the other writer instead of failing.
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, locator TEXT NOT NULL,
        language TEXT NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL,
        UNIQUE(kind, locator)
      );
      CREATE TABLE IF NOT EXISTS terms (
        id TEXT PRIMARY KEY, normalized TEXT NOT NULL UNIQUE, display TEXT NOT NULL,
        definition TEXT, state TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS encounters (
        id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES terms(id), source_id TEXT NOT NULL REFERENCES sources(id),
        cue_index INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        sentence TEXT NOT NULL, selected_text TEXT NOT NULL, screenshot_path TEXT, audio_clip_path TEXT,
        page_url TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        encounter_id TEXT PRIMARY KEY REFERENCES encounters(id), external_id TEXT,
        exported_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS imports (
        import_key TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(id), imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dictionaries (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, source_lang TEXT, target_lang TEXT, revision TEXT,
        attribution TEXT, url TEXT, entry_count INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dict_entries (
        dict_id INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE, term_key TEXT NOT NULL, term TEXT NOT NULL,
        pos TEXT, glosses TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dict_forms (
        dict_id INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE, form_key TEXT NOT NULL, lemma TEXT NOT NULL, note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dict_entries_key ON dict_entries(term_key);
      CREATE INDEX IF NOT EXISTS idx_dict_forms_key ON dict_forms(form_key);
      CREATE INDEX IF NOT EXISTS idx_encounters_term ON encounters(term_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_encounters_source_time ON encounters(source_id, start_ms);
    `);
  }

  capture(input: CaptureInput): Encounter {
    const createdAt = now();
    const sid = input.source.id ?? sourceId(input.source.kind, input.source.locator);
    const normalized = normalize(input.normalizedTerm ?? input.selectedText);
    if (!normalized) throw new Error("A capture needs a selected term");
    const termId = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
    const encounterId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO sources (id,kind,title,locator,language,duration_ms,created_at)
        VALUES (@id,@kind,@title,@locator,@language,@durationMs,@createdAt)
        ON CONFLICT(kind,locator) DO UPDATE SET title=excluded.title, language=excluded.language, duration_ms=COALESCE(excluded.duration_ms,sources.duration_ms)`)
        .run({...input.source, durationMs: input.source.durationMs ?? null, id: sid, createdAt});
      this.db.prepare(`INSERT INTO terms (id,normalized,display,definition,state,created_at,updated_at)
        VALUES (@id,@normalized,@display,@definition,'new',@createdAt,@createdAt)
        ON CONFLICT(normalized) DO UPDATE SET definition=COALESCE(excluded.definition,terms.definition), updated_at=excluded.updated_at`)
        .run({id: termId, normalized, display: input.selectedText.trim(), definition: input.definition ?? null, createdAt});
      this.db.prepare(`INSERT INTO encounters (id,term_id,source_id,cue_index,start_ms,end_ms,sentence,selected_text,screenshot_path,audio_clip_path,page_url,created_at)
        VALUES (@id,@termId,@sourceId,@cueIndex,@startMs,@endMs,@sentence,@selectedText,@screenshotPath,@audioClipPath,@pageUrl,@createdAt)`)
        .run({id: encounterId, termId, sourceId: sid, cueIndex: input.cue.index, startMs: input.cue.startMs,
          endMs: input.cue.endMs, sentence: input.cue.text, selectedText: input.selectedText.trim(),
          screenshotPath: input.screenshotPath ?? null, audioClipPath: input.audioClipPath ?? null,
          pageUrl: input.pageUrl ?? null, createdAt});
    });
    tx();
    return this.getEncounter(encounterId)!;
  }

  getEncounter(id: string): Encounter | undefined {
    const row = this.db.prepare(`SELECT id, term_id termId, source_id sourceId, cue_index cueIndex,
      start_ms startMs, end_ms endMs, sentence, selected_text selectedText, screenshot_path screenshotPath,
      audio_clip_path audioClipPath, page_url pageUrl, created_at createdAt FROM encounters WHERE id=?`).get(id);
    return row as Encounter | undefined;
  }

  setState(normalizedTerm: string, state: LearningState): void {
    const result = this.db.prepare("UPDATE terms SET state=?,updated_at=? WHERE normalized=?").run(state, now(), normalize(normalizedTerm));
    if (!result.changes) throw new Error(`Unknown term: ${normalizedTerm}`);
  }

  listTerms(): TermSummary[] {
    return this.db.prepare(`SELECT t.id,t.normalized,t.display,t.definition,t.state,
      COUNT(e.id) encounterCount,MAX(e.created_at) lastSeenAt
      FROM terms t JOIN encounters e ON e.term_id=t.id GROUP BY t.id ORDER BY lastSeenAt DESC`).all() as TermSummary[];
  }

  encountersForTerm(normalizedTerm: string): Encounter[] {
    return this.db.prepare(`SELECT e.id,e.term_id termId,e.source_id sourceId,e.cue_index cueIndex,
      e.start_ms startMs,e.end_ms endMs,e.sentence,e.selected_text selectedText,
      e.screenshot_path screenshotPath,e.audio_clip_path audioClipPath,e.page_url pageUrl,e.created_at createdAt
      FROM encounters e JOIN terms t ON t.id=e.term_id WHERE t.normalized=? ORDER BY e.created_at DESC`)
      .all(normalize(normalizedTerm)) as Encounter[];
  }

  card(encounterId: string): AnkiCard {
    const row = this.db.prepare(`SELECT e.id encounterId,t.display term,COALESCE(t.definition,'') definition,
      e.sentence,s.title sourceTitle,e.start_ms startMs,e.screenshot_path screenshotPath,e.audio_clip_path audioClipPath,
      e.source_id sourceId,s.kind sourceKind,s.locator sourceLocator FROM encounters e JOIN terms t ON t.id=e.term_id JOIN sources s ON s.id=e.source_id WHERE e.id=?`).get(encounterId) as (AnkiCard & {sourceId:string; sourceKind:string; sourceLocator:string}) | undefined;
    if (!row) throw new Error(`Unknown encounter: ${encounterId}`);
    const deepLink = (row.sourceKind === "stream" ? streamLink(row.sourceLocator, row.startMs) : undefined)
      ?? `contextdeck://source/${encodeURIComponent(row.sourceId)}?t=${row.startMs}&encounter=${encodeURIComponent(row.encounterId)}`;
    const {sourceId: _, sourceKind: _k, sourceLocator: _l, ...card} = {...row, deepLink};
    return card;
  }

  markExported(encounterId: string, externalId?: string): void {
    this.db.prepare(`INSERT INTO cards(encounter_id,external_id,exported_at,deleted_at) VALUES(?,?,?,NULL)
      ON CONFLICT(encounter_id) DO UPDATE SET external_id=excluded.external_id,exported_at=excluded.exported_at,deleted_at=NULL`)
      .run(encounterId, externalId ?? null, now());
  }

  markCardDeleted(encounterId: string): void {
    this.db.prepare("UPDATE cards SET deleted_at=? WHERE encounter_id=?").run(now(), encounterId);
  }

  /** Import one browser-extension capture. Idempotent: the same capture never creates a second encounter. */
  importBrowserCapture(capture: BrowserCapture): {encounter: Encounter; created: boolean} {
    const key = createHash("sha256").update(`${capture.source.locator}\0${capture.selectedText}\0${capture.capturedAt}`).digest("hex");
    const existing = this.db.prepare("SELECT encounter_id id FROM imports WHERE import_key=?").get(key) as {id: string} | undefined;
    if (existing) return {encounter: this.getEncounter(existing.id)!, created: false};
    const encounter = this.capture({
      source: {kind: "web", title: capture.source.title, locator: capture.source.locator, language: capture.source.language},
      cue: {index: 0, startMs: 0, endMs: 0, text: capture.sentence},
      selectedText: capture.selectedText,
      pageUrl: capture.source.locator
    });
    this.db.prepare("INSERT INTO imports(import_key,encounter_id,imported_at) VALUES(?,?,?)").run(key, encounter.id, now());
    return {encounter, created: true};
  }

  /** Newest-first encounter list joined with term and source, for the desktop UI. */
  recentEncounters(limit = 200): EncounterView[] {
    return (this.db.prepare(`SELECT e.id,t.display term,COALESCE(t.definition,'') definition,t.state,e.sentence,
      s.title sourceTitle,s.kind sourceKind,s.id sourceId,s.locator sourceLocator,e.start_ms startMs,e.end_ms endMs,e.page_url pageUrl,e.screenshot_path screenshotPath,e.audio_clip_path audioClipPath,e.created_at createdAt,
      CASE WHEN c.encounter_id IS NULL THEN 'new' WHEN c.deleted_at IS NOT NULL THEN 'deleted' WHEN c.external_id IS NULL THEN 'exported' ELSE 'in-anki' END cardStatus
      FROM encounters e JOIN terms t ON t.id=e.term_id JOIN sources s ON s.id=e.source_id LEFT JOIN cards c ON c.encounter_id=e.id
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(limit) as EncounterView[])
      .map((v) => v.sourceKind === "stream" ? {...v, openUrl: streamLink(v.sourceLocator, v.startMs)} : v);
  }

  /** Attach extracted frame/audio files to an encounter. Only fills paths; never removes history. */
  attachMedia(encounterId: string, media: {screenshotPath?: string; audioClipPath?: string}): void {
    this.db.prepare(`UPDATE encounters SET screenshot_path=COALESCE(?,screenshot_path), audio_clip_path=COALESCE(?,audio_clip_path) WHERE id=?`)
      .run(media.screenshotPath ?? null, media.audioClipPath ?? null, encounterId);
  }

  /** Notes this deck believes are live in Anki. */
  liveAnkiNotes(): {encounterId: string; noteId: number}[] {
    return (this.db.prepare(`SELECT encounter_id encounterId, external_id noteId FROM cards WHERE external_id IS NOT NULL AND deleted_at IS NULL`).all() as {encounterId: string; noteId: string}[])
      .map((r) => ({encounterId: r.encounterId, noteId: Number(r.noteId)})).filter((r) => Number.isFinite(r.noteId));
  }

  /** Encounters never sent to Anki, oldest first. Cards deleted in Anki are not re-sent automatically. */
  unexportedCards(): AnkiCard[] {
    const ids = this.db.prepare(`SELECT e.id FROM encounters e LEFT JOIN cards c ON c.encounter_id=e.id
      WHERE c.encounter_id IS NULL OR (c.external_id IS NULL AND c.deleted_at IS NULL) ORDER BY e.created_at, e.rowid`).all() as {id: string}[];
    return ids.map(({id}) => this.card(id));
  }

  source(id: string): Source | undefined {
    return this.db.prepare(`SELECT id,kind,title,locator,language,duration_ms durationMs,created_at createdAt FROM sources WHERE id=?`).get(id) as Source | undefined;
  }

  hasSourceLocator(locator: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sources WHERE locator=?").get(locator));
  }

  /** Start (or replace) a dictionary import; returns its id. */
  beginDictionary(index: DictionaryIndex): number {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM dict_entries WHERE dict_id IN (SELECT id FROM dictionaries WHERE title=?)").run(index.title);
      this.db.prepare("DELETE FROM dict_forms WHERE dict_id IN (SELECT id FROM dictionaries WHERE title=?)").run(index.title);
      this.db.prepare("DELETE FROM dictionaries WHERE title=?").run(index.title);
      return Number(this.db.prepare(`INSERT INTO dictionaries(title,source_lang,target_lang,revision,attribution,url,imported_at) VALUES(?,?,?,?,?,?,?)`)
        .run(index.title, index.sourceLanguage ?? null, index.targetLanguage ?? null, index.revision ?? null, index.attribution ?? null, index.url ?? null, now()).lastInsertRowid);
    });
    return tx();
  }

  addDictionaryRows(dictId: number, terms: ParsedTerm[], forms: ParsedForm[]): void {
    const addTerm = this.db.prepare("INSERT INTO dict_entries(dict_id,term_key,term,pos,glosses,score) VALUES(?,?,?,?,?,?)");
    const addForm = this.db.prepare("INSERT INTO dict_forms(dict_id,form_key,lemma,note) VALUES(?,?,?,?)");
    this.db.transaction(() => {
      for (const t of terms) addTerm.run(dictId, dictKey(t.term), t.term, t.pos, JSON.stringify(t.glosses), t.score);
      for (const f of forms) addForm.run(dictId, dictKey(f.form), f.lemma, f.note);
      this.db.prepare("UPDATE dictionaries SET entry_count=entry_count+? WHERE id=?").run(terms.length, dictId);
    })();
  }

  listDictionaries(): {id: number; title: string; sourceLang: string | null; targetLang: string | null; revision: string | null; attribution: string | null; entryCount: number; importedAt: string}[] {
    return this.db.prepare(`SELECT id,title,source_lang sourceLang,target_lang targetLang,revision,attribution,entry_count entryCount,imported_at importedAt FROM dictionaries ORDER BY title`).all() as never;
  }

  removeDictionary(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM dict_entries WHERE dict_id=?").run(id);
      this.db.prepare("DELETE FROM dict_forms WHERE dict_id=?").run(id);
      this.db.prepare("DELETE FROM dictionaries WHERE id=?").run(id);
    })();
  }

  /** Look a word up in every installed dictionary, following inflections (sabía -> saber) when the form itself has no entry. */
  lookup(query: string): LookupResult | null {
    const key = dictKey(query.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    if (!key) return null;
    const entries = (k: string) => this.db.prepare(`SELECT e.pos,e.glosses,d.title FROM dict_entries e JOIN dictionaries d ON d.id=e.dict_id
      WHERE e.term_key=? ORDER BY e.score DESC, e.rowid LIMIT 12`).all(k) as {pos: string; glosses: string; title: string}[];
    const toSenses = (rows: {pos: string; glosses: string; title: string}[]): LookupSense[] => rows.map((r) => ({pos: r.pos, glosses: JSON.parse(r.glosses), dictionary: r.title}));
    const exact = toSenses(entries(key)).filter((x) => x.pos !== "non-lemma");
    // A word can be both its own entry and an inflected form (sé: "yes" / form of saber, ser). Show both;
    // the form's lemma comes first unless the word's own entry is a major part of speech (como: "like" before comer).
    // Rare readings (archaic, voseo, imperative) rank after everyday ones: sé = "I know" (saber) before "be!" (ser).
    const rank = (note: string) => /archaic|obsolete|alt-of|dated|voseo|misspelling/i.test(note) ? 3 : /imperative/i.test(note) ? 2 : 0;
    const best = new Map<string, {lemma: string; note: string; r: number; i: number}>();
    (this.db.prepare("SELECT lemma,note FROM dict_forms WHERE form_key=? ORDER BY rowid LIMIT 40").all(key) as {lemma: string; note: string}[])
      .forEach((f, i) => { const r = rank(f.note ?? ""); const cur = best.get(f.lemma); if (!cur || r < cur.r) best.set(f.lemma, {...f, r, i: cur ? Math.min(cur.i, i) : i}); });
    const forms = [...best.values()].sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 3);
    const groups: {lemma: string; via?: string; senses: LookupSense[]}[] = [];
    for (const form of forms) {
      if (dictKey(form.lemma) === key) continue;
      const lemmaSenses = toSenses(entries(dictKey(form.lemma))).filter((x) => x.pos !== "non-lemma").map((x) => ({...x, lemma: form.lemma}));
      if (lemmaSenses.length) groups.push({lemma: form.lemma, via: form.note, senses: lemmaSenses});
    }
    const MAJOR = /^(n|noun|v|verb|adj|adv|pron|prep|conj|det|num|article|particle|phrase)$/i;
    // Proper nouns (Como, the city) go last: subtitle lines capitalise their first word, so capitals prove nothing.
    exact.sort((a, b) => Number(a.pos === "name") - Number(b.pos === "name"));
    const own = {lemma: query.trim(), via: undefined as string | undefined, senses: exact};
    if (exact.length && (!groups.length || exact.some((x) => MAJOR.test(x.pos)))) groups.unshift(own); else if (exact.length) groups.push(own);
    const primary = groups[0];
    const senses = groups.flatMap((g) => g.senses);
    const lemma = primary?.lemma ?? query.trim(); const via = primary?.via;
    if (!senses.length) return null;
    const first = [...new Set(primary.senses.flatMap((s) => s.glosses))].slice(0, 2).join("; ");
    return {query, lemma, via, senses, suggestion: lemma !== query.trim() ? `(${lemma}) ${first}` : first};
  }

  /** Cards for every encounter, oldest first, for a full Anki export. */
  allCards(): AnkiCard[] {
    const ids = this.db.prepare("SELECT id FROM encounters ORDER BY created_at, rowid").all() as {id: string}[];
    return ids.map(({id}) => this.card(id));
  }

  close(): void { this.db.close(); }
}
