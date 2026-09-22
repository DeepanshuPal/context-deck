# Architecture

Context Deck is a local desktop product, not a hosted service.

## Boundaries

- `@context-deck/core`: original encounter graph, subtitle parsing, Anki export, browser-capture validation, and optional whisper.cpp process adapter.
- `apps/desktop`: local media/subtitle interface. The current web build proves the UX; packaging as Electron is the next release step.
- `apps/extension`: a Manifest V3 extension that captures only the user's explicit text selection from normal HTTP(S) pages. It exports JSON instead of intercepting media.
- whisper.cpp is optional and user-installed. Context Deck never downloads model weights silently.
- Anki is optional. TSV export works without Anki; AnkiConnect is a localhost adapter.

## Encounter graph invariant

An encounter is append-only evidence that a term appeared at a specific source and time. Learning state and exported-card lifecycle are separate records. Marking a card deleted never deletes the encounter.

## Provenance

The project is original orchestration inspired by the workflows of Lute v3 and asbplayer. It contains no copied source from those projects. Named dependencies are integrated by portable files or local interfaces.
