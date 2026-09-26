# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Scratch Pad** is a SillyTavern browser extension that provides out-of-character (OOC) meta-conversations with AI about ongoing roleplays. Users can discuss plot, characters, and direction in threaded side-conversations without polluting the main chat. It ships as vanilla ES6 modules with no build step — the code runs directly in the browser.

**Installation path:** `SillyTavern/public/scripts/extensions/third-party/sillytavern_scratchpad/`

## Commands

```bash
# Run a test (each file is a standalone node script)
node tests/reasoning-normalization.test.mjs
node tests/semantic-search.test.mjs

# Run all tests
for t in tests/*.test.mjs; do node "$t"; done
```

There is no build, lint, or bundling step. The extension loads directly via SillyTavern's extension system.

## Architecture

### Entry Point & Module Graph

`index.js` initializes the extension, loads settings HTML/CSS, registers event listeners, and wires up slash commands. All core logic lives in `src/`:

```
index.js ──┬── src/storage.js      Thread/message CRUD, branch filtering, swipes
           ├── src/settings.js     Settings UI binding, per-thread context config, embeddings config
           ├── src/commands.js     Slash command registration (/sp, /sp-view, /rawprompt)
           ├── src/generation.js   Context building, API calls, 3 generation modes
           │   ├── src/reasoning.js   Multi-provider reasoning/thinking extraction
           │   └── src/streaming.js   Direct SSE streaming to chat-completions endpoint
           ├── src/embeddings.js   Embedding provider dispatch + localforage vector cache
           ├── src/semanticSearch.js  Corpus build, lazy index, hybrid cosine ranking
           ├── src/tts.js          Optional text-to-speech integration
           └── src/ui/
               ├── index.js        Drawer lifecycle (create-on-open, destroy-on-close)
               ├── conversation.js Thread view, message rendering, swipe navigation
               ├── threadList.js   Thread list, branch indicators, Text/Semantic search toggle
               ├── popup.js        Quick-response bottom-sheet (mobile) / inline (desktop)
               └── components.js   Shared UI primitives, markdown rendering
```

### Key Design Decisions

**Storage:** All data persists in SillyTavern's `chatMetadata.scratchPad` (per-chat). Settings live in `extensionSettings.scratchPad` (global). No custom file I/O.

**Branch-aware messages:** Messages track their `chatMessageIndex` so the extension can show/hide messages from other chat branches. Off-branch messages appear in a collapsible section.

**Swipe system:** AI responses are stored as a `swipes[]` array with an active `swipeId` index. The top-level `content` field is synced from the active swipe for backward compatibility.

**Three generation modes** (in `generation.js`):
- **Direct SSE streaming** — fastest path, streams via `/api/backends/chat-completions/generate`
- **Standard generation** — uses SillyTavern's full `generateRaw` pipeline
- **Safety mode** — for Claude models that don't support assistant prefill

**Reasoning normalization** (`reasoning.js`): Extracts thinking/reasoning from 10+ provider formats (Anthropic content blocks, OpenAI `reasoning_content`, `<think>` tags, Google/Mistral fields, encrypted signatures) into a unified representation.

**Semantic search** (`embeddings.js` + `semanticSearch.js`): Optional embedding-based thread search alongside the instant keyword search. `embeddings.js` dispatches to OpenRouter/OpenAI/Ollama and caches vectors in IndexedDB (localforage, DB `ScratchPad_Embeddings`); config lives at `extensionSettings.scratchPad.embeddings` and, when `useSharedConfig` is on, inherits provider/key/model from the sibling `chat_manager` extension's `extensionSettings.chat_manager.embeddings`. `semanticSearch.js` builds a corpus of thread titles + message variants, embeds them lazily (cache-first), and ranks threads with a hybrid score `0.7*cosine + 0.3*keyword` (ported from `chat_manager`). The pure scoring helpers (`cosineSimilarity`, `scoreEntries`, `reduceToBestPerThread`) are unit-tested in `tests/semantic-search.test.mjs`. The Text/Semantic toggle lives in `ui/threadList.js`.

**Lazy UI:** The drawer DOM is created on open and destroyed on close to avoid stale state.

### SillyTavern API Surface

The extension depends on these SillyTavern APIs accessed via `SillyTavern.getContext()`:
- `eventSource` — pub/sub events (CHAT_CHANGED, MESSAGE_SWIPED, etc.)
- `chatMetadata` / `extensionSettings` — persistence
- `SlashCommandParser` — slash command registration
- `callGenericPopup()` — confirmation dialogs
- External libraries exposed by ST: `DOMPurify`, `Fuse.js`, `jQuery`

### External Extension Dependencies

- **Token Usage Tracker** — wraps `sendRequest` to count tokens. Must load before Scratch Pad's first API call (load-order dependency; silent failure if missed).
- **Connection Manager** — optional; provides alternative API endpoint profiles. Scratch Pad stores profile IDs and sends profile-scoped requests through `ConnectionManagerRequestService` without changing SillyTavern's active profile.

## Known Open Issues

See `.ai-notes/issues.md` for the tracked list. Key open items:
- #4: Regenerations don't apply extracted title to thread name
- #1: Mobile popup height collapses to 0px
- #5: Pinned panel breaks page scrolling

## Repo Sync

This project is synced with GitHub. Push all changes to the remote.
