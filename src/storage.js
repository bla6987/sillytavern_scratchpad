/**
 * Storage module for Scratch Pad extension
 * Handles chatMetadata operations and thread CRUD
 */

import { createReasoningMeta, normalizeReasoningMeta } from './reasoning.js';

const MODULE_NAME = 'scratchPad';

/**
 * Default context settings for threads
 * These determine what context is sent to the AI
 */
export const DEFAULT_CONTEXT_SETTINGS = Object.freeze({
    chatHistoryRangeMode: 'all',
    chatHistoryRangeStart: null,
    chatHistoryRangeEnd: null,
    characterCardOnly: false,
    includeCharacterCard: true,
    includeSystemPrompt: false,
    includeAuthorsNote: false,
    connectionProfile: null
});

/**
 * Generate a unique ID for threads and messages
 * @returns {string} Unique identifier
 */
export function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get the current timestamp in ISO format
 * @returns {string} ISO timestamp
 */
export function getTimestamp() {
    return new Date().toISOString();
}

/**
 * Ensure scratch pad data structure exists in chatMetadata
 * @returns {Object} The scratch pad data object
 */
export function ensureScratchPadExists() {
    const { chatMetadata } = SillyTavern.getContext();

    if (!chatMetadata) {
        return null;
    }

    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            settings: {},
            threads: []
        };
    }

    return chatMetadata[MODULE_NAME];
}

/**
 * Get the scratch pad data from current chat
 * @returns {Object|null} Scratch pad data or null if no chat active
 */
export function getScratchPadData() {
    const { chatMetadata } = SillyTavern.getContext();

    if (!chatMetadata) {
        return null;
    }

    return chatMetadata[MODULE_NAME] || null;
}

/**
 * Save the current chat metadata to server
 */
export async function saveMetadata() {
    const { saveMetadata: saveMeta } = SillyTavern.getContext();
    await saveMeta();
}

/**
 * Get all threads from current chat
 * @returns {Array} Array of threads
 */
export function getThreads() {
    const data = ensureScratchPadExists();
    return data ? data.threads : [];
}

/**
 * Get a specific thread by ID
 * @param {string} threadId Thread ID
 * @returns {Object|null} Thread object or null
 */
export function getThread(threadId) {
    const threads = getThreads();
    return threads.find(t => t.id === threadId) || null;
}

/**
 * Find a thread by fuzzy name match
 * @param {string} searchName Name to search for
 * @returns {Object|null} Best matching thread or null
 */
export function findThreadByName(searchName) {
    const threads = getThreads();
    const searchLower = searchName.toLowerCase();

    // Exact match first
    let match = threads.find(t => t.name.toLowerCase() === searchLower);
    if (match) return match;

    // Partial match
    match = threads.find(t => t.name.toLowerCase().includes(searchLower));
    if (match) return match;

    // Fuzzy match using Fuse if available
    const { Fuse } = SillyTavern.libs;
    if (Fuse && threads.length > 0) {
        const fuse = new Fuse(threads, {
            keys: ['name'],
            threshold: 0.4
        });
        const results = fuse.search(searchName);
        if (results.length > 0) {
            return results[0].item;
        }
    }

    return null;
}

/**
 * Create a new thread
 * @param {string} [name] Optional thread name
 * @param {Object} [contextSettings] Optional initial context settings
 * @returns {Object} The created thread
 */
export function createThread(name = 'New Thread', contextSettings = null) {
    const data = ensureScratchPadExists();
    if (!data) {
        return null;
    }

    const timestamp = getTimestamp();
    const thread = {
        id: generateId(),
        name: name,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
        contextSettings: contextSettings ? { ...contextSettings } : null,
        titled: false
    };

    data.threads.unshift(thread);
    return thread;
}

/**
 * Update a thread's properties
 * @param {string} threadId Thread ID
 * @param {Object} updates Properties to update
 * @returns {Object|null} Updated thread or null
 */
export function updateThread(threadId, updates) {
    const thread = getThread(threadId);
    if (!thread) return null;

    Object.assign(thread, updates, { updatedAt: getTimestamp() });
    return thread;
}

/**
 * Delete a thread
 * @param {string} threadId Thread ID
 * @returns {boolean} Success status
 */
export function deleteThread(threadId) {
    const data = getScratchPadData();
    if (!data) return false;

    const index = data.threads.findIndex(t => t.id === threadId);
    if (index === -1) return false;

    data.threads.splice(index, 1);
    return true;
}

/**
 * Clear all threads
 * @returns {boolean} Success status
 */
export function clearAllThreads() {
    const data = getScratchPadData();
    if (!data) return false;

    data.threads = [];
    return true;
}

/**
 * Add a message to a thread
 * @param {string} threadId Thread ID
 * @param {string} role 'user' or 'assistant'
 * @param {string} content Message content
 * @param {string} [status='complete'] Message status
 * @param {number|null} [chatMessageIndex=null] Chat message index when created (for branch filtering)
 * @returns {Object|null} Created message or null
 */
export function addMessage(threadId, role, content, status = 'complete', chatMessageIndex = null) {
    const thread = getThread(threadId);
    if (!thread) return null;

    // Capture current chat length if not provided
    let messageIndex = chatMessageIndex;
    if (messageIndex === null) {
        const { chat } = SillyTavern.getContext();
        messageIndex = chat ? chat.length : null;
    }

    const message = {
        id: generateId(),
        role: role,
        content: content,
        timestamp: getTimestamp(),
        status: status,
        chatMessageIndex: messageIndex
    };

    if (role === 'assistant') {
        message.thinking = null;
        message.reasoningMeta = createReasoningMeta();
    }

    thread.messages.push(message);
    thread.updatedAt = getTimestamp();

    return message;
}

/**
 * Update a message in a thread
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @param {Object} updates Properties to update
 * @returns {Object|null} Updated message or null
 */
export function updateMessage(threadId, messageId, updates) {
    const thread = getThread(threadId);
    if (!thread) return null;

    const message = thread.messages.find(m => m.id === messageId);
    if (!message) return null;

    Object.assign(message, updates);
    thread.updatedAt = getTimestamp();

    return message;
}

/**
 * Get a message from a thread
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @returns {Object|null} Message object or null
 */
export function getMessage(threadId, messageId) {
    const thread = getThread(threadId);
    if (!thread) return null;

    return thread.messages.find(m => m.id === messageId) || null;
}

/**
 * Delete a message from a thread
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @returns {boolean} Success status
 */
export function deleteMessage(threadId, messageId) {
    const thread = getThread(threadId);
    if (!thread) return false;

    const index = thread.messages.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    thread.messages.splice(index, 1);
    thread.updatedAt = getTimestamp();

    return true;
}

/**
 * Get context settings for a thread
 * Returns the thread's settings merged with defaults for any missing values
 * @param {string} threadId Thread ID
 * @returns {Object} Context settings
 */
export function getThreadContextSettings(threadId) {
    const thread = getThread(threadId);
    if (!thread || !thread.contextSettings) {
        return { ...DEFAULT_CONTEXT_SETTINGS };
    }
    return { ...DEFAULT_CONTEXT_SETTINGS, ...thread.contextSettings };
}

/**
 * Update context settings for a thread
 * @param {string} threadId Thread ID
 * @param {Object} updates Settings to update
 * @returns {Object|null} Updated settings or null if thread not found
 */
export function updateThreadContextSettings(threadId, updates) {
    const thread = getThread(threadId);
    if (!thread) return null;

    if (!thread.contextSettings) {
        thread.contextSettings = { ...DEFAULT_CONTEXT_SETTINGS };
    }

    Object.assign(thread.contextSettings, updates);
    thread.updatedAt = getTimestamp();

    return thread.contextSettings;
}

/**
 * Get the current chat length
 * @returns {number|null} Current chat length or null if no chat
 */
export function getCurrentChatLength() {
    const { chat } = SillyTavern.getContext();
    return chat ? chat.length : null;
}

/**
 * Get a thread filtered for the current branch
 * Messages created after the current chat length are hidden
 * @param {string} threadId Thread ID
 * @returns {Object|null} Thread with filtered messages or null
 */
export function getThreadForCurrentBranch(threadId) {
    const thread = getThread(threadId);
    if (!thread) return null;

    const currentLength = getCurrentChatLength();
    if (currentLength === null) return thread;

    // Filter messages - keep legacy (no index) or those within current chat
    const filteredMessages = [];
    const branchedMessages = [];
    for (const msg of thread.messages) {
        if (msg.chatMessageIndex === undefined || msg.chatMessageIndex === null) {
            filteredMessages.push(msg);  // Legacy messages always shown
        } else if (msg.chatMessageIndex <= currentLength) {
            filteredMessages.push(msg);
        } else {
            branchedMessages.push(msg);
        }
    }

    return { ...thread, messages: filteredMessages, branchedMessages };
}

/**
 * Ensure swipe fields exist on an assistant message (lazy migration)
 * Creates swipes/swipeThinking/swipeTimestamps/swipeId from existing content if not present
 * @param {Object} message Message object
 * @returns {Object} The message (mutated in place)
 */
export function ensureSwipeFields(message) {
    if (!message || message.role !== 'assistant') return message;

    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [message.content || ''];
    }

    if (!Array.isArray(message.swipeThinking)) {
        message.swipeThinking = message.swipes.map(() => null);
    }
    while (message.swipeThinking.length < message.swipes.length) {
        message.swipeThinking.push(null);
    }
    if (message.swipeThinking.length > message.swipes.length) {
        message.swipeThinking = message.swipeThinking.slice(0, message.swipes.length);
    }

    if (!Array.isArray(message.swipeTimestamps)) {
        message.swipeTimestamps = message.swipes.map(() => message.timestamp || getTimestamp());
    }
    while (message.swipeTimestamps.length < message.swipes.length) {
        message.swipeTimestamps.push(getTimestamp());
    }
    if (message.swipeTimestamps.length > message.swipes.length) {
        message.swipeTimestamps = message.swipeTimestamps.slice(0, message.swipes.length);
    }

    if (!Number.isInteger(message.swipeId)) {
        message.swipeId = 0;
    }
    message.swipeId = Math.max(0, Math.min(message.swipeId, message.swipes.length - 1));

    if (!message.swipeThinking[message.swipeId] && message.thinking) {
        message.swipeThinking[message.swipeId] = message.thinking;
    }

    if (!Array.isArray(message.swipeReasoningMeta)) {
        message.swipeReasoningMeta = message.swipeThinking.map(() => null);
    }
    while (message.swipeReasoningMeta.length < message.swipes.length) {
        message.swipeReasoningMeta.push(null);
    }
    if (message.swipeReasoningMeta.length > message.swipes.length) {
        message.swipeReasoningMeta = message.swipeReasoningMeta.slice(0, message.swipes.length);
    }

    message.swipeReasoningMeta = message.swipeReasoningMeta.map((meta, idx) => {
        const fallback = message.swipeThinking[idx] || null;
        if (idx === message.swipeId && message.reasoningMeta) {
            return normalizeReasoningMeta(message.reasoningMeta, fallback);
        }
        return normalizeReasoningMeta(meta, fallback);
    });

    message.reasoningMeta = normalizeReasoningMeta(
        message.swipeReasoningMeta[message.swipeId],
        message.swipeThinking[message.swipeId] || null,
    );

    return message;
}

/**
 * Copy active swipe data to message top-level fields (backward compat)
 * @param {Object} message Message object
 */
export function syncSwipeToMessage(message) {
    if (!message || !message.swipes) return;

    const idx = message.swipeId ?? 0;
    message.content = message.swipes[idx] ?? '';
    message.thinking = message.swipeThinking?.[idx] ?? null;
    message.reasoningMeta = normalizeReasoningMeta(message.swipeReasoningMeta?.[idx], message.thinking);
    message.timestamp = message.swipeTimestamps?.[idx] ?? message.timestamp;
}

/**
 * Add a new swipe to an assistant message
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @param {string} content Swipe content
 * @param {string|null} thinking Thinking content
 * @param {string} timestamp ISO timestamp
 * @param {Object|null} reasoningMeta Reasoning metadata
 * @returns {Object|null} Updated message or null
 */
export function addSwipe(threadId, messageId, content, thinking = null, timestamp = null, reasoningMeta = null) {
    const message = getMessage(threadId, messageId);
    if (!message) return null;

    ensureSwipeFields(message);

    const ts = timestamp || getTimestamp();
    message.swipes.push(content);
    message.swipeThinking.push(thinking);
    message.swipeReasoningMeta.push(normalizeReasoningMeta(reasoningMeta, thinking));
    message.swipeTimestamps.push(ts);
    message.swipeId = message.swipes.length - 1;

    syncSwipeToMessage(message);

    const thread = getThread(threadId);
    if (thread) thread.updatedAt = getTimestamp();

    return message;
}

/**
 * Set the active swipe index and sync to top-level fields
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @param {number} index Swipe index
 * @returns {Object|null} Updated message or null
 */
export function setActiveSwipe(threadId, messageId, index) {
    const message = getMessage(threadId, messageId);
    if (!message) return null;

    ensureSwipeFields(message);
    if (!message.swipes) return null;

    if (index < 0 || index >= message.swipes.length) return null;

    message.swipeId = index;
    syncSwipeToMessage(message);

    return message;
}

/**
 * Delete a swipe from an assistant message
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID
 * @param {number} index Swipe index to delete
 * @returns {Object} { empty: true } if no swipes left, or updated message
 */
export function deleteSwipe(threadId, messageId, index) {
    const message = getMessage(threadId, messageId);
    if (!message) return { empty: true };

    ensureSwipeFields(message);
    if (!message.swipes) return { empty: true };

    if (index < 0 || index >= message.swipes.length) return message;

    message.swipes.splice(index, 1);
    message.swipeThinking.splice(index, 1);
    if (Array.isArray(message.swipeReasoningMeta)) {
        message.swipeReasoningMeta.splice(index, 1);
    }
    message.swipeTimestamps.splice(index, 1);

    if (message.swipes.length === 0) {
        return { empty: true };
    }

    // Adjust swipeId if needed
    if (message.swipeId >= message.swipes.length) {
        message.swipeId = message.swipes.length - 1;
    } else if (message.swipeId > index) {
        message.swipeId--;
    } else if (message.swipeId === index) {
        // Deleted the active one; stay at same index or go to previous
        message.swipeId = Math.min(message.swipeId, message.swipes.length - 1);
    }

    syncSwipeToMessage(message);

    const thread = getThread(threadId);
    if (thread) thread.updatedAt = getTimestamp();

    return message;
}

/**
 * Get all threads filtered for the current branch
 * @returns {Array} Array of threads with filtered messages
 */
export function getThreadsForCurrentBranch() {
    const threads = getThreads();
    const currentLength = getCurrentChatLength();

    if (currentLength === null) return threads;

    return threads.map(thread => {
        const filteredMessages = [];
        const branchedMessages = [];
        for (const msg of thread.messages) {
            if (msg.chatMessageIndex === undefined || msg.chatMessageIndex === null) {
                filteredMessages.push(msg);
            } else if (msg.chatMessageIndex <= currentLength) {
                filteredMessages.push(msg);
            } else {
                branchedMessages.push(msg);
            }
        }
        return { ...thread, messages: filteredMessages, branchedMessages };
    });
}
