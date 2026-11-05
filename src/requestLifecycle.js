/** Request-owned cancellation, including errors wrapped by Connection Manager. */
export function isAbortError(error) {
    const seen = new Set();
    while (error && !seen.has(error)) {
        seen.add(error);
        if (error.name === 'AbortError' || /abort|cancel/i.test(error.message || '')) return true;
        error = error.cause;
    }
    return false;
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException('Scratch Pad request cancelled', 'AbortError');
}

// Older generateRaw implementations cannot accept an AbortSignal. Stop waiting
// for their result without emitting ST's global GENERATION_STOPPED event.
export async function awaitWithSignal(operation, signal) {
    throwIfAborted(signal);
    if (!signal) return await operation();
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new DOMException('Scratch Pad request cancelled', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve().then(() => {
            throwIfAborted(signal);
            return operation();
        }), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
