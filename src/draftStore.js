/**
 * Draft store for Scratch Pad extension
 *
 * Holds unsent input text per thread for the life of the page, so switching
 * threads or closing the drawer never loses it. Drafts are memory-only and
 * never written to chatMetadata: saving metadata rewrites the whole chat file,
 * which is far too heavy to trigger from typing.
 *
 * Only non-empty drafts are stored, keyed by thread ID, so cost stays O(1) per
 * lookup no matter how many threads a chat has.
 *
 * Kept free of DOM and SillyTavern access so it can be unit-tested under node.
 */

/**
 * Draft key for the "New Thread" view, which has no thread ID yet
 * @type {string}
 */
export const NEW_THREAD_DRAFT_KEY = '__new_thread__';

const drafts = new Map();

/**
 * Get the unsent text for a thread
 * @param {string} key Thread ID, or NEW_THREAD_DRAFT_KEY
 * @returns {string} Draft text, or '' if there is none
 */
export function getDraft(key) {
    return drafts.get(key) ?? '';
}

/**
 * Store the unsent text for a thread. Empty or whitespace-only text removes
 * the entry so the store only ever holds real drafts.
 * @param {string} key Thread ID, or NEW_THREAD_DRAFT_KEY
 * @param {string} text Draft text, kept as typed
 */
export function setDraft(key, text) {
    if (typeof text === 'string' && text.trim()) {
        drafts.set(key, text);
    } else {
        drafts.delete(key);
    }
}

/**
 * Put text ahead of a thread's draft. Returned queue text was typed before
 * anything left in the input, so it goes first.
 * @param {string} key Thread ID, or NEW_THREAD_DRAFT_KEY
 * @param {string} text Text to put first
 */
export function prependToDraft(key, text) {
    setDraft(key, joinDraftText(text, getDraft(key)));
}

/**
 * Remove a thread's draft
 * @param {string} key Thread ID, or NEW_THREAD_DRAFT_KEY
 */
export function deleteDraft(key) {
    drafts.delete(key);
}

/**
 * Remove every draft
 */
export function clearDrafts() {
    drafts.clear();
}

/**
 * Get the number of stored drafts
 * @returns {number} Draft count
 */
export function getDraftCount() {
    return drafts.size;
}

/**
 * Join pieces of input text with a blank line, skipping empty pieces
 * @param {...string} parts Text pieces in order
 * @returns {string} Joined text
 */
export function joinDraftText(...parts) {
    return parts.filter(part => typeof part === 'string' && part.trim()).join('\n\n');
}
