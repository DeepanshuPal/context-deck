export type LearningState = "new" | "learning" | "known";
export type SourceKind = "video" | "audio" | "web";

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  locator: string;
  language: string;
  durationMs?: number;
  createdAt: string;
}

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptureInput {
  source: Omit<Source, "id" | "createdAt"> & { id?: string };
  cue: SubtitleCue;
  selectedText: string;
  normalizedTerm?: string;
  definition?: string;
  screenshotPath?: string;
  audioClipPath?: string;
  pageUrl?: string;
}

export interface Encounter {
  id: string;
  termId: string;
  sourceId: string;
  cueIndex: number;
  startMs: number;
  endMs: number;
  sentence: string;
  selectedText: string;
  screenshotPath?: string;
  audioClipPath?: string;
  pageUrl?: string;
  createdAt: string;
}

export interface TermSummary {
  id: string;
  normalized: string;
  display: string;
  definition?: string;
  state: LearningState;
  encounterCount: number;
  lastSeenAt: string;
}

export interface AnkiCard {
  encounterId: string;
  term: string;
  definition: string;
  sentence: string;
  sourceTitle: string;
  startMs: number;
  deepLink: string;
  screenshotPath?: string;
  audioClipPath?: string;
}

export interface EncounterView {
  id: string;
  term: string;
  definition: string;
  state: LearningState;
  sentence: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  sourceId: string;
  startMs: number;
  endMs: number;
  pageUrl?: string;
  screenshotPath?: string;
  audioClipPath?: string;
  createdAt: string;
  /** new = never sent; exported = in a downloaded file; in-anki = sent via AnkiConnect; deleted = removed in Anki (history kept). */
  cardStatus: "new" | "exported" | "in-anki" | "deleted";
}
