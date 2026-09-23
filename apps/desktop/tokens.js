// Split a subtitle line into clickable pieces. Intl.Segmenter handles spaced and unspaced scripts.
export function tokenize(text, locale) {
  const segmenter = new Intl.Segmenter(locale || undefined, {granularity: "word"});
  return [...segmenter.segment(text)].map((s) => ({text: s.segment, word: Boolean(s.isWordLike), start: s.index}));
}
// Join the original text between two word tokens (inclusive) so phrases keep their spacing.
export function phrase(tokens, from, to) {
  const [a, b] = from <= to ? [from, to] : [to, from];
  return tokens.slice(a, b + 1).map((t) => t.text).join("").trim();
}
