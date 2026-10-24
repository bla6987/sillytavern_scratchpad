/** Thread purpose is chosen at creation, never by a context toggle. */
export const THREAD_MODE = Object.freeze({ STORY: 'story', DEBUG: 'debug' });

export function getThreadMode(thread) {
    return thread?.mode === THREAD_MODE.DEBUG ? THREAD_MODE.DEBUG : THREAD_MODE.STORY;
}

export function isDebugThread(thread) {
    return getThreadMode(thread) === THREAD_MODE.DEBUG;
}
