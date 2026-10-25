/** Bounded, independently cancellable subscribers sharing embedding requests. */
export const abortError = () => new DOMException('Embedding operation cancelled', 'AbortError');

export function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

export function createEmbeddingRequestQueue(runBatch, { maxBatchSize = 32, maxBatchChars = 262144, maxConcurrent = 2, maxQueuedBytes = 8 * 1024 * 1024 } = {}) {
    const pending = new Map();
    let queued = [];
    let queuedBytes = 0;
    let running = 0;
    let scheduled = false;
    const groups = new Set();

    function remove(job) {
        if (job.finished) return;
        job.finished = true;
        const byText = pending.get(job.recipe);
        if (byText?.get(job.text) === job) byText.delete(job.text);
        if (!byText?.size) pending.delete(job.recipe);
        queuedBytes -= job.bytes;
    }

    function finish(job, error, vector) {
        remove(job);
        for (const subscriber of job.subscribers) {
            subscriber.signal.removeEventListener('abort', subscriber.abort);
            error ? subscriber.reject(error) : subscriber.resolve(vector);
        }
        job.subscribers.clear();
        job.text = ''; job.settings = null;
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; drain(); });
    }

    function drain() {
        queued = queued.filter(job => !job.finished && job.subscribers.size);
        while (running < maxConcurrent && queued.length) {
            const first = queued.shift();
            const jobs = [first];
            let chars = first.text.length;
            for (let index = 0; index < queued.length && jobs.length < maxBatchSize;) {
                const job = queued[index];
                if (job.recipe === first.recipe && chars + job.text.length <= maxBatchChars) {
                    queued.splice(index, 1); jobs.push(job); chars += job.text.length;
                } else index++;
            }
            const group = { controller: new AbortController(), jobs };
            for (const job of jobs) job.group = group;
            groups.add(group); running++;
            const settings = first.settings;
            const texts = jobs.map(job => job.text);
            Promise.resolve().then(() => {
                throwIfAborted(group.controller.signal);
                return runBatch(settings, texts, group.controller.signal);
            }).then(vectors => {
                if (vectors.length !== jobs.length) throw new Error('Embedding response count mismatch.');
                for (let index = 0; index < jobs.length; index++) finish(jobs[index], null, vectors[index]);
            }).catch(error => {
                for (const job of jobs) finish(job, error);
            }).finally(() => { groups.delete(group); running--; schedule(); });
        }
    }

    function subscribe(text, recipe, settings, signal) {
        throwIfAborted(signal);
        let byText = pending.get(recipe);
        let job = byText?.get(text);
        if (job?.finished || job?.group?.controller.signal.aborted) job = null;
        if (!job) {
            const bytes = text.length * 2 + 128;
            if (queuedBytes && queuedBytes + bytes > maxQueuedBytes) throw new Error('Embedding queue is busy. Try again after the current request finishes.');
            job = { text, recipe, settings, bytes, subscribers: new Set(), group: null, finished: false };
            if (!byText) { byText = new Map(); pending.set(recipe, byText); }
            byText.set(text, job); queued.push(job); queuedBytes += bytes;
        }
        const shared = job;
        return new Promise((resolve, reject) => {
            const subscriber = { resolve, reject, signal, abort: null };
            subscriber.abort = () => {
                shared.subscribers.delete(subscriber);
                signal.removeEventListener('abort', subscriber.abort);
                reject(abortError());
                if (!shared.subscribers.size) {
                    remove(shared);
                    if (!shared.group) { shared.text = ''; shared.settings = null; }
                    else if (shared.group.jobs.every(item => !item.subscribers.size)) shared.group.controller.abort();
                }
                schedule();
            };
            shared.subscribers.add(subscriber);
            signal.addEventListener('abort', subscriber.abort, { once: true });
            if (signal.aborted) subscriber.abort();
            schedule();
        });
    }

    return {
        async request(texts, recipe, settings, { signal } = {}) {
            throwIfAborted(signal);
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            try {
                if (signal?.aborted) controller.abort();
                const promises = texts.map(text => Promise.resolve().then(() => subscribe(text, recipe, settings, controller.signal)));
                return await Promise.all(promises);
            } catch (error) { controller.abort(); throw error; }
            finally { signal?.removeEventListener('abort', abort); }
        },
        cancel() {
            for (const group of groups) group.controller.abort();
            for (const byText of pending.values()) for (const job of [...byText.values()]) finish(job, abortError());
            queued = [];
        },
    };
}
