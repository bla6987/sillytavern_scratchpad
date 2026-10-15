# SillyTavern Scratch Pad Extension

A SillyTavern extension that enables out-of-character (OOC) meta-conversations with the AI about your current roleplay. Ask questions about character motivations, plot details, "what if" scenarios, request summaries, or discuss the story — all without breaking immersion in the main chat.

## Features

- **Meta Conversations**: Have OOC discussions about your roleplay without affecting the main chat
- **Threaded Discussions**: Organize different lines of inquiry into separate threads
- **Semantic Search**: Search threads by *meaning*, not just keywords, using embeddings (OpenRouter / OpenAI / Ollama). Reuses the Chat Manager extension's embedding key by default.
- **Full Context**: AI responses are informed by your chat history, character cards (every member in group chats), your persona, and optionally World Info and the chat summary
- **Context Usage**: Each reply shows how many tokens its prompt used and whether older messages were trimmed to fit; **Preview prompt** shows exactly what the next question would send
- **Swipe Analysis**: Compare alternative swipes of the latest main-chat user message, AI message, or both
- **Streaming Responses**: Watch AI responses generate in real-time
- **Message Queue**: Keep typing while a reply generates — messages you send are queued and sent in order as each reply finishes
- **Reasoning Capture**: Captures model reasoning/thinking for supported SillyTavern provider formats and configured reasoning tags
- **Mobile Friendly**: Full-screen drawer UI with touch support and bottom sheet popups
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

### Searching Threads

The thread list has a search box with two modes, toggled by the **Text / Semantic** control:

- **Text** (default): instant, offline keyword/fuzzy search over thread titles and message content.
- **Semantic**: embedding-based search that ranks threads by meaning. Searching a paraphrase (e.g. "why did she leave") surfaces threads about a character's departure even if those exact words never appear. Results combine semantic similarity with keyword matches (`0.7 * semantic + 0.3 * keyword`).

Semantic mode requires embeddings to be enabled and configured (see Settings → Semantic Search). The first semantic search in a chat embeds the threads (cached afterward, so repeats are instant); new messages are indexed in the background as you go.

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

Under each reply, **Context: 12.3k / 32k tokens** shows how much of the context window its prompt used. If older messages had to be dropped to fit, it says how many (hover for details).

**Context Options → Preview prompt** shows the full prompt the next question would send, with its token count, without sending anything.
- **Unsent Text**: Anything typed but not sent stays in that thread's input (or the New Thread view's) when you switch threads, go back to the list, or close the drawer. It lives in memory only, so it is cleared when you reload the page or switch chats.

### Queuing Messages

While a reply is generating, the Send button becomes **Queue**. Messages you send then wait above the input and go out one at a time, each as its own turn, as soon as the reply ahead of it finishes. Queued messages keep sending even if you switch threads or close the drawer.

- **Edit** (✎) pulls a queued message back into the input; **Remove** (✕) drops it.
- If the reply they're waiting on is cancelled or fails, that thread's queued messages are put back into its input instead of being sent, so you can retry or rephrase first. This works even if you're in another thread: the text is waiting in that thread's input, ahead of anything you had typed there, when you open it.
- The queue lives in memory: it is cleared when you switch chats or reload the page.

### Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/scratchpad [message]` | `/sp` | Open scratch pad, or quick-ask with popup if message provided |
| `/sp-ask <question>` | - | Ask a general AI question with no chat, character, author note, or Scratch Pad thread context |
| `/rawprompt <prompt>` | `/rp` | Send a strict raw prompt with no system prompt or injected context |
| `/scratchpad-view` | `/sp-view` | Open scratch pad thread list |
| `/scratchpad-clear` | `/sp-clear` | Delete all threads (with confirmation) |
| `/scratchpad-thread <name>` | `/sp-thread` | Open a specific thread by name or ID |

Use `/sp` for roleplay-aware Scratch Pad questions. Use `/sp-ask` for general assistant questions without roleplay context. Use `/rawprompt` when you want the prompt sent directly without even a general assistant system prompt.

`/sp <message>`, `/sp-ask` and `/rawprompt` return the reply, so you can pipe it into other commands. Add `quiet=true` to skip the popup (the reply is still saved as a thread):

```
/sp quiet=true Summarize the last scene in one sentence | /setvar key=summary
```

## Settings

Access settings in the Extensions panel under "Scratch Pad":

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
