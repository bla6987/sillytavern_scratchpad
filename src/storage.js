/**
 * Storage module for Scratch Pad extension
 * Handles chatMetadata operations and thread CRUD
 */

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

    console.log('[ScratchPad Storage] ensureScratchPadExists - chatMetadata:', !!chatMetadata);

    if (!chatMetadata) {
        console.warn('[ScratchPad Storage] No chatMetadata available - is a chat open?');
        return null;
    }

    if (!chatMetadata[MODULE_NAME]) {
        console.log('[ScratchPad Storage] Creating scratch pad data structure');
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
    console.log('[ScratchPad Storage] createThread called with name:', name);
    const data = ensureScratchPadExists();
    if (!data) {
        console.error('[ScratchPad Storage] createThread failed - no data structure');
        return null;
    }

    const timestamp = getTimestamp();
    const thread = {
        id: generateId(),
        name: name,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
        contextSettings: contextSettings ? { ...contextSettings } : null
    };

    data.threads.unshift(thread);
    console.log('[ScratchPad Storage] Thread created:', thread.id, 'Total threads:', data.threads.length);
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
    const filteredMessages = thread.messages.filter(msg => {
        if (msg.chatMessageIndex === undefined || msg.chatMessageIndex === null) {
            return true;  // Legacy messages always shown
        }
        return msg.chatMessageIndex <= currentLength;
    });

    return { ...thread, messages: filteredMessages };
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
        const filteredMessages = thread.messages.filter(msg => {
            if (msg.chatMessageIndex === undefined || msg.chatMessageIndex === null) {
                return true;
            }
            return msg.chatMessageIndex <= currentLength;
        });
        return { ...thread, messages: filteredMessages };
    });
}
