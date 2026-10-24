/**
 * Thread export (Markdown and JSON) and JSON import. Pure functions, no DOM.
 */

import { getThreadMode, isDebugThread } from './threadModes.js';

export const EXPORT_FORMAT = 'sillytavern-scratchpad-threads';
export const EXPORT_VERSION = 1;

function isExportableMessage(message) {
    return message
        && (message.role === 'user' || message.role === 'assistant')
        && (!message.status || message.status === 'complete')
        && typeof message.content === 'string'
        && message.content.trim();
}

/**
 * Render a thread as Markdown, using each reply's selected swipe
 * @param {Object} thread Thread object
 * @param {Object} [options] Options
 * @param {string} [options.userLabel] Heading for your messages
 * @returns {string} Markdown text
 */
export function threadToMarkdown(thread, { userLabel = 'You' } = {}) {
    const lines = [`# ${thread?.name || 'Scratch Pad Thread'}`, ''];
    if (isDebugThread(thread)) lines.push('Mode: Troubleshooting', '');

    for (const message of (thread?.messages || []).filter(isExportableMessage)) {
        const label = message.role === 'user' ? userLabel : 'Assistant';
        lines.push(`**${label}:**`, '', message.content.trim(), '');
    }

    return lines.join('\n').trimEnd() + '\n';
}

/**
 * Build the JSON export for one or more threads
 * @param {Object[]} threads Threads to export
 * @param {Date} [now] Export time
 * @returns {string} JSON text
 */
export function threadsToJson(threads, now = new Date()) {
    return JSON.stringify({
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: now.toISOString(),
        threads: (threads || []).map(thread => structuredClone(thread)),
    }, null, 2);
}

/**
 * A file name for an exported thread
 * @param {string} name Thread name
 * @param {string} extension File extension without the dot
 * @returns {string} File name
 */
export function exportFileName(name, extension) {
    const slug = String(name || 'thread')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'thread';
    return `scratchpad-${slug}.${extension}`;
}

/**
 * Read threads from a JSON export. Threads and messages get new IDs so an
 * import never collides with existing threads, and messages lose their link
 * to the source chat's positions so they show in every branch of this chat.
 * @param {string} text JSON text
 * @param {() => string} generateId ID generator
 * @returns {Object[]} Threads ready to add
 * @throws {Error} When the file isn't a Scratch Pad export
 */
export function parseThreadImport(text, generateId) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('The file is not valid JSON.');
    }

    const threads = Array.isArray(data?.threads) ? data.threads
        : (data && Array.isArray(data.messages) ? [data] : null);
    if (data?.format && data.format !== EXPORT_FORMAT) {
        throw new Error('The file is not a Scratch Pad thread export.');
    }
    if (!threads || threads.length === 0) {
        throw new Error('No threads found in the file.');
    }

    const now = new Date().toISOString();
    return threads
        .filter(thread => thread && Array.isArray(thread.messages))
        .map(thread => ({
            id: generateId(),
            name: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : 'Imported Thread',
            mode: getThreadMode(thread),
            createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : now,
            updatedAt: now,
            messages: thread.messages
                .filter(message => message && (message.role === 'user' || message.role === 'assistant')
                    && message.status !== 'pending')
                .map(message => ({
                    ...structuredClone(message),
                    id: generateId(),
                    content: typeof message.content === 'string' ? message.content : '',
                    chatMessageIndex: null,
                })),
            contextSettings: importContextSettings(thread.contextSettings),
            titled: true,
        }));
}

const IMPORT_ENUM_SETTINGS = {
    chatHistoryRangeMode: ['all', 'start_to', 'from_to_end', 'between'],
    swipeContextMode: ['none', 'user', 'assistant', 'both'],
};
const IMPORT_RANGE_SETTINGS = ['chatHistoryRangeStart', 'chatHistoryRangeEnd'];
const IMPORT_BOOLEAN_SETTINGS = [
    'characterCardOnly',
    'includeCharacterCard',
    'includeSystemPrompt',
    'includeAuthorsNote',
    'includePersona',
    'includeWorldInfo',
    'includeSummary',
    'includeHiddenMessages',
];

/**
 * Keep an imported thread's context choices, minus its connection profile:
 * profile IDs belong to the install that exported them. The file is untrusted,
 * so only known keys with valid values are kept; missing ones fall back to the
 * defaults when the thread is read.
 * @param {Object} settings Exported context settings
 * @returns {Object|null} Settings to store
 */
function importContextSettings(settings) {
    if (!settings || typeof settings !== 'object') return null;
    const copy = {};
    for (const [key, values] of Object.entries(IMPORT_ENUM_SETTINGS)) {
        if (values.includes(settings[key])) copy[key] = settings[key];
    }
    for (const key of IMPORT_RANGE_SETTINGS) {
        if (settings[key] === null || (Number.isInteger(settings[key]) && settings[key] > 0)) copy[key] = settings[key];
    }
    for (const key of IMPORT_BOOLEAN_SETTINGS) {
        if (typeof settings[key] === 'boolean') copy[key] = settings[key];
    }
    copy.connectionProfileId = null;
    copy.connectionProfile = null;
    return copy;
}
