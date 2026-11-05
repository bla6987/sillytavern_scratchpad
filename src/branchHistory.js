import { newContextIdentity } from './contextHash.js';

const ID_FIELD = 'scratchPadBranchId';
const sourceChat = context => context.getCurrentChatId?.() ?? null;

/** Anchors survive chat copies and index shifts, but not a divergent future. */
export function captureBranchAnchor(context, length) {
    if (length == null) return null; // Imported/unpositioned history is portable.
    if (length === 0) return { version: 1, id: null };
    const message = context.chat?.[length - 1];
    if (!message || typeof message !== 'object') return { version: 1, unresolved: true };
    if (typeof message[ID_FIELD] !== 'string' || !message[ID_FIELD]) message[ID_FIELD] = newContextIdentity();
    return { version: 1, id: message[ID_FIELD], swipe: message.swipe_id ?? 0, source: sourceChat(context) };
}

/** Build once per view/prompt/search, rather than scanning the chat per turn. */
export function createBranchFilter(context = SillyTavern.getContext()) {
    const byId = new Map();
    const length = context.chat?.length;
    const source = sourceChat(context);
    for (const message of context.chat || []) {
        const id = message?.[ID_FIELD];
        if (id) byId.set(id, byId.has(id) ? null : { swipe: message.swipe_id ?? 0 });
    }
    return message => {
        const anchor = message?.branchAnchor;
        if (!anchor) return message?.chatMessageIndex == null || length == null || message.chatMessageIndex <= length;
        if (anchor.version !== 1 || anchor.unresolved) return false;
        if (anchor.id === null) return true;
        const mainMessage = byId.get(anchor.id);
        if (!mainMessage) return false;
        // Edits/swipes in the originating chat remain available for comparison.
        // A branch created from a different swipe must not inherit that future.
        return anchor.source == null || anchor.source === source || mainMessage.swipe === anchor.swipe;
    };
}

/** Upgrade legacy positions on chat load, before a new branch can grow past them. */
export function migrateBranchHistory(context = SillyTavern.getContext()) {
    let changed = false;
    for (const thread of context.chatMetadata?.scratchPad?.threads || []) {
        for (const message of thread.messages || []) {
            if (message.branchAnchor || message.chatMessageIndex == null) continue;
            message.branchAnchor = captureBranchAnchor(context, message.chatMessageIndex);
            changed = true;
        }
    }
    return changed;
}

export function filterThreadForCurrentBranch(thread, context = SillyTavern.getContext()) {
    if (!thread) return null;
    const isCurrent = createBranchFilter(context);
    return { ...thread, messages: (thread.messages || []).filter(isCurrent), branchedMessages: (thread.messages || []).filter(message => !isCurrent(message)) };
}
