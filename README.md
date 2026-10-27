# SillyTavern Scratch Pad Extension

A SillyTavern extension that enables out-of-character (OOC) meta-conversations with the AI about your current roleplay. Ask questions about character motivations, plot details, "what if" scenarios, request summaries, or discuss the story — all without breaking immersion in the main chat.

## Features

- **Meta Conversations**: Have OOC discussions about your roleplay without affecting the main chat
- **Separate Troubleshooting Mode**: Use `/sp-debug` to discuss configuration and context problems with a fresh, filtered settings snapshot, without automatically sharing story text
- **Threaded Discussions**: Organize different lines of inquiry into separate threads
- **Semantic Search**: Search threads by *meaning*, not just keywords, using embeddings (OpenRouter / OpenAI / Ollama). Reuses the Chat Manager extension's embedding key by default.
- **Full Context**: AI responses are informed by your chat history, character cards (every member in group chats), your persona, and optionally World Info and the chat summary
- **Context Usage**: Each reply shows how many tokens its prompt used and whether older messages were trimmed to fit; **Preview prompt** shows exactly what the next question would send
- **Swipe Analysis**: Compare alternative swipes of the latest main-chat user message, AI message, or both
- **Streaming Responses**: Watch AI responses generate in real-time
- **Message Queue**: Keep typing while a reply generates — messages you send are queued and sent in order as each reply finishes
- **Reasoning Capture**: Captures model reasoning/thinking for supported SillyTavern provider formats and configured reasoning tags
- **Text-to-Speech**: Speak replies on demand or automatically generate and play speech for completed replies using SillyTavern's TTS and your selected voice
- **Mobile Friendly**: Full-screen drawer UI with touch support and bottom sheet popups
- **Resizable Panel**: Drag the left edge of the desktop drawer or pinned sidebar; your width is remembered
- **Persistent Storage**: Threads are saved with your chat and inherit properly when branching
- **Quick Access**: Use `/sp <question>` for quick popup responses, or `quiet=true` to use the reply in STscript
- **Quick Prompts**: Saved questions you can start a thread with in one click
- **Thread Tools**: Pin threads, branch a thread from any message, delete single messages, undo deletes, and export/import threads as Markdown or JSON
- **Send to Main Chat**: Put a reply in the chat input or add it to the Author's Note

## Installation

1. Open SillyTavern and navigate to the Extensions panel
2. Click "Install Extension"
3. Enter the repository URL: `https://github.com/bla6987/sillytavern_scratchpad`
4. Click "Save" and reload SillyTavern

Alternatively, clone the repository directly into your SillyTavern extensions folder:

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/bla6987/sillytavern_scratchpad
```

## Usage

### Opening Scratch Pad

- Click the **Scratch Pad** button in the extensions menu
- Use the `/sp` or `/scratchpad` slash command
- Use `/sp-view` to open directly to the thread list

### Resizing the Panel

Drag the panel's left edge to change its width. You can also Tab to the resize handle and use **Left/Right Arrow** (10px steps), **Shift + Arrow** (50px steps), or **Home/End** (minimum/maximum width). Double-click the handle to reset to 400px. The desktop width is shared by Drawer and Pinned Sidebar modes and saved when you finish resizing. Press **Escape** during a drag to cancel it.

Every display mode overlays the page without moving or resizing SillyTavern's main chat or toolbar. Pinned Sidebar sits below the toolbar and native drawers and keeps the chat usable behind it, so a wide panel can cover part of the chat. It temporarily falls back to a drawer with a backdrop on windows 1000px or narrower or while **Moving UI** is enabled. Phone-sized windows keep the full-width drawer. Resizing the window clamps the panel to fit without overwriting your saved width.

### Quick Questions

Send a question directly from the chat input:

```
/sp What is the character's motivation for betraying the protagonist?
```

This creates a new thread and shows a popup with the AI's response. Use **Copy response** in the bottom action row to copy the reply once generation finishes (without model thinking or timing details). You can dismiss the popup or open it in the full Scratch Pad interface to continue the conversation.

### Analyzing Main-Chat Swipes

Open a Scratch Pad thread, expand **Context Options**, and set **Swipe context** to **Latest user message**, **Latest AI message**, or **Latest user and AI messages**. Then ask a question such as “Compare the AI swipes for character consistency” or “Which user swipe gives the scene the strongest direction?”

Scratch Pad includes every available nonempty swipe of the latest message for each selected role, labels them with 1-based swipe numbers, and marks the currently selected version. Alternatives are presented as different versions of one message. Your main chat and selected swipes stay unchanged. If the latest message has no alternatives, Scratch Pad reports that to the model instead of using an older message's swipes.

Both main-chat history and swipe alternatives use SillyTavern's prompt regex processing, with user/AI rules and message depths from the full chat. History ranges and token trimming do not change those depths. Display-only rules do not apply to prompts. A swipe stripped entirely by prompt rules keeps its number and is marked empty; stored messages and swipes are unchanged. **Preview prompt** shows the processed text.

Swipe context uses the latest messages in the full main chat, even when your history range excludes them. It refreshes on every request, including regenerated Scratch Pad replies. Older history can be trimmed to fit the model's context window; if the requested alternatives still cannot fit, generation stops with an error so the comparison does not silently omit swipes. **Character Card Only**, `/sp-ask`, and `/rawprompt` omit swipe context.

The default is **Selected swipes only**, which keeps the existing behavior. Change **Extensions → Scratch Pad → Swipe context** to set the default for new threads and `/sp` popups. Existing threads keep their own choice.

### Troubleshooting Configuration and Context

Use a separate command to start a diagnostic conversation:

```text
/sp-debug
/sp-debug Why are my replies getting cut short?
/sp-debug quiet=true Check my context limits
```

With no question, `/sp-debug` opens a new **🔧 Troubleshooting** thread. Its **Preview diagnostic prompt** button shows what the next question would send. With a question, it generates a popup response; `quiet=true` returns the reply for scripts without the popup. Open a popup in Scratch Pad to continue the diagnostic conversation or preview its next request.

Troubleshooting is a fixed thread purpose, not a checkbox. Reopening, branching, editing/retrying a question, generating another swipe, and JSON export/import preserve the mode. Ordinary `/sp` conversations and the **New Thread** button continue to use story mode. A wrench label identifies diagnostic threads in both the list and conversation header. Story context controls are replaced by a diagnostic notice, a connection-profile selector, and preview.

Every diagnostic question gathers a fresh snapshot of the active API/model, configured generation limits and samplers, Prompt Manager order/roles/depths and text lengths, formatting flags, Author's Note/persona placement and lengths, available World Info settings, regex flags, extension versions, selected summarization/vector settings, and Scratch Pad defaults. When Scratch Pad uses a Connection Manager profile, the snapshot identifies that selection and its available preset settings separately from the main-chat configuration. Diagnostics use the usual Scratch Pad API selection, including the forced-global profile override.

The snapshot uses explicit allowlists. It excludes main-chat history, character and persona names/descriptions, prompt and Author's Note text, lorebook content, regex patterns/replacements, stop-string content, API credentials, server URLs, custom request bodies/headers, and arbitrary extension settings. Relevant configuration labels such as model/preset names are included with bounded lengths and basic credential/URL redaction. Only this diagnostic thread's questions and answers accompany the snapshot; anything you deliberately paste into the discussion is sent as part of it. Snapshots are rebuilt, rather than saved as extra story context.

The assistant diagnoses and recommends manual, reversible changes; it cannot change settings. It cannot inspect server configuration or provider logs, capture the actual main-chat request, prove that a provider honored a setting, or inspect excluded prompt content. Optional module data is marked unavailable when it cannot be read on the installed SillyTavern build. Other extensions and provider-side processing can still alter requests after Scratch Pad constructs them.

Troubleshooting always uses its own instructions, independently of the story OOC prompt and context toggles. The emergency standard-generation toggle does not reroute diagnostic Chat Completion requests through the raw prompt pipeline. Text Completion diagnostics use plain role labels with character instruct formatting disabled; literal macro openers are separated to prevent later expansion. Connection Manager diagnostics also disable instruct formatting. Older diagnostic turns can be trimmed for space; if the fresh snapshot and current question alone do not fit, generation stops with an error before sending.

### Searching Threads

The thread list has a search box with two modes, toggled by the **Text / Semantic** control:

- **Text** (default): instant, offline keyword/fuzzy search over thread titles and message content.
- **Semantic**: embedding-based search that ranks threads by meaning. Searching a paraphrase (e.g. "why did she leave") surfaces threads about a character's departure even if those exact words never appear. Results combine semantic similarity with keyword matches (`0.7 * semantic + 0.3 * keyword`).

Semantic mode requires embeddings to be enabled and configured (see Settings → Semantic Search). The first semantic search embeds missing text in bounded batches; later searches reuse cached vectors while scoring the current threads. New messages are indexed in the background as you go. A replacement query, closing the view, changing embedding settings, or changing the searched history prevents obsolete results from appearing. Identical concurrent embedding requests share work, and cancelling one caller does not cancel another caller that still needs it.

Each title or message variant keeps the existing 8,000-character semantic embedding limit. Text mode remains available for ordinary full-text search. Semantic search includes all saved threads and swipe alternatives in the current chat, including messages outside the currently displayed history page.

### Managing Threads

- **New Thread**: Click the "New Thread" button or send a message from the thread list
- **Open Thread**: Click on any thread to view its conversation
- **Order**: Threads are listed by their most recent message, so the one you're working in stays on top. Renaming a thread or changing its options doesn't move it.
- **Pin Thread**: Click the star on a thread to keep it at the top of the list
- **Rename Thread**: Click the thread name, or use **Rename** / **Rename with AI** in the thread's **⋯** menu
- **Delete Thread**: Click the delete icon on a thread (swipe left on mobile), or use **Delete thread** in the **⋯** menu. It's deleted right away; click the toast to undo.
- **Export / Import**: The thread's **⋯** menu can copy the thread as text or export it as Markdown or JSON. **Import** in the thread list adds threads from a JSON export to the current chat.
- **Clear All**: Use `/sp-clear` to delete all threads (with confirmation)

### Working With Messages

- **Copy**: Every message has a copy button.
- **⋯ menu on a reply**: **Insert into chat input** (adds the reply after anything already typed in the main chat box), **Add to Author's Note**, **Branch from here**, and **Delete**.
- **⋯ menu on your message**: **Branch from here** and **Delete with reply** (your question and the reply to it are deleted together).
- **Branch from here** starts a new thread with a copy of the conversation up to that message, so you can explore a different direction without losing the original.
- Deleted messages can be restored by clicking the toast that appears.

### Quick Prompts

A new or empty thread shows your saved questions. Click one to put it in the input, then edit it or press Enter. Edit the list under **Extensions → Scratch Pad → Quick Prompts** (one per line; macros like `{{char}}` work).

### Checking What Gets Sent

Main-chat history uses labels such as **[Message #42 | Mira]**. These match SillyTavern's visible message IDs, starting at **#0**. Hidden messages, history ranges, and token trimming leave gaps rather than renumbering the included text. The existing history-range controls still use 1-based positions. Swipe comparisons quote the current selected text once in chronological history and refer back to it from the alternatives section; swipe numbers themselves remain 1-based.

Each contextual question includes a short **CHANGES SINCE YOUR PREVIOUS REPLY** notice, calculated by the extension:

- **New**, **Changed**, and **Removed** identify additions, edits/selected-swipe changes, and actual deletions. Removed messages use their previous numbers; the notice explains when surviving messages have been renumbered.
- **Included now** means an existing message was previously omitted. **Not included now** means the message still exists but is outside this request's context. Changing history settings or hitting a token limit does not imply deletion.
- First use says that no previous context is recorded; an unchanged view says so. Legacy replies, missing comparison records, chat/branch switches, lost or duplicated identities, unresolved macros, and ambiguous replacements explicitly report **Previous context unavailable for comparison**. A successful reply establishes a fresh reference.

The current main-chat text takes precedence over older Scratch Pad answers. These notices are reference context: the model should answer your question normally, without writing a change report unless you ask for one. Old main-chat wording is not added to the notice.

The reference follows the selected successful contextual reply in that thread. Generating an alternate Scratch Pad swipe compares against the selected reply it replaces; switching between Scratch Pad swipes restores that swipe's reference. Editing a question uses its preceding reply. A Scratch Pad thread branch retains the copied replies' references. Previews, failed/cancelled requests, empty replies, and raw/general-ask requests do not advance the reference. Selecting Card Only records that main-chat text was omitted.

Comparison records persist with the chat. Successful requests save internal message identities and shared compact hash manifests, not full copies of the story or old message wording; identical contexts share a manifest. The record covers Scratch Pad's processed context after filtering, prompt regex, resolved macros, and token trimming. Later prompt rewrites by another extension are outside this comparison. Simultaneous missing and unfamiliar identities are treated as ambiguous rather than guessed to be an edit or a deletion plus addition.

Under each reply, **Context: 12.3k / 32k tokens** shows how much of the context window its prompt used. If older messages had to be dropped to fit, it says how many (hover for details).

**Context Options → Preview prompt** shows the full prompt the next question would send, with its token count, without sending anything.
- **Unsent Text**: Anything typed but not sent stays in that thread's input (or the New Thread view's) when you switch threads, go back to the list, or close the drawer. It lives in memory only, so it is cleared when you reload the page or switch chats.

### Queuing Messages

While a reply is generating, the Send button becomes **Queue**. Messages you send then wait above the input and go out one at a time, each as its own turn, as soon as the reply ahead of it finishes. Queued messages keep sending even if you switch threads or close the drawer.

Going back to the thread list or reopening the drawer reconnects to a running reply. If a page refresh or navigation interrupts the request, the saved reply shows an interruption message with **Retry** when the chat loads again. An interrupted empty swipe restores the last existing response instead of leaving loading dots.

- **Edit** (✎) pulls a queued message back into the input; **Remove** (✕) drops it.
- If the reply they're waiting on is cancelled or fails, that thread's queued messages are put back into its input instead of being sent, so you can retry or rephrase first. This works even if you're in another thread: the text is waiting in that thread's input, ahead of anything you had typed there, when you open it.
- The queue lives in memory: it is cleared when you switch chats or reload the page.

### Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/scratchpad [message]` | `/sp` | Open scratch pad, or quick-ask with popup if message provided |
| `/sp-ask <question>` | - | Ask a general AI question with no chat, character, author note, or Scratch Pad thread context |
| `/sp-debug [question]` | - | Open a dedicated troubleshooting thread, or ask about configuration with a filtered settings snapshot |
| `/rawprompt <prompt>` | `/rp` | Send a strict raw prompt with no system prompt or injected context |
| `/scratchpad-view` | `/sp-view` | Open scratch pad thread list |
| `/scratchpad-clear` | `/sp-clear` | Delete all threads (with confirmation) |
| `/scratchpad-thread <name>` | `/sp-thread` | Open a specific thread by name or ID |

Use `/sp` for roleplay-aware Scratch Pad questions. Use `/sp-ask` for general assistant questions without roleplay context. Use `/rawprompt` when you want the prompt sent directly without even a general assistant system prompt.

`/sp <message>`, `/sp-debug <question>`, `/sp-ask` and `/rawprompt` return the reply, so you can pipe it into other commands. Add `quiet=true` to skip the popup (the reply is still saved as a thread):

```
/sp quiet=true Summarize the last scene in one sentence | /setvar key=summary
```

## Settings

Access settings in the Extensions panel under "Scratch Pad":

Settings are grouped into six collapsible sections: **General**, **Context defaults**, **Prompts**, **Voice**, **Search**, and **Connection**. General starts open; each header summarizes its current settings and updates as you edit. You can open or close sections with the keyboard using Tab and Enter or Space.

Voice and connection-profile options appear when their feature is enabled. Search shows provider settings when semantic search is enabled and it is using local configuration. Shared embedding settings remain managed in Chat Manager; if Chat Manager has no configuration available, the existing local fallback stays editable. Cached search data remains accessible even when semantic search is off.

Quick questions and custom OOC instructions live in Prompts. Open **Connection → Advanced** for message formatting and emergency generation controls. Context sources and swipe choices are defaults for new threads; existing threads keep their own choices. The history limit and OOC instructions apply to existing threads too. Collapsing sections or hiding inactive options preserves every saved value.

### Context Settings

- **Chat History Limit**: Control how many messages from the main chat are included as context (default: all). Only messages that are actually sent count toward the limit.
- **Swipe Context**: Include alternative swipes of the latest user message, AI message, or both (default: selected swipes only)

### Content Inclusion

- **Include Character Card**: Send character description and personality (default: ON). In a group chat, every member's card is sent (muted members are left out).
- **Include System Prompt**: Send the main system prompt (default: OFF)
- **Include Author's Note**: Send the chat's Author's Note (default: OFF)
- **Include Persona**: Send your persona's description (default: ON). Your messages in the chat history are labelled with your persona name either way.
- **Include World Info**: Send the lorebook entries that the chat history and your question would activate (default: OFF). This is a dry-run scan, so it doesn't affect sticky or cooldown timers in the main chat.
- **Include Chat Summary**: Send the latest summary from SillyTavern's Summarize extension (default: OFF)
- **Include Hidden Messages**: Also send main-chat messages hidden from the AI, e.g. with `/hide` (default: OFF, matching what the main chat's prompt sees)

Global content inclusion settings are used as defaults for new Scratch Pad threads.
Existing threads keep their own context settings, which you can change in each thread's context panel.

### Semantic Search

- **Enable Semantic Search**: Turns on the "Semantic" search mode in the thread list.
- **Use Chat Manager's embedding config**: When on (default), the provider, model, and API key configured in the Chat Manager extension are reused — so if you already use Chat Manager's semantic features, no extra setup is needed. Turn it off to configure a provider/key just for Scratch Pad.
- **Provider / API Key / Model**: OpenRouter (`https://openrouter.ai/api/v1/embeddings`), OpenAI, or a local Ollama instance. Embedding vectors are cached locally (IndexedDB); the cache auto-clears when you change models.
- **Clear Embedding Cache**: Removes cached vectors (e.g. to free space or force a re-embed).

### OOC System Prompt

Customize the instruction that tells the AI how to respond to out-of-character questions. The default prompt instructs the AI to:
- Act as a neutral observer and writing assistant
- Answer questions about story, characters, plot, and setting
- Generate a title for new threads

### Text-to-Speech

Configure a provider and voice map in SillyTavern's TTS extension, then enable **Extensions → Scratch Pad → Voice → Enable TTS**.

- **Auto-generate TTS**: Automatically generate and play speech after each completed reply, including popup responses, retries, edited questions, and newly generated swipes (default: OFF). Streaming replies are spoken once, after completion. Opening saved threads or selecting an existing swipe does not replay it. Commands using `quiet=true` skip automatic speech.
- **Voice Name**: Use a character name from your TTS voice map, or leave it empty for SillyTavern's default selection. The same voice is used for manual and automatic speech.

Speech omits model thinking and non-speech formatting. You can still use each reply's speak button when automatic generation is off.

### API Settings

- **Use Alternative API**: Enable to send scratch pad generations through a Connection Manager profile without changing SillyTavern's active profile
- **Connection Profile**: Select which profile to use when alternative API is enabled. The selected Connection Manager profile carries its own API, model, and preset. Scratch Pad stores the stable profile ID, so renamed profiles keep working.
- **Always Use This Profile**: Force every Scratch Pad generation to use the settings-panel profile, ignoring per-thread API selections.
- **Use Standard Generation (Emergency)**: Applies only to active-API fallback requests. Connection profile requests are sent through Connection Manager.

## How It Works

When you ask a question in the Scratch Pad:

1. The extension gathers context:
   - Your chat history (up to configured limit; hidden messages are skipped)
   - Character card information (if enabled)
   - Your persona, World Info, and the chat summary (if enabled)
   - Previous messages in the current thread
   - The OOC system prompt

2. This context is sent to the AI along with your question

3. The AI generates a response as a neutral assistant, not as any character

4. If the provider returns reasoning, Scratch Pad stores and shows it in a collapsible "Model Thinking" section.  
   For providers/models that hide reasoning text, Scratch Pad shows a "reasoning hidden by provider" indicator instead.

5. The conversation is stored in the chat metadata, separate from the main chat

**Important**: Scratch pad content is never injected into the main chat's context. Your roleplay remains unaffected.

## Data Storage

Scratch pad data is stored in `chatMetadata.scratchPad` for each chat:

- Threads persist when you close and reopen a chat
- When you branch a chat, the new branch inherits all existing threads
- Subsequent activity in either branch stays separate

## Memory and long histories

Version 1.3 displays conversation history in windows of 50 messages. Use **Earlier messages** and **Newer messages** to move through the complete history. Other-branch history creates message elements only while expanded and uses the same bounded paging. Paging changes what is rendered; it does not remove saved messages, swipes, or export content.

Every drawer and fullscreen close releases the conversation DOM, thread-list results, listeners, viewport subscriptions, and search work. Drafts and an already-running reply remain available when the view is reopened. Scratch Pad works without a shared runtime extension; compatible viewport subscriptions are optional, with native browser events as the fallback.

Semantic scoring retains vectors for a small batch at a time instead of building a complete in-memory vector index. Provider requests contain at most 32 texts and allow at most two concurrent batches. Vectors use compact Float32 storage. If persistent browser cache operations fail, the derived embedding cache falls back to a 16 MiB memory budget; original thread text remains in chat metadata. Cached inputs can be evicted and embedded again later.

Deleting messages, swipes, or threads also prunes context-comparison manifests that are no longer referenced, while Undo restores the manifests it needs. Branching copies mutable structures independently and reuses immutable text values without changing history or JSON export semantics. The authoritative saved threads still reside in chat metadata, so their memory grows with retained history; this release does not introduce a shared persistent branch-history format.

### Development checks

Run `node --test --test-isolation=none tests/*.test.mjs` with a recent Node.js release. The regression suite covers close/reopen, complete paged history, independent/partial runtime environments, search cancellation and in-place edits, bounded embedding batches, blocked-cache fallback, provider changes, Undo, branches, and exports. Browser memory and mobile/Firefox layout acceptance remain separate checks; no fixed RAM reduction is implied by the automated results.

## Keyboard Shortcuts

- **Enter**: Send message, or queue it while a reply is generating (Shift+Enter for new line)
- **Escape**: Close scratch pad or dismiss popup. If a dialog, menu, or message edit is open, Escape closes just that.

## Troubleshooting

### "Open a chat to use Scratch Pad"
The extension requires an active chat. Open or create a chat first.

### Responses seem incomplete
Check your API's context and token limits. The scratch pad uses additional context for chat history and character information.

### Thread not saving
Ensure you have write permissions to your SillyTavern data directory. Check the browser console for errors.

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.

