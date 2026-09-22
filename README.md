# Context Deck

Learn a language from scenes and pages you actually care about. Context Deck keeps every word connected to the sentence, clip and timestamp where you met it.

**Local-first. No account. No server. No hosted media catalog. No DRM interception.**

## What works in v0.1

- Open a local video/audio file in the desktop interface.
- Load SRT or VTT subtitles and follow the active cue.
- Save a word or phrase with definition, sentence and timestamp.
- Store encounters in a local SQLite graph, separate from learning state and flashcard lifecycle.
- Export deterministic Anki-compatible TSV with a `contextdeck://` deep link to the exact source timestamp.
- Optionally push a card through AnkiConnect on localhost.
- Optionally call a user-installed whisper.cpp binary/model to create SRT locally.
- Capture an explicit text selection from a normal webpage with the Manifest V3 browser extension.

The core invariant has a regression test: deleting an exported card never deletes encounter history.

## Why this is different

Subtitle miners make cards. Reading tools track known words. Context Deck keeps the encounter graph underneath both:

```text
term
  ├── encounter: episode-03 / 00:14:22 / sentence / clip
  ├── encounter: article-17 / paragraph-8 / sentence
  └── encounter: film-02 / 01:03:09 / sentence / frame
```

The flashcard is a disposable view of that history, not the history itself.

## Run it

Requires Node 20+.

```bash
npm install
npm run check
npm run demo
npm run build
```

Open the desktop proof UI:

```bash
npm run dev -w @context-deck/desktop
```

The built static interface lands in `apps/desktop/dist`.

Load the browser extension in Chromium:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Load unpacked: `apps/extension`.
4. Select text on a permitted HTTP(S) page and use **Save selection to Context Deck**.

The extension saves a small JSON capture to the browser's local storage and Downloads. It does not download page media or inspect DRM streams.

## Local transcription

Context Deck does not bundle whisper.cpp or model weights. Install [whisper.cpp](https://github.com/ggml-org/whisper.cpp), choose a model yourself, and pass its local paths to the core adapter. This keeps model cost and privacy under the user's control.

## Anki

TSV export is the default and requires no integration. Optional AnkiConnect support talks only to `127.0.0.1:8765`. Cards include a deep link like:

```text
contextdeck://source/abc123?t=1422000&encounter=...
```

Desktop protocol registration is the next packaging milestone.

## Repository shape

```text
apps/desktop      React/Vite desktop proof UI
apps/extension    Manifest V3 selection capture
packages/core     encounter graph, subtitles, export, local adapters
docs              architecture and invariants
fixtures           safe sample subtitles
```

## Component lineage

The product idea combines the workflow shapes of:

- [Lute v3](https://github.com/LuteOrg/lute-v3) - language texts, terms and learning states (MIT)
- [asbplayer](https://github.com/asbplayer/asbplayer) - local media and subtitle sentence mining (MIT)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) - optional offline transcription (MIT)
- Anki - optional external destination through TSV or AnkiConnect

Context Deck's code is original. It does not copy those repositories or bundle Anki.

## Safety and scope

Use media you own or are allowed to access. Context Deck does not bypass DRM, scrape streaming catalogs, or fetch protected media. Definitions are user-entered in v0.1; provider adapters can be added later without making a network service mandatory.

## Roadmap

- Electron packaging and `contextdeck://` protocol registration
- Click-to-select tokens directly in subtitle text
- Frame and short-audio extraction through local ffmpeg
- Browser-capture inbox import
- Optional dictionary adapters
- Deck sync reconciliation without ever deleting encounters

## License

MIT
