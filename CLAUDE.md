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

# Syntax-check every module (no build step, so this is the "compile")
for f in index.js src/*.js src/ui/*.js; do node --check "$f"; done
```

There is no build, lint, or bundling step. The extension loads directly via SillyTavern's extension system.

## Architecture

### Entry Point & Module Graph

`index.js` initializes the extension, loads settings HTML/CSS, registers event listeners, and wires up slash commands. All core logic lives in `src/`:

```
index.js ──┬── src/storage.js      Thread/message CRUD, branch filtering, swipes
           ├── src/settings.js     Settings UI binding, per-thread context config, embeddings config
           ├── src/commands.js     Slash command registration (/sp, /sp-view, /rawprompt); replies are returned for STscript
           ├── src/generation.js   Context building, API calls, 3 generation modes, prompt preview
           │   ├── src/contextSources.js  Character cards (incl. groups), persona, World Info, summary, history formatting
           │   ├── src/reasoning.js   Multi-provider reasoning/thinking extraction
           │   └── src/streaming.js   Direct SSE streaming to chat-completions endpoint
           ├── src/threadExport.js Markdown/JSON thread export and JSON import (pure)
           ├── src/chatActions.js  Insert a reply into the main chat input or the Author's Note
           ├── src/embeddings.js   Embedding provider dispatch + localforage vector cache
           ├── src/semanticSearch.js  Corpus build, lazy index, hybrid cosine ranking
           ├── src/messageQueue.js  In-memory FIFO of messages sent while generating (pure, no DOM)
           ├── src/draftStore.js   Memory-only per-thread unsent input drafts (pure, no DOM)
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

**Message queue:** Sending while `isGenerating()` enqueues instead of dispatching. State lives in `src/messageQueue.js` (pure, unit-tested in `tests/message-queue.test.mjs`); UI and dispatch live in `ui/conversation.js`. Every path that holds the generation lock (send, retry, swipe, edit, AI rename, and both popup generations via `notifyGenerationSettled`) calls `advanceMessageQueue(threadId, succeeded)` when it settles: on cancel/failure that thread's queued items return to its input (`returnTextToInput`: the live textarea if the thread is on screen, otherwise prepended to its draft in `src/draftStore.js`), then the next item is dispatched with `sendMessageToThread`, which only touches the DOM while its thread is on screen because queued items can dispatch in the background. The queue and all drafts are cleared on CHAT_CHANGED via `resetConversationState()`.

**Input drafts:** `src/draftStore.js` (pure, unit-tested in `tests/draft-store.test.mjs`) is the single source of truth for unsent input text: a Map keyed by thread ID (`NEW_THREAD_DRAFT_KEY` for the New Thread view) that stores only non-empty drafts, so it stays O(1) however many threads a chat has. The conversation textarea writes its draft on every `input` event under a key captured at render time, so no close path needs a save-on-leave hook; `deleteThread()` / `clearAllThreads()` in `storage.js` drop matching drafts. Drafts are never stored in `chatMetadata` because `saveMetadata()` rewrites the entire chat file (every chat message plus every thread), so typing must never trigger a save.

**Prompt context:** `buildPrompt` (generation.js) assembles fixed sections (ST system prompt, character cards, persona, World Info, Author's Note, summary) and variable ones (main-chat history, previous thread messages). Only the variable ones are trimmed, oldest first, to fit the token budget. Per-thread toggles live in `contextSettings` (`includePersona` defaults on; `includeWorldInfo`, `includeSummary`, `includeHiddenMessages` default off) and new threads copy them from the global settings. Hidden main-chat messages (`is_system`) are dropped before the history limit is applied. World Info uses SillyTavern's `getWorldInfoPrompt` as a dry run, with the user's question scanned as the newest message.

**Context stats:** `buildPrompt` returns `promptData.stats` (tokens, budget, messages sent and trimmed). They are stored per swipe as `extra.promptStats` (via `swipeExtra`), shown under each reply, and `syncSwipeToMessage` clears them before applying the active swipe's extra so a swipe never shows another swipe's numbers. `buildPromptPreview` builds the same prompt without sending it.

**Thread order:** The list sorts by `getThreadActivityTime` (newest message, swipe, or edit), not `updatedAt`, so renames and context changes don't reorder threads. `thread.pinned` keeps a thread on top.

**Deletes and undo:** Thread and message deletes happen immediately and show an undo toast (`showUndoToast`). Undo re-inserts the removed objects at their old positions (`restoreThread`, `restoreMessages`) and refuses after a chat switch. Deleting a user message also deletes the reply that follows it (`getMessageIdsToDelete`). Deletes are blocked while that thread is generating.

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

`.ai-notes/` is gitignored, so the issue notes there are local-only and may not exist in a fresh clone. Items last tracked there:
- #4: Regenerating a thread's first reply keeps the original title (the title instruction is only sent with the first message)
- #1: Mobile popup height collapses to 0px
- #5: Pinned panel breaks page scrolling

## Repo Sync

This project is synced with GitHub. Push all changes to the remote.
