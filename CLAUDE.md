# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Scratch Pad** is a SillyTavern browser extension that provides out-of-character (OOC) meta-conversations with AI about ongoing roleplays. Users can discuss plot, characters, and direction in threaded side-conversations without polluting the main chat. It ships as vanilla ES6 modules with no build step — the code runs directly in the browser.

**Installation path:** `SillyTavern/public/scripts/extensions/third-party/sillytavern_scratchpad/`

## Commands

```bash
# Run tests (reasoning extraction)
node tests/reasoning-normalization.test.mjs
```

There is no build, lint, or bundling step. The extension loads directly via SillyTavern's extension system.

## Architecture

### Entry Point & Module Graph

`index.js` initializes the extension, loads settings HTML/CSS, registers event listeners, and wires up slash commands. All core logic lives in `src/`:

```
index.js ──┬── src/storage.js      Thread/message CRUD, branch filtering, swipes
           ├── src/settings.js     Settings UI binding, per-thread context config
           ├── src/commands.js     Slash command registration (/sp, /sp-view, /rawprompt)
           ├── src/generation.js   Context building, API calls, 3 generation modes
           │   ├── src/reasoning.js   Multi-provider reasoning/thinking extraction
           │   └── src/streaming.js   Direct SSE streaming to chat-completions endpoint
           ├── src/tts.js          Optional text-to-speech integration
           └── src/ui/
               ├── index.js        Drawer lifecycle (create-on-open, destroy-on-close)
               ├── conversation.js Thread view, message rendering, swipe navigation
               ├── threadList.js   Thread list with branch indicators
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
- **Connection Manager** — optional; provides alternative API endpoint profiles.

## Known Open Issues

See `.ai-notes/issues.md` for the tracked list. Key open items:
- #4: Regenerations don't apply extracted title to thread name
- #1: Mobile popup height collapses to 0px
- #5: Pinned panel breaks page scrolling

## Repo Sync

This project is synced with GitHub. Push all changes to the remote.
