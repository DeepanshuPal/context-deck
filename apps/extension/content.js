// Context Deck in-page subtitles for YouTube and Netflix.
// Reads only the subtitle text the site is already showing. Never downloads or decrypts video.
// Frame and audio are captured only from unprotected (non-DRM) video, and only when you save a word.
(() => {
  if (window.__contextDeck) return;
  window.__contextDeck = true;

  const SITES = {
    youtube: {
      video: () => document.querySelector("#movie_player video.html5-main-video") ?? document.querySelector("#movie_player video"),
      player: () => document.querySelector("#movie_player"),
      lines: () => [...document.querySelectorAll(".ytp-caption-window-container .caption-visual-line")].map((l) => l.textContent).filter((t) => t.trim()),
      segments: () => [...document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment")].map((s) => s.textContent),
      title: () => (document.querySelector("#title h1, h1.ytd-watch-metadata")?.textContent ?? document.title.replace(/ - YouTube$/, "")).trim(),
      hideNative: ".ytp-caption-window-container{opacity:0!important}",
      ccHint: "Turn on subtitles (press C) to click words"
    },
    netflix: {
      video: () => document.querySelector(".watch-video video") ?? document.querySelector("video"),
      player: () => document.querySelector(".watch-video--player-view") ?? document.querySelector(".watch-video") ?? document.querySelector("video")?.parentElement,
      lines: () => [...document.querySelectorAll(".player-timedtext .player-timedtext-text-container")].map((c) => [...c.querySelectorAll("span")].filter((s) => !s.querySelector("span")).map((s) => s.textContent).join("")).filter((t) => t.trim()),
      segments: () => [],
      title: () => (document.querySelector('[data-uia="video-title"]')?.innerText.replace(/\s*\n\s*/g, " · ") ?? document.title.replace(/ ?[-|] ?Netflix$/, "")).trim() || "Netflix",
      hideNative: ".player-timedtext{opacity:0!important}",
      ccHint: "Turn on subtitles to click words"
    }
  };
  const site = location.hostname.endsWith("netflix.com") ? SITES.netflix : SITES.youtube;
  const isWatchPage = () => location.hostname.endsWith("netflix.com") ? /\/watch\/\d+/.test(location.pathname) : location.pathname === "/watch";

  const prefs = {pauseOnHover: true, saveAudio: true, enabled: true};
  chrome.storage.local.get("prefs").then((v) => Object.assign(prefs, v.prefs ?? {}));
  chrome.storage.onChanged.addListener((c) => { if (c.prefs) Object.assign(prefs, c.prefs.newValue ?? {}); });

  // ---------- caption timeline ----------
  let cue = null;            // {text, startMs, endMs?}
  let lastUrl = location.href;
  const history = [];        // recent cues with known end times
  const readCaption = () => {
    const lines = site.lines();
    const text = (lines.length ? lines.join("\n") : site.segments().join(" ")).replace(/[ \t\u00a0]+/g, " ").trim();
    return text;
  };

  // ---------- overlay (shadow DOM so site CSS can't touch it) ----------
  const host = document.createElement("div");
  host.id = "context-deck-host";
  host.style.cssText = "position:absolute;left:0;right:0;bottom:12%;z-index:2147483646;pointer-events:none;display:flex;justify-content:center";
  const root = host.attachShadow({mode: "open"});
  root.innerHTML = `<style>
    :host{all:initial}
    .bar{pointer-events:auto;max-width:86%;padding:.18em .5em;border-radius:6px;background:rgba(8,8,8,.78);color:#fff;
      font:500 clamp(16px,2.3vw,34px)/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;white-space:pre-wrap;text-shadow:0 1px 2px #000}
    .bar.hint{font-size:14px;opacity:.85;font-weight:400}
    .w{cursor:pointer;border-radius:4px;padding:0 .04em}
    .w:hover,.w.on{background:#f5d76e;color:#111;text-shadow:none}
    .w.saved{text-decoration:underline 2px #7ed59b;text-underline-offset:.18em}
    .pop{pointer-events:auto;position:absolute;bottom:calc(100% + 10px);width:min(380px,90vw);max-height:46vh;overflow:auto;background:#fbfbf8;color:#1d1d1b;
      border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);padding:12px 14px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}
    .pop h3{margin:0;font-size:20px;font-weight:700}
    .pop .lemma{color:#666;font-size:12px;margin:2px 0 6px}
    .pop ol{margin:4px 0 8px;padding-left:20px}
    .pop li{margin:2px 0}
    .pop .pos{color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    .pop textarea{width:100%;box-sizing:border-box;min-height:44px;font:13px/1.4 inherit;border:1px solid #d6d6cf;border-radius:6px;padding:6px;resize:vertical}
    .pop .row{display:flex;gap:8px;align-items:center;margin-top:8px}
    .pop button{font:600 13px system-ui,sans-serif;border-radius:6px;border:0;padding:7px 12px;cursor:pointer}
    .pop .save{background:#1d1d1b;color:#fff}
    .pop .ghost{background:#ecece6;color:#1d1d1b}
    .pop .status{font-size:12px;color:#3d6b45;flex:1}
    .pop .status.err{color:#a33}
    .pop kbd{font:11px ui-monospace,monospace;background:rgba(127,127,127,.25);color:inherit;border-radius:3px;padding:0 4px}
    .pop ol .lemma{margin:8px 0 2px -20px;font-style:italic}
    .fine{color:#777;font-size:12px}
  </style><div class="wrap" style="position:relative;display:flex;justify-content:center;width:100%"><div class="bar" hidden></div><div class="pop" hidden></div></div>`;
  const bar = root.querySelector(".bar");
  const pop = root.querySelector(".pop");
  const hideStyle = document.createElement("style");

  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "word"}) : null;
  const tokenize = (text) => segmenter ? [...segmenter.segment(text)].map((s) => ({text: s.segment, word: Boolean(s.isWordLike)}))
    : text.split(/(\p{L}[\p{L}\p{M}'’-]*)/u).filter(Boolean).map((t) => ({text: t, word: /^\p{L}/u.test(t)}));
  const savedTerms = new Set();

  let tokens = [], anchor = null, selection = null; // selection = {lo, hi}
  let pinned = false, hoverTimer = 0, pausedByUs = false, shownText = null;

  function renderBar(text) {
    shownText = text;
    anchor = null; selection = null;
    if (!text) { bar.hidden = true; bar.replaceChildren(); return; }
    tokens = tokenize(text);
    bar.className = "bar";
    bar.replaceChildren(...tokens.map((t, i) => {
      if (!t.word) return document.createTextNode(t.text);
      const span = document.createElement("span");
      span.className = "w" + (savedTerms.has(t.text.toLocaleLowerCase()) ? " saved" : "");
      span.textContent = t.text; span.dataset.i = i;
      return span;
    }));
    bar.hidden = false;
  }
  const phraseOf = (lo, hi) => tokens.slice(lo, hi + 1).map((t) => t.text).join("").trim();
  const highlight = () => { for (const el of bar.querySelectorAll(".w")) { const k = Number(el.dataset.i); el.classList.toggle("on", Boolean(selection) && k >= selection.lo && k <= selection.hi); } };

  // ---------- definitions ----------
  let lookupSeq = 0, current = null; // current = {term, definition, cue}
  const summarize = (r) => r?.suggestion ?? "";
  async function showDefinition(term, cueSnapshot) {
    const seq = ++lookupSeq;
    current = {term, definition: "", cue: cueSnapshot};
    pop.hidden = false;
    pop.innerHTML = `<h3></h3><div class="fine">Looking up…</div>`;
    pop.querySelector("h3").textContent = term;
    const res = await chrome.runtime.sendMessage({type: "lookup", term}).catch((e) => ({ok: false, error: String(e)}));
    if (seq !== lookupSeq) return;
    const r = res?.ok ? res.result : null;
    current.definition = summarize(r);
    pop.innerHTML = `<h3></h3><div class="lemma"></div><ol></ol><textarea placeholder="Your definition"></textarea>
      <div class="row"><button class="save" type="button">Save <kbd>S</kbd></button><button class="ghost close" type="button">Close <kbd>Esc</kbd></button><span class="status"></span></div>`;
    pop.querySelector("h3").textContent = term;
    const lemma = pop.querySelector(".lemma"), list = pop.querySelector("ol"), area = pop.querySelector("textarea"), status = pop.querySelector(".status");
    if (r) {
      lemma.textContent = r.lemma && r.lemma.toLocaleLowerCase() !== term.toLocaleLowerCase() ? `${r.lemma}${r.via ? ` · ${r.via}` : ""}` : (r.via ?? "");
      let group = r.senses[0]?.lemma ?? "";
      for (const sense of r.senses.slice(0, 7)) {
        if ((sense.lemma ?? "") !== group) {
          group = sense.lemma ?? "";
          const head = document.createElement("div"); head.className = "lemma"; head.textContent = group ? `also a form of ${group}` : `${term} (as its own word)`;
          list.append(head);
        }
        const li = document.createElement("li");
        if (sense.pos) { const p = document.createElement("span"); p.className = "pos"; p.textContent = sense.pos + " "; li.append(p); }
        li.append(sense.glosses.slice(0, 3).join("; "));
        list.append(li);
      }
    } else {
      list.remove();
      lemma.textContent = !res?.ok && res?.offline ? "Open the Context Deck app for definitions. You can still save the word." : res?.ok ? "Not in your dictionaries. Add a dictionary in the app, or type your own definition." : `Lookup failed: ${res?.error ?? "unknown error"}`;
    }
    area.value = current.definition;
    area.addEventListener("input", () => { current.definition = area.value; });
    area.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doSave(); if (e.key === "Escape") closePop(); });
    pop.querySelector(".save").onclick = doSave;
    pop.querySelector(".close").onclick = closePop;
    current.status = status;
  }
  function closePop() {
    lookupSeq++; pop.hidden = true; current = null; pinned = false; selection = null; highlight();
    const v = site.video();
    if (pausedByUs && v?.paused) v.play().catch(() => {});
    pausedByUs = false;
  }

  // ---------- capture ----------
  const isProtected = (v) => Boolean(v.mediaKeys); // EME/DRM video: never capture frames or audio
  function grabFrame(v) {
    if (isProtected(v) || !v.videoWidth) return undefined;
    try {
      const scale = Math.min(1, 960 / v.videoWidth);
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.82);
    } catch { return undefined; } // cross-origin/tainted video
  }
  const blobToDataUrl = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(blob); });
  /** Replay the line once and record its audio from the video element. Returns a data URL or undefined. */
  async function recordLine(v, c, status) {
    if (isProtected(v) || typeof v.captureStream !== "function" || typeof MediaRecorder === "undefined") return undefined;
    const resumeAt = v.currentTime;
    const start = Math.max(0, c.startMs / 1000 - 0.25);
    const knownEnd = c.endMs ? c.endMs / 1000 + 0.3 : null;
    status.textContent = "Recording the line…";
    try {
      v.currentTime = start;
      await new Promise((ok) => { const done = () => { v.removeEventListener("seeked", done); ok(); }; v.addEventListener("seeked", done); setTimeout(done, 2500); });
      await v.play();
      const tracks = v.captureStream().getAudioTracks();
      if (!tracks.length) { v.pause(); v.currentTime = resumeAt; return undefined; }
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(new MediaStream(tracks), {mimeType: mime});
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((ok) => { rec.onstop = ok; });
      rec.start(250);
      const t0 = performance.now();
      let leftCueAt = null, endSeen = null;
      await new Promise((ok) => {
        const tick = () => {
          const t = v.currentTime, elapsed = (performance.now() - t0) / 1000;
          if (knownEnd !== null ? t >= knownEnd : false) return ok();
          if (knownEnd === null) {
            const text = readCaption();
            if (t > c.startMs / 1000 + 0.3 && text !== c.text) { if (leftCueAt === null) { leftCueAt = performance.now(); endSeen = t; } if (performance.now() - leftCueAt > 300) return ok(); }
          }
          if (elapsed > 15 || v.ended || v.paused) return ok();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      rec.stop(); await stopped;
      v.pause();
      v.currentTime = resumeAt;
      if (endSeen !== null) c.endMs = Math.round(endSeen * 1000);
      const blob = new Blob(chunks, {type: "audio/webm"});
      return blob.size > 800 ? await blobToDataUrl(blob) : undefined;
    } catch { try { v.pause(); v.currentTime = resumeAt; } catch {} return undefined; }
  }

  let saving = false;
  async function doSave() {
    if (!current || saving) return;
    saving = true;
    const {term, cue: c, status} = current;
    const definition = current.definition.trim();
    const v = site.video();
    status.className = "status"; status.textContent = "Saving…";
    try {
      const frame = v ? grabFrame(v) : undefined;
      const audio = v && prefs.saveAudio ? await recordLine(v, c, status) : undefined;
      pausedByUs = false;
      const encounter = {url: location.href, title: site.title(), language: document.querySelector("video")?.closest("[lang]")?.lang ?? "und",
        term, definition, cue: {text: c.text, startMs: c.startMs, endMs: endOf(c) ?? Math.max(c.startMs, Math.round((v?.currentTime ?? 0) * 1000))}, frame, audio};
      const res = await chrome.runtime.sendMessage({type: "save", encounter});
      if (!res?.ok) throw new Error(res?.error ?? "Save failed");
      savedTerms.add(term.toLocaleLowerCase());
      const media = v && isProtected(v) ? " (text only: this video is copy-protected)" : "";
      status.textContent = res.queued ? `Saved on this browser. It moves to Context Deck when the app is open.${media}` : `Saved to Context Deck${media}`;
      for (const el of bar.querySelectorAll(".w")) if (savedTerms.has(el.textContent.toLocaleLowerCase())) el.classList.add("saved");
      setTimeout(() => { if (current?.term === term && !pop.hidden) closePop(); }, 1400);
    } catch (e) { status.className = "status err"; status.textContent = String(e.message ?? e); }
    finally { saving = false; }
  }

  // ---------- interactions ----------
  const snapshot = () => cue ? {text: cue.text, startMs: cue.startMs, endMs: cue.endMs} : null;
  /** End of a line: known once the site moved past it; otherwise from an earlier pass over the same line. */
  const endOf = (c) => c.endMs ?? history.findLast((h) => h.text === c.text && Math.abs(h.startMs - c.startMs) < 1500)?.endMs;
  function pauseForUs() { const v = site.video(); if (v && !v.paused) { v.pause(); pausedByUs = true; } }
  bar.addEventListener("mouseover", (e) => {
    const w = e.target.closest?.(".w"); if (!w || pinned) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (prefs.pauseOnHover) pauseForUs();
      selection = {lo: Number(w.dataset.i), hi: Number(w.dataset.i)}; anchor = selection.lo; highlight();
      const snap = snapshot(); if (snap) showDefinition(w.textContent, snap);
    }, 160);
  });
  bar.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    setTimeout(() => { if (!pinned && !pop.matches(":hover") && !bar.matches(":hover") && !pop.hidden) closePop(); }, 250);
  });
  pop.addEventListener("mouseleave", () => { if (!pinned) setTimeout(() => { if (!pinned && !bar.matches(":hover") && !pop.matches(":hover")) closePop(); }, 250); });
  bar.addEventListener("click", (e) => {
    const w = e.target.closest?.(".w"); if (!w) return;
    e.preventDefault(); e.stopPropagation();
    clearTimeout(hoverTimer);
    const i = Number(w.dataset.i);
    if (e.shiftKey && anchor !== null) selection = {lo: Math.min(anchor, i), hi: Math.max(anchor, i)};
    else { anchor = i; selection = {lo: i, hi: i}; }
    pinned = true; pauseForUs(); highlight();
    const snap = snapshot(); if (snap) showDefinition(phraseOf(selection.lo, selection.hi), snap);
  });
  for (const type of ["mousedown", "mouseup", "dblclick", "pointerdown", "pointerup"]) host.addEventListener(type, (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (pop.hidden || !current) return;
    const tag = (e.composedPath()[0]?.tagName ?? "").toLowerCase();
    if (tag === "textarea" || tag === "input") return;
    if (e.key === "s" || e.key === "S") { e.preventDefault(); e.stopImmediatePropagation(); pinned = true; doSave(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closePop(); }
  }, true);

  // ---------- main loop ----------
  let seenCaptionAt = 0, playingSince = 0;
  function tick() {
    if (location.href !== lastUrl) { lastUrl = location.href; cue = null; history.length = 0; savedTerms.clear(); closePop(); renderBar(""); seenCaptionAt = 0; playingSince = 0; }
    const v = isWatchPage() && prefs.enabled ? site.video() : null;
    const player = v ? (document.fullscreenElement?.contains(v) ? document.fullscreenElement : site.player()) : null;
    if (!v || !player) { if (host.isConnected) host.remove(); hideStyle.remove(); return; }
    if (host.parentElement !== player) { if (getComputedStyle(player).position === "static") player.style.position = "relative"; player.append(host); }
    const text = readCaption();
    const ms = Math.round(v.currentTime * 1000);
    if (text !== (cue?.text ?? "")) {
      if (cue) { cue.endMs = ms; history.push(cue); if (history.length > 60) history.shift(); }
      cue = text ? {text, startMs: ms} : null;
    }
    if (text) seenCaptionAt = performance.now();
    if (!v.paused) playingSince ||= performance.now(); else playingSince = 0;
    // Keep showing the pinned line while a definition is open, even if the site moves on.
    if (!pinned && pop.hidden && text !== shownText) renderBar(text);
    if (text) { hideStyle.textContent = site.hideNative; if (!hideStyle.isConnected) document.head.append(hideStyle); }
    else if (!pinned && pop.hidden) {
      hideStyle.remove();
      const noCaptions = playingSince && performance.now() - playingSince > 8000 && performance.now() - seenCaptionAt > 8000 && !seenCaptionAt;
      if (noCaptions && bar.hidden) { bar.className = "bar hint"; bar.textContent = `Context Deck: ${site.ccHint}`; bar.hidden = false; shownText = "\u0000hint"; setTimeout(() => { if (shownText === "\u0000hint") renderBar(""); }, 6000); }
    }
  }
  setInterval(tick, 120);
  window.__contextDeckState = () => ({cue, history: history.slice(-5), shownText, popOpen: !pop.hidden, pinned});
})();
