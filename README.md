# Context Deck

Learn a language from scenes and pages you actually care about. Context Deck keeps every word connected to the sentence, clip and timestamp where you met it.

**Local-first. No account. No server. No hosted media catalog. No DRM interception.**

## What works in v0.2

- `npm start` runs Context Deck on your own machine at `http://127.0.0.1:4173` (localhost only, nothing leaves your computer).
- Open a local video/audio file, load SRT or VTT subtitles, follow the active line, and save a word with your definition, the sentence and the timestamp.
- Saves go into a local SQLite database and survive restarts (macOS: `~/Library/Application Support/Context Deck/deck.db`; elsewhere `~/.context-deck/deck.db`; override with `CONTEXT_DECK_DB`).
- **Export to Anki** downloads `context-deck-anki.txt` with every saved encounter and a `contextdeck://` link to the exact moment. Import it in Anki with File > Import.
- The Chrome extension saves highlighted text from a webpage to `~/Downloads/context-deck/`. **Import browser captures** pulls those files into the database. Importing twice never creates duplicates (override the folder with `CONTEXT_DECK_CAPTURES`).
- Optional: push a card through AnkiConnect on localhost, or create SRT with a whisper.cpp you installed yourself (core library adapters).

Encounters are append-only: deleting or re-exporting a card never deletes the history of where you met a word. There are regression tests for this and for persistence, import de-duplication and cross-site request blocking.

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

Requires Node 20+ (`node -v`; on macOS `brew install node`).

```bash
git clone https://github.com/DeepanshuPal/context-deck.git
cd context-deck
npm install
npm start
```

Then open http://127.0.0.1:4173. Stop it with Ctrl+C; your saves stay.

Other commands: `npm run check` (build + tests), `npm run demo` (engine demo in memory).

Load the browser extension in Chrome:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Load unpacked: pick the `apps/extension` folder.
4. Highlight text on a normal webpage, right-click, **Save selection to Context Deck**.
5. In the app, click **Import browser captures**.

The extension only saves the text you highlight plus the page title and URL. It does not download page media or inspect DRM streams.

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
apps/desktop      static HTML/JS interface
packages/app      localhost server: serves the UI, SQLite API, Anki export, capture import
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
- Optional dictionary adapters
- Deck sync reconciliation without ever deleting encounters

## License

MIT
