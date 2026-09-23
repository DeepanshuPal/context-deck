/** Online players Context Deck's extension reads captions from. Only the caption text the site already shows is read. */
export type StreamSite = "youtube" | "netflix";

export interface StreamRef {site: StreamSite; id: string; locator: string}

/** Canonical, time-free locator for a streaming video, or undefined when the URL is not a supported player page. */
export function parseStreamUrl(raw: string): StreamRef | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtube.com" && url.pathname === "/watch") {
    const id = url.searchParams.get("v") ?? "";
    if (/^[\w-]{6,20}$/.test(id)) return {site: "youtube", id, locator: `https://www.youtube.com/watch?v=${id}`};
  }
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    if (/^[\w-]{6,20}$/.test(id)) return {site: "youtube", id, locator: `https://www.youtube.com/watch?v=${id}`};
  }
  if (host === "netflix.com") {
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/(\d{3,12})\/?$/i.exec(url.pathname);
    if (m) return {site: "netflix", id: m[1], locator: `https://www.netflix.com/watch/${m[1]}`};
  }
  return undefined;
}

/** Link that reopens the video at a moment (whole seconds, a little before the line starts). */
export function streamLink(locator: string, startMs: number): string | undefined {
  const ref = parseStreamUrl(locator);
  if (!ref) return undefined;
  const t = Math.max(0, Math.floor((startMs - 1000) / 1000));
  return ref.site === "youtube" ? `${ref.locator}&t=${t}s` : `${ref.locator}?t=${t}`;
}
