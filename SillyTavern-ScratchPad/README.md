# SillyTavern Scratch Pad Extension

A SillyTavern extension that enables out-of-character (OOC) meta-conversations with the AI about your current roleplay. Ask questions about character motivations, plot details, "what if" scenarios, request summaries, or discuss the story — all without breaking immersion in the main chat.

## Features

- **Meta Conversations**: Have OOC discussions about your roleplay without affecting the main chat
- **Threaded Discussions**: Organize different lines of inquiry into separate threads
- **Full Context**: AI responses are informed by your chat history and character information
- **Streaming Responses**: Watch AI responses generate in real-time
- **Mobile Friendly**: Full-screen drawer UI with touch support and bottom sheet popups
- **Persistent Storage**: Threads are saved with your chat and inherit properly when branching
- **Quick Access**: Use `/sp <question>` for quick popup responses

## Installation

1. Open SillyTavern and navigate to the Extensions panel
2. Click "Install Extension"
3. Enter the repository URL: `https://github.com/SillyTavern/SillyTavern-ScratchPad`
4. Click "Save" and reload SillyTavern

Alternatively, clone the repository directly into your SillyTavern extensions folder:

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/SillyTavern/SillyTavern-ScratchPad
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

This creates a new thread and shows a popup with the AI's response. You can dismiss the popup or open it in the full Scratch Pad interface to continue the conversation.

### Managing Threads

- **New Thread**: Click the "New Thread" button or send a message from the thread list
- **Open Thread**: Click on any thread to view its conversation
- **Rename Thread**: Click on the thread name (in either list or conversation view)
- **Delete Thread**: Click the delete icon on a thread (swipe left on mobile)
- **Clear All**: Use `/sp-clear` to delete all threads (with confirmation)

### Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/scratchpad [message]` | `/sp` | Open scratch pad, or quick-ask with popup if message provided |
| `/scratchpad-view` | `/sp-view` | Open scratch pad thread list |
| `/scratchpad-clear` | `/sp-clear` | Delete all threads (with confirmation) |
| `/scratchpad-thread <name>` | `/sp-thread` | Open a specific thread by name or ID |

## Settings

Access settings in the Extensions panel under "Scratch Pad":

### Context Settings

- **Chat History Limit**: Control how many messages from the main chat are included as context (default: all)

### Content Inclusion

- **Include Character Card**: Send character description and personality (default: ON)
- **Include System Prompt**: Send the main system prompt (default: OFF)

### OOC System Prompt

Customize the instruction that tells the AI how to respond to out-of-character questions. The default prompt instructs the AI to:
- Act as a neutral observer and writing assistant
- Answer questions about story, characters, plot, and setting
- Generate a title for new threads

### API Settings

- **Use Alternative API**: Enable to use a different connection profile for scratch pad generations
- **Connection Profile**: Select which profile to use when alternative API is enabled

## How It Works

When you ask a question in the Scratch Pad:

1. The extension gathers context:
   - Your chat history (up to configured limit)
   - Character card information (if enabled)
   - Previous messages in the current thread
   - The OOC system prompt

2. This context is sent to the AI along with your question

3. The AI generates a response as a neutral assistant, not as any character

4. The conversation is stored in the chat metadata, separate from the main chat

**Important**: Scratch pad content is never injected into the main chat's context. Your roleplay remains unaffected.

## Data Storage

Scratch pad data is stored in `chatMetadata.scratchPad` for each chat:

- Threads persist when you close and reopen a chat
- When you branch a chat, the new branch inherits all existing threads
- Subsequent activity in either branch stays separate

## Keyboard Shortcuts

- **Enter**: Send message (Shift+Enter for new line)
- **Escape**: Close scratch pad or dismiss popup

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
