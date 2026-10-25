/**
 * Copy mutable message structure while reusing immutable strings directly.
 * Avoid structured serialization of every long reply/swipe when making a branch.
 * Every object/array is independent; non-JSON values retain structuredClone semantics.
 */
function isPlainData(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
    if (seen.has(value)) return true;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !isPlainData(descriptor.value, seen)) return false;
    }
    return true;
}

function clonePlainData(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) {
        Object.defineProperty(result, key, { value: clonePlainData(value[key], seen), enumerable: true, writable: true, configurable: true });
    }
    return result;
}

export function cloneWithSharedText(value) {
    // Clone the entire graph together when richer values are present. Cloning a
    // Map/Set separately would break aliases to objects elsewhere in the message.
    return isPlainData(value) ? clonePlainData(value) : structuredClone(value);
}
