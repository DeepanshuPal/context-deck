import Database from "better-sqlite3";
import {createHash, randomUUID} from "node:crypto";
import type {AnkiCard, CaptureInput, Encounter, EncounterView, LearningState, Source, TermSummary} from "./types.js";
import type {BrowserCapture} from "./browser-capture.js";

const now = () => new Date().toISOString();
const normalize = (value: string) => value.trim().toLocaleLowerCase().normalize("NFKC");
const sourceId = (kind: string, locator: string) => createHash("sha256").update(`${kind}\0${locator}`).digest("hex").slice(0, 24);

export class EncounterStore {
  private db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
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
      e.source_id sourceId FROM encounters e JOIN terms t ON t.id=e.term_id JOIN sources s ON s.id=e.source_id WHERE e.id=?`).get(encounterId) as (AnkiCard & {sourceId:string}) | undefined;
    if (!row) throw new Error(`Unknown encounter: ${encounterId}`);
    const deepLink = `contextdeck://source/${encodeURIComponent(row.sourceId)}?t=${row.startMs}&encounter=${encodeURIComponent(row.encounterId)}`;
    const {sourceId: _, ...card} = {...row, deepLink};
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
    return this.db.prepare(`SELECT e.id,t.display term,COALESCE(t.definition,'') definition,t.state,e.sentence,
      s.title sourceTitle,s.kind sourceKind,e.start_ms startMs,e.page_url pageUrl,e.created_at createdAt
      FROM encounters e JOIN terms t ON t.id=e.term_id JOIN sources s ON s.id=e.source_id
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(limit) as EncounterView[];
  }

  /** Cards for every encounter, oldest first, for a full Anki export. */
  allCards(): AnkiCard[] {
    const ids = this.db.prepare("SELECT id FROM encounters ORDER BY created_at, rowid").all() as {id: string}[];
    return ids.map(({id}) => this.card(id));
  }

  close(): void { this.db.close(); }
}
