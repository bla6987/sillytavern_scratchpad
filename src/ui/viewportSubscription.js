/** Optional viewport coalescing; native browser events always remain usable. */
function createForwarder() {
    // Keep this closure's environment separate from the caller's view handler.
    // Even a broken optional bus can retain only this empty owner after disposal.
    const owner = { callback: null };
    return { owner, forward: (...args) => owner.callback?.(...args) };
}

export function subscribeToViewport(mode, handler, host = globalThis.window) {
    const { owner, forward } = createForwarder();
    const viewport = host?.STRuntimeBus?.viewport;
    if (typeof viewport?.subscribe === 'function') {
        try {
            const unsubscribe = viewport.subscribe(mode, forward);
            if (typeof unsubscribe === 'function') {
                owner.callback = handler;
                return () => {
                    owner.callback = null;
                    try { unsubscribe(); } catch { /* inactive callback no longer retains the view */ }
                };
            }
        } catch { /* older/partial bus: use the browser directly */ }
    }
    // A malformed bus may have retained forward before throwing/returning an
    // invalid disposer. It sees a permanently empty owner, never a view closure.
    const target = mode === 'keyboard' ? host?.visualViewport : host;
    if (typeof target?.addEventListener !== 'function') return () => {};
    target.addEventListener('resize', handler);
    return () => target.removeEventListener('resize', handler);
}
