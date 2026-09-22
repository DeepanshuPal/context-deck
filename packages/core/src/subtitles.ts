import type { SubtitleCue } from "./types.js";

const timeToMs = (raw: string): number => {
  const value = raw.trim().replace(",", ".");
  const bits = value.split(":").map(Number);
  if (bits.some(Number.isNaN)) throw new Error(`Invalid subtitle time: ${raw}`);
  const [hours, minutes, seconds] = bits.length === 3 ? bits : [0, bits[0], bits[1]];
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
};

export function parseSubtitles(input: string): SubtitleCue[] {
  const normalized = input.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines[0]?.startsWith("WEBVTT")) continue;
    const timingAt = lines.findIndex((line) => line.includes("-->"));
    if (timingAt < 0) continue;
    const [start, end] = lines[timingAt].split("-->").map((part) => part.trim().split(" ")[0]);
    const text = lines.slice(timingAt + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    cues.push({index: cues.length, startMs: timeToMs(start), endMs: timeToMs(end), text});
  }
  return cues;
}

export function cueAt(cues: SubtitleCue[], timeMs: number): SubtitleCue | undefined {
  return cues.find((cue) => cue.startMs <= timeMs && timeMs <= cue.endMs);
}
