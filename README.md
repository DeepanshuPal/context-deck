# Context Deck

Learn a language from the YouTube videos, Netflix shows and files you actually watch. Context Deck keeps every word connected to the sentence, clip and timestamp where you met it.

**Local-first. No account. No server. No hosted media catalog. No DRM interception.**

## Watch on YouTube and Netflix (v0.7)

1. Open the Context Deck app and add a dictionary (**Dictionaries** > your language > **Download to English**).
2. Click **YouTube & Netflix** > **Show extension folder**. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and drag the **Browser Extension** folder onto the page (or **Load unpacked** and pick it). This is a one-time step; the extension isn't in the Chrome Web Store.
3. Play a YouTube or Netflix video and turn its subtitles on (on YouTube, press **C**).
4. The subtitles become clickable. **Hover a word** and its definition appears right above it (the video pauses while you read). **Click** to keep it open, **Shift-click** another word to make a phrase, edit the definition if you like, then press **S** (or Save). **Esc** closes.
5. The word lands in Context Deck with its sentence, the moment in the video and a link back to it. **Send to Anki** as usual; the card's link reopens the video at that line.

On YouTube, saving also keeps a still frame and the line's audio: the line replays once while it's recorded from the video in your tab, then the video goes back to where you were (turn this off in the extension's menu). **Netflix is copy-protected**, so its cards are text only, with a link back to the moment. Context Deck never records copy-protected video, and the extension only reads the subtitle text the site already shows. If the app is closed, saved words wait in Chrome and move into the app the next time it's open, with the definition filled in.

The extension talks only to the Context Deck app on your own computer (`127.0.0.1`), and the app accepts it by its fixed extension ID. Other websites and extensions can't use that connection.

## Also in the app

- `npm start` runs Context Deck on your own machine at `http://127.0.0.1:4173` (localhost only, nothing leaves your computer).
- Open a local video/audio file, load SRT or VTT subtitles, and follow the active line.
- Click any word in the subtitle to pick it (the video pauses). Shift-click another word to extend it to a phrase. Works for unspaced scripts like Japanese and Chinese too, using the browser's word segmenter. Add a definition and save: the word, sentence and timestamp are stored together.
- **Open media** on macOS shows the normal file picker and, when there's a matching `movie.srt`, `movie.vtt` or `movie.es.srt` next to the video, loads the subtitles automatically.
- If ffmpeg is installed (`brew install ffmpeg`), every save also cuts a still frame and a short audio clip of that line from your own file. They show in the list (click ▶ to hear the line) and travel with the card to Anki. Without ffmpeg, saving still works, just without media.
- Saves go into a local SQLite database and survive restarts (macOS: `~/Library/Application Support/Context Deck/deck.db`; elsewhere `~/.context-deck/deck.db`; override with `CONTEXT_DECK_DB`).
- **Send to Anki** adds every new card, with frame and audio, to a "Context Deck" deck through the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on (Anki must be open). Cards already in Anki are skipped.
- **Dictionaries** (optional, offline): download a free Wiktionary pack for one of 17 languages into English, or import any Yomitan-format `.zip` you already have (for example JMdict). The pack is downloaded once and stored in your local database; after that, lookups run fully offline. Clicking a subtitle word looks it up, follows inflections to the base form (`sabía` → `saber`) and fills in the definition, which you can still edit. With no dictionary installed, definitions stay user-entered. Pack sizes are roughly 5 to 60 MB.
- **Anki sync without losing history**: every Send to Anki first checks which cards still exist in Anki. A card you deleted in Anki is marked "Deleted in Anki" and is not re-added automatically; click **Re-send** on that row if you want it back. Deleting a card in Anki never deletes the encounter in Context Deck.
- **Export file** downloads `context-deck-anki.txt` (text fields plus the `contextdeck://` link) for File > Import in Anki if you don't use AnkiConnect. Frames and audio are not included in the file.
- The Chrome extension saves highlighted text from a webpage to `~/Downloads/context-deck/`. **Import browser captures** pulls those files into the database. Importing twice never creates duplicates (override the folder with `CONTEXT_DECK_CAPTURES`).
- Optional: create SRT with a whisper.cpp you installed yourself (core library adapter).

Encounters are append-only: deleting or re-exporting a card never deletes the history of where you met a word. There are regression tests for this and for persistence, import de-duplication, dictionary lookup, Anki sync and cross-site request blocking.

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

Each push also builds `.dmg` and `.zip` files in GitHub Actions (the mac-app workflow artifacts). Those are ad-hoc signed, not notarized, so macOS blocks a downloaded copy the first time. On macOS 15 Sequoia and later, open it once, then go to System Settings > Privacy & Security and click **Open Anyway**. On macOS 14 and earlier, right-click the app and choose **Open**. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Context Deck.app"`.

Other commands: `npm run check` (build + tests), `npm run demo` (engine demo in memory).

Load the browser extension in Chrome (the Mac app's **YouTube & Netflix** button gives you the folder; from the repo, use `apps/extension`):

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Load unpacked: pick the extension folder.

Besides clickable YouTube/Netflix subtitles, you can highlight text on any normal webpage, right-click, **Save selection to Context Deck**, then click **Import browser captures** in the app. That saves only the highlighted text plus the page title and URL.

`npm run e2e` runs the whole browser flow in real Chrome against YouTube- and Netflix-shaped test pages (it downloads the Spanish dictionary once).

## Local transcription

Context Deck does not bundle whisper.cpp or model weights. Install [whisper.cpp](https://github.com/ggml-org/whisper.cpp), choose a model yourself, and pass its local paths to the core adapter. This keeps model cost and privacy under the user's control.

## Anki

TSV export is the default and requires no integration. Optional AnkiConnect support talks only to `127.0.0.1:8765`. Cards include a deep link like:

```text
contextdeck://source/abc123?t=1422000&encounter=...
```

The Mac app handles these links (see below). Cards saved from YouTube or Netflix link straight to the video at that moment instead.

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

Use media you own or are allowed to access. Context Deck does not bypass DRM, scrape streaming catalogs, or fetch protected media. On streaming sites it reads only the subtitle text on screen; frames and audio are captured only from video that isn't copy-protected, and only when you save a word. Dictionaries are optional and stay local after the one-time download; nothing is looked up online.

## Roadmap

Everything planned for this version has shipped. Ideas and bug reports are welcome as GitHub issues.

## Dictionary credits

Downloadable packs contain definitions from [Wiktionary](https://www.wiktionary.org/) (CC BY-SA 4.0), extracted by [kaikki.org](https://kaikki.org/) and packaged by [wiktionary-to-yomitan](https://github.com/yomidevs/wiktionary-to-yomitan). The packs are downloaded by you and are not bundled with Context Deck.

## License

MIT
