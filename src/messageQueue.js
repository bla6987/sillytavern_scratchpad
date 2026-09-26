/**
 * Message queue for Scratch Pad extension
 *
 * Holds messages the user sent while a generation was running. Entries are
 * dispatched one at a time, oldest first, after the generation ahead of them
 * completes. The queue is in-memory only, like the unsent input draft.
 *
 * Kept free of DOM and SillyTavern access so it can be unit-tested under node.
 */

let queue = [];
let nextId = 0;

/**
 * Add a message to the end of the queue
 * @param {string} threadId Thread the message was typed in
 * @param {string} content Message text
 * @returns {{id: string, threadId: string, content: string}} The queued entry
 */
export function enqueueMessage(threadId, content) {
    nextId += 1;
    const entry = { id: `queued-${nextId}`, threadId, content };
    queue.push(entry);
    return entry;
}

/**
 * Get the queued messages for a thread
 * @param {string} threadId Thread ID
 * @returns {Array<{id: string, threadId: string, content: string}>} Entries in send order
 */
export function getQueuedMessages(threadId) {
    return queue.filter(entry => entry.threadId === threadId);
}

/**
 * Get the number of queued messages across all threads
 * @returns {number} Queue length
 */
export function getQueueLength() {
    return queue.length;
}

/**
 * Remove and return the oldest queued message
 * @returns {{id: string, threadId: string, content: string}|null} Entry, or null if empty
 */
export function dequeueNextMessage() {
    return queue.shift() ?? null;
}

/**
 * Remove a queued message by ID
 * @param {string} id Entry ID
 * @returns {{id: string, threadId: string, content: string}|null} Removed entry, or null if not found
 */
export function removeQueuedMessage(id) {
    const index = queue.findIndex(entry => entry.id === id);
    if (index === -1) return null;
    return queue.splice(index, 1)[0];
}

/**
 * Remove and return all queued messages for a thread
 * @param {string} threadId Thread ID
 * @returns {Array<{id: string, threadId: string, content: string}>} Removed entries in send order
 */
export function takeQueuedMessages(threadId) {
    const taken = queue.filter(entry => entry.threadId === threadId);
    queue = queue.filter(entry => entry.threadId !== threadId);
    return taken;
}

/**
 * Remove all queued messages
 */
export function clearMessageQueue() {
    queue = [];
}

/**
 * Join pieces of input text with a blank line, skipping empty pieces
 * @param {...string} parts Text pieces in order
 * @returns {string} Joined text
 */
export function joinDraftText(...parts) {
    return parts.filter(part => typeof part === 'string' && part.trim()).join('\n\n');
}
