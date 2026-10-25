/** Compact, reply-specific records of the main-chat context actually sent. */
import { hashContextValue as fingerprint, newContextIdentity } from './contextHash.js';
import { pruneContextSnapshots } from './contextSnapshotStore.js';
const VERSION = 1;
const ID_FIELD = 'scratchPadContextId';
const transientIds = new WeakMap();
export const CONTEXT_REFERENCE_INSTRUCTION = 'Current main-chat text is authoritative. Earlier Scratch Pad replies may describe older text. Message numbers match SillyTavern, starting at #0. Use the change notice as reference; answer the question normally.';
export const CHANGE_HEADING = '--- CHANGES SINCE YOUR PREVIOUS REPLY ---';

export function chatScope(context) {
    const id = context.getCurrentChatId?.();
    return id === undefined || id === null || id === '' ? null
        : JSON.stringify([String(id), context.groupId ?? null, context.characterId ?? null]);
}

/** Preview-safe: identities are written to chat messages only after success. */
export function captureChatContext(context) {
    const sources = (context.chat || []).slice();
    const used = new Set();
    let repaired = false;
    const identities = sources.map((message, number) => {
        if (!message || typeof message !== 'object') return `absent:${number}`;
        let id = typeof message?.[ID_FIELD] === 'string' ? message[ID_FIELD] : transientIds.get(message);
        if (!id || used.has(id)) {
            if (id) repaired = true;
            id = newContextIdentity();
            transientIds.set(message, id);
        }
        used.add(id);
        return id;
    });
    return { scope: chatScope(context), metadata: context.chatMetadata, sources, identities, repaired };
}

export async function fingerprintChatMessage(message, userName) {
    // Numbers are deliberately excluded: deletion/insertions must not turn the
    // remaining messages into a cascade of edits. Only the selected view counts.
    return fingerprint([Boolean(message.is_user), message.name || (message.is_user ? userName : 'Character'), message.mes, message.swipe_id ?? 0]);
}

export function previousContext(thread, context) {
    const messages = [...(thread?.contextComparisonMessage ? [thread.contextComparisonMessage] : []), ...(thread?.messages || []).slice().reverse()];
    for (const message of messages) {
        if (message.role !== 'assistant' || message.noContext || (message.status && message.status !== 'complete') || message.extra?.contextComparisonSkipped) continue;
        const key = message.extra?.contextSnapshotKey;
        const snapshot = key && context.chatMetadata?.scratchPad?.contextSnapshots?.[key];
        return snapshot?.version === VERSION && Array.isArray(snapshot.all) && snapshot.all.every(id => typeof id === 'string')
            && Array.isArray(snapshot.seen) && snapshot.seen.every(entry => entry && typeof entry.id === 'string'
                && Number.isInteger(entry.number) && entry.number >= 0 && snapshot.all[entry.number] === entry.id
                && typeof entry.hash === 'string' && /^[a-f0-9]{64}$/.test(entry.hash))
            ? { state: 'recorded', snapshot } : { state: 'unavailable' };
    }
    return { state: 'first' };
}

export function contextChangeNotice(capture, included, previous) {
    const lines = [CHANGE_HEADING];
    if (previous.state === 'first') return [...lines, 'No previous main-chat context is recorded.'].join('\n');
    const old = previous.snapshot;
    const currentIds = new Set(capture.identities);
    const oldIds = new Set(old?.all || []);
    const missing = (old?.all || []).filter(id => !currentIds.has(id));
    const added = capture.identities.filter(id => !oldIds.has(id));
    // Replacements, lost IDs, copied IDs, and branch switches are ambiguous.
    // A simultaneous deletion/addition cannot safely be distinguished from an
    // identity reset, so establish a fresh baseline instead of guessing.
    if (previous.state !== 'recorded' || !capture.scope || capture.scope !== old.scope
        || capture.repaired || capture.ambiguousText || old.reliable === false || new Set(capture.sources).size !== capture.sources.length
        || (missing.length && added.length)) {
        return [...lines, 'Previous context unavailable for comparison.'].join('\n');
    }
    const seenBefore = new Map(old.seen.map(entry => [entry.id, entry]));
    const seenNow = new Map(included.map(entry => [entry.id, entry]));
    const numbers = entries => {
        const sorted = entries.map(entry => entry.number).sort((a, b) => a - b);
        const groups = [];
        for (let i = 0; i < sorted.length; i++) {
            const start = sorted[i];
            while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
            groups.push(start === sorted[i] ? `Message #${start}` : `Messages #${start}-#${sorted[i]}`);
        }
        return groups.join(', ');
    };
    const append = (label, entries, detail = '') => {
        if (entries.length) lines.push(`${label}: ${numbers(entries)}${detail}.`);
    };
    append('New', included.filter(entry => !oldIds.has(entry.id)));
    append('Changed', included.filter(entry => seenBefore.has(entry.id) && seenBefore.get(entry.id).hash !== entry.hash));
    append('Removed', old.seen.filter(entry => !currentIds.has(entry.id)), ' (deleted; previous numbers)');
    append('Included now', included.filter(entry => oldIds.has(entry.id) && !seenBefore.has(entry.id)), ' (already existed; previously omitted)');
    append('Not included now', old.seen.filter(entry => currentIds.has(entry.id) && !seenNow.has(entry.id))
        .map(entry => ({ ...entry, number: capture.identities.indexOf(entry.id) })), ' (still in the chat; omitted from this request)');
    if (included.some(entry => seenBefore.has(entry.id) && seenBefore.get(entry.id).number !== entry.number)) {
        lines.push('Message numbers shifted. Removed uses previous numbers; all other labels use current numbers.');
    }
    if (lines.length === 1) lines.push(included.length ? 'Unchanged: Included main-chat messages are unchanged.' : 'No main-chat text is included.');
    return lines.join('\n');
}

export async function prepareContextSnapshot(capture, included) {
    const snapshot = { version: VERSION, scope: capture.scope, reliable: !capture.ambiguousText && new Set(capture.sources).size === capture.sources.length, all: capture.identities, seen: included };
    return { capture, snapshot, key: await fingerprint(snapshot) };
}

/** Attach to the successful reply's extra, then use the existing metadata save. */
export function recordSuccessfulContext(tracking, extra) {
    if (!tracking) return extra;
    const context = SillyTavern.getContext();
    const { capture, snapshot, key } = tracking;
    // Never put a completion from another chat into the current chat's pool.
    if (chatScope(context) !== capture.scope || (!capture.scope && context.chatMetadata !== capture.metadata)) return extra;
    const data = context.chatMetadata?.scratchPad;
    if (!data) return extra;
    capture.sources.forEach((message, index) => { if (message && typeof message === 'object') message[ID_FIELD] = capture.identities[index]; });
    data.contextSnapshots ||= {};
    data.contextSnapshots[key] = snapshot;
    // Shared manifests deduplicate identical requests across threads and swipes;
    // no old message text is saved. Keep referenced snapshots only.
    pruneContextSnapshots(data, [key]);
    return { ...extra, contextSnapshotKey: key };
}

