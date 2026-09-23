# Context Deck

Learn a language from scenes and pages you actually care about. Context Deck keeps every word connected to the sentence, clip and timestamp where you met it.

**Local-first. No account. No server. No hosted media catalog. No DRM interception.**

## What works in v0.2

- `npm start` runs Context Deck on your own machine at `http://127.0.0.1:4173` (localhost only, nothing leaves your computer).
- Open a local video/audio file, load SRT or VTT subtitles, and follow the active line.
- Click any word in the subtitle to pick it (the video pauses). Shift-click another word to extend it to a phrase. Works for unspaced scripts like Japanese and Chinese too, using the browser's word segmenter. Add a definition and save: the word, sentence and timestamp are stored together.
- **Open media** on macOS shows the normal file picker and, when there's a matching `movie.srt`, `movie.vtt` or `movie.es.srt` next to the video, loads the subtitles automatically.
- If ffmpeg is installed (`brew install ffmpeg`), every save also cuts a still frame and a short audio clip of that line from your own file. They show in the list (click ▶ to hear the line) and travel with the card to Anki. Without ffmpeg, saving still works, just without media.
- Saves go into a local SQLite database and survive restarts (macOS: `~/Library/Application Support/Context Deck/deck.db`; elsewhere `~/.context-deck/deck.db`; override with `CONTEXT_DECK_DB`).
- **Send to Anki** adds every new card, with frame and audio, to a "Context Deck" deck through the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on (Anki must be open). Cards already sent are skipped.
- **Export file** downloads `context-deck-anki.txt` (text fields plus the `contextdeck://` link) for File > Import in Anki if you don't use AnkiConnect. Frames and audio are not included in the file.
- The Chrome extension saves highlighted text from a webpage to `~/Downloads/context-deck/`. **Import browser captures** pulls those files into the database. Importing twice never creates duplicates (override the folder with `CONTEXT_DECK_CAPTURES`).
- Optional: create SRT with a whisper.cpp you installed yourself (core library adapter).

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

Requires Node 20+ (`node -v`; on macOS `brew install node`). Recommended: `brew install ffmpeg` for frames and audio clips, and the AnkiConnect add-on in Anki (code 2055492159).

```bash
git clone https://github.com/DeepanshuPal/context-deck.git
cd context-deck
npm install
npm start
```

Then open http://127.0.0.1:4173. Stop it with Ctrl+C; your saves stay.

### Mac app

The Mac app is the same interface in its own window, and it registers `contextdeck://` so the "Open original context" link on an Anki card opens the app, loads the original file and jumps to that line. It uses the same database as `npm start`.

Build it on your Mac (no signing account needed, and because you built it yourself, macOS won't quarantine it):

```bash
cd apps/mac
npm install
npm run dist
open release/mac-arm64/Context\ Deck.app      # Intel Macs: release/mac/Context\ Deck.app
```

Drag it into Applications, then open it once so macOS learns about the `contextdeck://` links. `npm run dev` runs it without packaging.

Each push also builds `.dmg` and `.zip` files in GitHub Actions (the mac-app workflow artifacts). Those are ad-hoc signed, not notarized, so a downloaded copy needs right-click > Open the first time. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Context Deck.app"`.

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

The Mac app handles these links (see below).

## Repository shape

```text
apps/desktop      static HTML/JS interface
apps/mac          Electron wrapper, contextdeck:// handler, macOS packaging
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

- Optional dictionary adapters
- Deck sync reconciliation without ever deleting encounters

## License

MIT
