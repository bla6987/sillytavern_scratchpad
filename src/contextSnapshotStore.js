/** Shared context manifests contain identifiers/hashes, never old message bodies. */
const undoSnapshots = new WeakMap();
const anonymousScopes = new WeakMap();
let nextScope = 0;

function scopeIdentity(data, scope) {
    if (scope != null) return scope;
    if (!anonymousScopes.has(data)) anonymousScopes.set(data, ++nextScope);
    return anonymousScopes.get(data);
}

function snapshotKeys(messages) {
    const keys = new Set();
    for (const message of messages || []) {
        for (const extra of [message?.extra, ...(message?.swipeExtra || [])]) {
            if (extra?.contextSnapshotKey) keys.add(extra.contextSnapshotKey);
        }
    }
    return keys;
}

export function pruneContextSnapshots(data, keepKeys = []) {
    if (!data?.contextSnapshots) return;
    const referenced = new Set(keepKeys);
    for (const thread of data.threads || []) for (const key of snapshotKeys(thread.messages)) referenced.add(key);
    for (const key of Object.keys(data.contextSnapshots)) if (!referenced.has(key)) delete data.contextSnapshots[key];
    if (!Object.keys(data.contextSnapshots).length) delete data.contextSnapshots;
}

/** The existing Undo callback owns the removed object; this map does not pin it. */
export function preserveSnapshotsForUndo(owner, messages, data, scope) {
    if (!data?.contextSnapshots) return;
    const snapshots = new Map();
    for (const key of snapshotKeys(messages)) if (data.contextSnapshots[key]) snapshots.set(key, data.contextSnapshots[key]);
    if (snapshots.size) undoSnapshots.set(owner, { scope: scopeIdentity(data, scope), snapshots });
}

export function restoreSnapshotsForUndo(owner, data, scope) {
    const saved = undoSnapshots.get(owner);
    if (!saved || saved.scope !== scopeIdentity(data, scope)) return;
    data.contextSnapshots ||= {};
    for (const [key, snapshot] of saved.snapshots) data.contextSnapshots[key] ||= snapshot;
    undoSnapshots.delete(owner);
}
