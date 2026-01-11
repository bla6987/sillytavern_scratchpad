# SillyTavern Scratch Pad Extension - Implementation Specification

## Overview

Create a SillyTavern extension called **"Scratch Pad"** that enables out-of-character (OOC) meta-conversations with the AI about the current roleplay. Users can ask questions about character motivations, plot details, "what if" scenarios, request summaries, or discuss the story — all without breaking immersion in the main chat. The AI generates responses using the main chat history as context, and all Q&A is stored in a separate scratch pad that doesn't pollute the main conversation.

## Core Functionality

### Purpose
- Allow users to have meta-discussions about their roleplay with AI assistance
- Keep OOC questions and analysis separate from the in-character chat
- Provide threaded conversations for organizing different lines of inquiry
- Persist across sessions and inherit properly when branching chats

### What Gets Sent to the AI
- The main chat history (up to user-configured context limit)
- The character card (by default, toggleable)
- The system prompt (optional, toggleable)
- Previous messages in the current scratch pad thread (for continuity)
- A customizable OOC system instruction
- The user's question

### What Does NOT Happen
- Scratch pad content is never injected into the main chat's AI context
- Main chat history is not modified by scratch pad interactions
- No group chat support required

## Suggested Implementation Order

1. Scaffold: manifest.json, index.js with empty init, basic CSS
2. Storage: Initialize chatMetadata structure, CRUD functions for threads/messages
3. Settings panel: HTML template + settings.js (get this working early to test toggles)
4. Slash commands: Register /sp, /sp-view, /sp-clear with stub handlers
5. Thread List UI: Basic drawer, render threads, open/close
6. Conversation UI: Message display, input field, back navigation
7. Generation (non-streaming): Get a response working end-to-end
8. Streaming: Add streaming support
9. Thread naming: Parse title from response
10. Popup mode: Bottom sheet for /sp <message>
11. Error handling & retry
12. Profile switching
13. Mobile polish

---

## Data Structure

Store in `chatMetadata.scratchPad` using the following structure:

```javascript
{
  settings: {
    // Per-chat settings overrides (optional)
  },
  threads: [
    {
      id: string,              // Unique identifier (e.g., UUID or timestamp-based)
      name: string,            // AI-generated or user-renamed thread title
      createdAt: string,       // ISO timestamp
      updatedAt: string,       // ISO timestamp (last activity)
      messages: [
        {
          id: string,
          role: 'user' | 'assistant',
          content: string,
          timestamp: string,
          status: 'complete' | 'pending' | 'failed'  // For retry functionality
        }
      ]
    }
  ]
}
```

### Branching Behavior
Branching is handled automatically via `chatMetadata`:
- When a user creates a branch, the child chat copies the parent's entire scratch pad
- Subsequent scratch pad activity in the child stays in the child only
- Further branches from the child include the child's accumulated threads

---

## User Interface

The UI must work well on both desktop and mobile. Use a **full-screen drawer** sliding in from the right (consistent with ST's mobile panels) rather than a centered modal. Thread list and conversation view should be **separate screens** (not side-by-side) with back navigation between them.

### General UI Requirements

#### Touch & Interaction
- All buttons and interactive elements must be minimum 44x44px touch targets
- Thread list items should have generous padding for easy tapping
- Delete/edit icons should be spaced apart to prevent mis-taps
- Consider swipe-to-delete on thread list items (with confirmation)

#### Input Handling
- Input field should be **fixed to bottom** of viewport, above keyboard when active
- When keyboard appears, conversation should scroll to keep latest content visible
- Auto-focus input field when opening conversation view (brings up keyboard immediately)
- "Send" button should be clearly tappable, not just an icon

#### Viewport & Keyboard
- Use `visualViewport` API to handle keyboard resize events
- Prevent body scroll when scratch pad is open (avoid background scrolling)
- Handle orientation changes gracefully (maintain scroll position, re-layout)

#### Performance
- Limit DOM nodes: For threads with 50+ messages, implement virtual scrolling or "Load more" pagination
- Debounce input events
- Use CSS transforms for animations (GPU-accelerated)
- Lazy-load thread content (only load full messages when thread is opened)

#### Visual Distinction
- Scratch pad UI should be visually distinct from main chat
- Use a different background color or border treatment
- Clear "Out of Character" labeling
- Possibly a different font or styling to reinforce separation

#### Accessibility
- All interactive elements should be keyboard navigable
- Proper ARIA labels on buttons and inputs
- Clear focus indicators

---

### Thread List View (Scratch Pad Home)

Displayed when user opens scratch pad without providing a message.

#### Layout
- Header: "Scratch Pad - Out of Character" with close button
- Top action bar: "➕ New Thread" button
- Thread list: Card/row for each thread showing:
  - Thread name (tap to open rename dialog)
  - Preview of last message (truncated)
  - Timestamp of last activity
  - Delete button (with confirmation)
- Empty state: "No threads yet. Start a conversation to create one."
- Input field fixed at bottom: Text area + Send button to quick-start a new thread

#### Interactions
- Tap thread → Opens that thread's conversation view
- Tap "New Thread" → Opens conversation view with empty state, ready for input
- Tap delete → Confirmation dialog → Removes thread
- Tap thread name → Opens rename dialog (modal with text input, keyboard focused, current name pre-filled)
- Swipe left on thread (optional) → Reveals delete action

---

### Conversation View (Inside a Thread)

Displayed when viewing/interacting with a specific thread.

#### Layout
- Header: Thread name (tappable to rename) + back button to thread list + close button
- Message area: Chat-like display of user questions and AI responses
  - User messages: Right-aligned or distinct styling
  - AI messages: Left-aligned, supports markdown rendering
  - Timestamps on each message
  - Failed messages: Show error indicator + "Retry" button
- Input area fixed at bottom: Text field + Send button
- Loading state: Show streaming response with typing indicator

#### Interactions
- Send message → Streams AI response into view
- Retry button on failed message → Re-attempts generation
- Back button → Returns to thread list
- Tap thread name in header → Opens rename dialog

#### Streaming Behavior
- Responses should stream in real-time (not appear all at once)
- Auto-scroll to follow streaming content
- Streaming text should be scrollable if it exceeds viewport

---

### Popup Mode

Triggered when user sends `/sp <message>` with a message included.

#### Behavior
- Creates new thread automatically
- Shows dismissible popup using **bottom sheet pattern** (slides up from bottom covering ~60-70% of screen)
- Swipe down to dismiss
- Content includes:
  - Streaming AI response
  - Thread name (once generated/parsed)
  - Large, clearly labeled "Open in Scratch Pad" button to continue conversation
  - Large, clearly labeled "Dismiss" button to close
- After dismissal, thread persists and is accessible from main scratch pad UI
- Streaming text should be scrollable within the popup

---

## Slash Commands

Register using `SlashCommandParser.addCommandObject()`:

| Command | Aliases | Arguments | Behavior |
|---------|---------|-----------|----------|
| `/scratchpad` | `/sp` | `[message]` (optional) | If message provided: Create new thread, generate response, show popup. If no message: Open scratch pad UI (thread list view) |
| `/scratchpad-view` | `/sp-view` | None | Open scratch pad UI (thread list view) |
| `/scratchpad-clear` | `/sp-clear` | None | Clear ALL threads (with confirmation prompt) |
| `/scratchpad-thread` | `/sp-thread` | `[thread_id or name]` | Open specific thread by ID or fuzzy name match |

### Example Usage
```
/sp What is the character's motivation for betraying the protagonist?
→ Creates thread, generates response, shows popup

/sp
→ Opens scratch pad UI

/sp-view
→ Opens scratch pad UI

/sp-clear
→ "Are you sure you want to delete all scratch pad threads? This cannot be undone." [Yes] [No]
```

---

## Extension Settings

Located in the Extensions panel under "Scratch Pad".

### Context Settings
- **Chat History Limit**: Slider (0 to max context, or "Use API default")
  - Label: "Maximum chat messages to include"
  - Default: Use current API's context settings
  - Shows approximate token count if possible

### Content Inclusion
- **Include Character Card**: Toggle (default: ON)
  - "Send character description and personality to the AI"
- **Include System Prompt**: Toggle (default: OFF)
  - "Send the main system prompt to the AI"

### OOC System Prompt
- **Default OOC Instruction**: Multiline text area
  - Default value:
    ```
    You are a neutral observer and writing assistant helping the user understand and analyze their ongoing roleplay. Answer out-of-character questions about the story, characters, plot, or setting. Be direct, insightful, and helpful. Do not roleplay as any character — respond as an objective assistant.
    
    At the very beginning of your first response in a new conversation, provide a brief title (3-6 words) for this discussion on its own line, formatted as: **Title: [Your Title Here]**
    
    Then provide your response.
    ```
  - "Reset to Default" button

### API Settings
- **Use Alternative API**: Toggle (default: OFF)
  - When enabled, shows Connection Profile dropdown
- **Connection Profile**: Dropdown (only visible when above is ON)
  - Lists available connection profiles from SillyTavern's Connection Profiles system
  - "Select a profile for scratch pad generations"

---

## Generation Logic

### Building the Prompt

```javascript
async function generateScratchPadResponse(userQuestion, thread) {
    const context = SillyTavern.getContext();
    const { chat, chatMetadata, characters, characterId } = context;
    const settings = getExtensionSettings();
    
    // 1. Build OOC system instruction
    const oocSystemPrompt = settings.oocSystemPrompt;
    
    // 2. Gather character card (if enabled)
    let characterContext = '';
    if (settings.includeCharacterCard && characterId !== undefined) {
        const char = characters[characterId];
        characterContext = buildCharacterContext(char); // name, description, personality, scenario
    }
    
    // 3. Gather main system prompt (if enabled)
    let mainSystemPrompt = '';
    if (settings.includeSystemPrompt) {
        mainSystemPrompt = getCurrentSystemPrompt(); // However ST exposes this
    }
    
    // 4. Gather chat history (respecting context limit)
    const maxMessages = settings.chatHistoryLimit || chat.length;
    const chatHistory = formatChatHistory(chat.slice(-maxMessages));
    
    // 5. Gather thread history (full thread for continuity)
    const threadHistory = formatThreadHistory(thread.messages);
    
    // 6. Construct final prompt
    // This will vary based on whether using generateQuietPrompt or generateRaw
    // and whether the API is Chat Completion or Text Completion
}
```

### Thread Naming

The AI generates the thread name as part of its first response. The OOC system prompt instructs it to begin with:
```
**Title: [Thread Name Here]**
```

After receiving the response:
1. Parse out the title line using regex: `/^\*\*Title:\s*(.+?)\*\*\s*/m`
2. Extract the title, remove that line from displayed response
3. Set `thread.name` to the extracted title
4. If parsing fails, fall back to first ~30 chars of user's question + "..."

### Switching Connection Profiles

If user has enabled alternative API, use SillyTavern's Connection Profiles system:

```javascript
async function generateWithProfile(profileName, generateFn) {
    const currentProfile = await executeSlashCommand('/profile');
    
    try {
        await executeSlashCommand(`/profile ${profileName}`);
        const result = await generateFn();
        return result;
    } finally {
        // Restore original profile
        await executeSlashCommand(`/profile ${currentProfile}`);
    }
}
```

If no alternative is configured, use the current API settings.

### Error Handling

```javascript
try {
    // Add user message immediately
    // Add AI message placeholder with 'pending' status
    const response = await generateResponse(/*...*/);
    
    // Parse title if first message in thread
    // Update AI message with content
    message.status = 'complete';
    await saveMetadata();
} catch (error) {
    // Mark message as failed
    message.status = 'failed';
    message.error = error.message;
    await saveMetadata();
    // UI shows retry button
}
```

---

## Events to Handle

```javascript
// When chat changes, refresh scratch pad if open
eventSource.on(event_types.CHAT_CHANGED, () => {
    if (scratchPadIsOpen) {
        refreshScratchPadUI();
    }
});

// Initialize scratch pad data structure if missing
function ensureScratchPadExists() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata.scratchPad) {
        chatMetadata.scratchPad = {
            settings: {},
            threads: []
        };
    }
}
```

---

## File Structure

```
SillyTavern-ScratchPad/
├── manifest.json
├── index.js              // Main entry, initialization, event handlers
├── src/
│   ├── settings.js       // Extension settings management
│   ├── storage.js        // chatMetadata operations, thread CRUD
│   ├── generation.js     // AI generation, prompt building, profile switching
│   ├── ui/
│   │   ├── threadList.js   // Thread list view component
│   │   ├── conversation.js // Conversation view component  
│   │   ├── popup.js        // Popup/bottom sheet mode for quick responses
│   │   └── components.js   // Shared UI components (buttons, inputs, etc.)
│   └── commands.js       // Slash command registration
├── style.css             // All styling
├── settings.html         // Settings panel template
└── README.md
```

---

## Manifest

```json
{
    "display_name": "Scratch Pad",
    "loading_order": 100,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "Your Name",
    "version": "1.0.0",
    "homePage": "https://github.com/...",
    "auto_update": true
}
```

---

## Edge Cases

1. **No active chat**: Show message "Open a chat to use Scratch Pad"

2. **Empty chat history**: Allow usage but warn that limited context is available

3. **Very long threads**: Implement virtual scrolling or "Load more" pagination for threads with 50+ messages

4. **Concurrent generations**: Disable send button while generation is in progress

5. **API disconnected**: Show appropriate error, allow retry when reconnected

6. **Profile switching fails**: Fall back to current API, show warning toast

7. **chatMetadata doesn't persist**: Ensure `saveMetadata()` is called after every modification

8. **Thread name parsing fails**: Fall back to truncated user question as thread name

9. **Orientation change on mobile**: Maintain scroll position, re-layout gracefully

10. **Keyboard appearance**: Scroll conversation to keep context visible, input stays above keyboard

---

## Testing Considerations

1. Verify thread creation and storage persists correctly
2. Verify branching inherits scratch pad correctly (parent unchanged, child has copy)
3. Test with various API types (Chat Completion, Text Completion)
4. Test profile switching and restoration
5. Test streaming response display and auto-scroll
6. Test retry functionality on failed generations
7. Test thread rename (via dialog) and delete (with confirmation)
8. Test context limit slider behavior
9. Verify no scratch pad content leaks into main chat context
10. Test on mobile devices:
    - Touch targets are appropriately sized
    - Keyboard handling works correctly
    - Bottom sheet popup is dismissible via swipe
    - Drawer navigation works smoothly
    - Performance with many threads/messages
11. Test empty states and edge cases
12. Test slash command behavior (with and without message argument)
