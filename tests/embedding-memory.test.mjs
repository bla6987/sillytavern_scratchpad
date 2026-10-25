import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingRequestQueue } from '../src/embeddingRequests.js';
import { embedTexts, clearEmbeddingCache, updateEmbeddingSettings } from '../src/embeddings.js';
import { searchThreadsSemantic, resetQueryCache, cosineSimilarity } from '../src/semanticSearch.js';

const records = new Map();
const cache = {
    async getItem(key) { return records.get(key); },
    async setItem(key, value) { records.set(key, value); },
    async clear() { records.clear(); },
    async iterate(callback) { for (const [key, value] of records) callback(value, key); },
};

async function setup(threads = []) {
    const context = {
        chat: [], chatMetadata: { scratchPad: { threads } }, saveSettingsDebounced() {},
        extensionSettings: { scratchPad: { embeddings: {
            enabled: true, useSharedConfig: false, provider: 'openai', apiKey: 'fixture-key', model: 'fixture-model', dimensions: null,
        } } },
    };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { createInstance: () => cache } } };
    await clearEmbeddingCache(); resetQueryCache();
    return context;
}

test('coalesced callers share one request while cancellation releases only its subscriber', async () => {
    let finish, calls = 0, signal;
    const queue = createEmbeddingRequestQueue(async (_settings, texts, requestSignal) => {
        calls++; signal = requestSignal;
        await new Promise(resolve => { finish = resolve; });
        return texts.map(() => Float32Array.of(1, 0));
    });
    const cancelled = new AbortController();
    const first = queue.request(['same'], 'recipe', {}, { signal: cancelled.signal });
    const second = queue.request(['same'], 'recipe', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    cancelled.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(signal.aborted, false);
    finish();
    assert.equal((await second).length, 1);
    assert.equal(calls, 1);
});

test('all cancelled subscribers abort provider work; another recipe never shares it', async () => {
    const calls = [];
    const queue = createEmbeddingRequestQueue((_settings, texts, signal) => new Promise((resolve, reject) => {
        calls.push({ texts, signal, resolve });
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const first = queue.request(['same'], 'recipe-a', {}, { signal: controller.signal });
    const other = queue.request(['same'], 'recipe-b', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 2);
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[1].resolve([Float32Array.of(0, 1)]);
    await other;
});

test('semantic search scans every thread/swipe with bounded vector batches and Float32 vectors', async () => {
    const threads = Array.from({ length: 8 }, (_, index) => ({
        id: `thread-${index}`, name: `Title ${index}`, messages: Array.from({ length: 45 }, (_, message) => ({
            id: `${index}-${message}`, role: 'assistant', content: `ordinary text ${index}-${message}`,
            swipes: [`ordinary text ${index}-${message}`, `variant text ${index}-${message}`],
        })),
    }));
    threads.at(-1).messages.at(-1).swipes.push('last hidden target');
    await setup(threads);
    const oldFetch = globalThis.fetch;
    let largest = 0, total = 0;
    globalThis.fetch = async (_url, options) => {
        const texts = JSON.parse(options.body).input;
        largest = Math.max(largest, texts.length); total += texts.length;
        return new Response(JSON.stringify({ data: texts.map((text, index) => ({ index, embedding: text.includes('target') ? [1, 0] : [0, 1] })) }));
    };
    try {
        const results = await searchThreadsSemantic('target', { maxResults: 2 });
        assert.equal(results[0].thread.id, 'thread-7');
        assert.match(results[0].snippet, /last hidden target/);
        assert.ok(total > 700, `searched ${total} inputs`);
        assert.ok(largest <= 32, `largest vector batch ${largest}`);
        assert.ok([...records.values()].filter(value => value.vector).every(value => value.vector instanceof Float32Array));
        assert.equal(cosineSimilarity(Float32Array.of(1, 0), Float32Array.of(1, 0)), 1);
    } finally { globalThis.fetch = oldFetch; }
});

test('closing/superseding search aborts the pending request before the corpus is read', async () => {
    await setup([{ id: 'thread', name: 'Notes', messages: Array.from({ length: 100 }, (_, i) => ({ content: `body ${i}` })) }]);
    const oldFetch = globalThis.fetch;
    let calls = 0, startedResolve, aborted = false;
    const started = new Promise(resolve => { startedResolve = resolve; });
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        calls++; startedResolve();
        options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    });
    const controller = new AbortController();
    try {
        const result = searchThreadsSemantic('query', { signal: controller.signal });
        await started; controller.abort();
        await assert.rejects(result, { name: 'AbortError' });
        assert.equal(aborted, true);
        assert.equal(calls, 1);
        assert.equal([...records.values()].filter(value => value.vector).length, 0);
    } finally { globalThis.fetch = oldFetch; }
});

test('late old-provider results cannot populate the cache after settings change', async () => {
    await setup();
    const oldFetch = globalThis.fetch;
    let finish, startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    globalThis.fetch = async () => {
        startedResolve();
        await new Promise(resolve => { finish = resolve; });
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    };
    try {
        const result = embedTexts(['old request']);
        const rejected = assert.rejects(result, { name: 'AbortError' });
        await started;
        updateEmbeddingSettings({ model: 'changed-model' });
        finish();
        await rejected;
        assert.equal([...records.values()].filter(value => value.vector).length, 0);
    } finally { globalThis.fetch = oldFetch; }
});

for (const change of ['delete', 'edit-with-unchanged-timestamp']) {
    test(`semantic search rejects ${change} while the corpus request is pending`, async () => {
        const threads = [{ id: 'thread', name: '', updatedAt: 'same-tick', messages: [{ content: 'target body' }] }];
        await setup(threads);
        const oldFetch = globalThis.fetch;
        let finish, startedResolve;
        const started = new Promise(resolve => { startedResolve = resolve; });
        globalThis.fetch = async (_url, options) => {
            const texts = JSON.parse(options.body).input;
            if (texts.includes('target body')) {
                startedResolve();
                await new Promise(resolve => { finish = resolve; });
            }
            return new Response(JSON.stringify({ data: texts.map((_text, index) => ({ index, embedding: [1, 0] })) }));
        };
        try {
            const result = searchThreadsSemantic('target');
            const rejected = assert.rejects(result, { name: 'AbortError' });
            await started;
            if (change === 'delete') threads.splice(0, 1);
            else threads[0].messages[0].content = 'changed body';
            finish();
            await rejected;
        } finally { globalThis.fetch = oldFetch; }
    });
}

for (const failedMethod of ['getItem', 'setItem', 'clear']) {
    test(`rejected persistent ${failedMethod} falls back to bounded memory and reuses vectors`, async () => {
        const context = await setup();
        const isolated = await import(`../src/embeddings.js?failed-cache=${failedMethod}`);
        const disk = new Map();
        const methods = {
            async getItem(key) { return disk.get(key); },
            async setItem(key, value) { disk.set(key, value); },
            async clear() { disk.clear(); },
            async iterate(callback) { for (const [key, value] of disk) callback(value, key); },
        };
        methods[failedMethod] = async () => { throw new DOMException('Blocked storage', 'QuotaExceededError'); };
        globalThis.SillyTavern.libs.localforage.createInstance = () => methods;
        const oldFetch = globalThis.fetch, oldWarn = console.warn;
        let calls = 0;
        console.warn = () => {};
        globalThis.fetch = async (_url, options) => {
            calls++;
            return new Response(JSON.stringify({ data: JSON.parse(options.body).input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
        };
        try {
            if (failedMethod === 'clear') await isolated.clearEmbeddingCache();
            const first = await isolated.embedTexts(['body']);
            const second = await isolated.embedTexts(['body']);
            assert.deepEqual([...first[0]], [1, 0]);
            assert.deepEqual([...second[0]], [1, 0]);
            assert.equal(calls, 1);
            assert.equal((await isolated.getCacheStats()).count, 1);
            assert.equal(context.chatMetadata.scratchPad.threads.length, 0);
        } finally { globalThis.fetch = oldFetch; console.warn = oldWarn; }
    });
}

test('cached partial vectors detach their oversized backing buffers and duplicate texts share one compact result', async () => {
    await setup();
    const isolated = await import('../src/embeddings.js?partial-vector-cache');
    const large = new Float32Array(1024 * 1024);
    large.set([1, 0], 10);
    const settings = isolated.getEmbeddingSettings();
    const partial = large.subarray(10, 12);
    const item = { vector: partial, dims: 2, text: 'cached text', provider: settings.provider,
        model: settings.model, recipe: isolated.getEmbeddingRecipeKey(settings) };
    const disk = new Map([[isolated.makeTextCacheKey(item.text), item]]);
    globalThis.SillyTavern.libs.localforage.createInstance = () => ({
        async getItem(key) { return disk.get(key); },
        async setItem(key, value) { disk.set(key, value); },
        async clear() { disk.clear(); }, async iterate() {},
    });
    const result = await isolated.embedTexts([item.text, item.text]);
    assert.equal(result[0], result[1]);
    assert.equal(result[0].buffer.byteLength, 8);
    assert.notEqual(result[0].buffer, large.buffer);
});
