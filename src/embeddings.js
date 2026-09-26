/**
 * Embedding service for Scratch Pad semantic search.
 *
 * Ported and trimmed from the sibling `chat_manager` extension
 * (src/embedding-service.js). Handles provider dispatch (OpenRouter / OpenAI /
 * Ollama), request batching, and a localforage-backed vector cache.
 *
 * Config lives at `extensionSettings.scratchPad.embeddings`. When
 * `useSharedConfig` is on (default) and the Chat Manager extension has an
 * embedding config, the provider/key/model are inherited from it so the user
 * can reuse the same OpenRouter key with zero extra setup.
 */

const MODULE_NAME = 'scratchPad';
const CHAT_MANAGER_MODULE = 'chat_manager';
const CACHE_DB_NAME = 'ScratchPad_Embeddings';
const CACHE_META_KEY = '__cache_meta__';
const BATCH_SIZE = 100;
const OLLAMA_BATCH_SIZE = 50;

const PROVIDERS = Object.freeze(['openrouter', 'openai', 'ollama']);

const OPENAI_COMPAT_ENDPOINTS = Object.freeze({
    openrouter: 'https://openrouter.ai/api/v1/embeddings',
    openai: 'https://api.openai.com/v1/embeddings',
});

export const DEFAULT_EMBEDDING_SETTINGS = Object.freeze({
    enabled: false,
    useSharedConfig: true,
    provider: 'openrouter',
    apiKey: '',
    ollamaUrl: 'http://localhost:11434',
    model: '',
    dimensions: null,
});

/** @type {import('localforage')|null} */
let embeddingCache = null;
/** @type {Map<string, any>|null} In-memory fallback when localforage is unavailable. */
let memoryCache = null;

class EmbeddingDimensionMismatchError extends Error {
    constructor(expected, actual) {
        super(`Embedding dimensions mismatch. Expected ${expected}, got ${actual}.`);
        this.name = 'EmbeddingDimensionMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ensure the embeddings settings object exists and is well-formed.
 * @returns {typeof DEFAULT_EMBEDDING_SETTINGS}
 */
function ensureEmbeddingSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = {};
    }

    const moduleSettings = extensionSettings[MODULE_NAME];
    let changed = false;

    if (!moduleSettings.embeddings || typeof moduleSettings.embeddings !== 'object') {
        moduleSettings.embeddings = { ...DEFAULT_EMBEDDING_SETTINGS };
        changed = true;
    }

    const embeddings = moduleSettings.embeddings;
    for (const [key, defaultValue] of Object.entries(DEFAULT_EMBEDDING_SETTINGS)) {
        if (embeddings[key] === undefined) {
            embeddings[key] = defaultValue;
            changed = true;
        }
    }

    if (!PROVIDERS.includes(embeddings.provider)) {
        embeddings.provider = DEFAULT_EMBEDDING_SETTINGS.provider;
        changed = true;
    }
    if (typeof embeddings.model !== 'string') {
        embeddings.model = String(embeddings.model ?? '');
        changed = true;
    }
    if (typeof embeddings.apiKey !== 'string') {
        embeddings.apiKey = String(embeddings.apiKey ?? '');
        changed = true;
    }
    if (typeof embeddings.ollamaUrl !== 'string' || !embeddings.ollamaUrl.trim()) {
        embeddings.ollamaUrl = DEFAULT_EMBEDDING_SETTINGS.ollamaUrl;
        changed = true;
    }
    if (typeof embeddings.enabled !== 'boolean') {
        embeddings.enabled = DEFAULT_EMBEDDING_SETTINGS.enabled;
        changed = true;
    }
    if (typeof embeddings.useSharedConfig !== 'boolean') {
        embeddings.useSharedConfig = DEFAULT_EMBEDDING_SETTINGS.useSharedConfig;
        changed = true;
    }
    if (embeddings.dimensions != null) {
        const dims = Number(embeddings.dimensions);
        embeddings.dimensions = Number.isInteger(dims) && dims > 0 ? dims : null;
    }

    if (changed) {
        saveSettingsDebounced();
    }

    return embeddings;
}

/**
 * Read the Chat Manager extension's embedding config, if present.
 * @returns {{provider?:string, apiKey?:string, model?:string, ollamaUrl?:string}|null}
 */
function getChatManagerEmbeddingSettings() {
    try {
        const cm = SillyTavern.getContext().extensionSettings?.[CHAT_MANAGER_MODULE]?.embeddings;
        return cm && typeof cm === 'object' ? cm : null;
    } catch {
        return null;
    }
}

/**
 * Raw stored settings (used by the settings UI for editing).
 * @returns {typeof DEFAULT_EMBEDDING_SETTINGS}
 */
export function getStoredEmbeddingSettings() {
    return ensureEmbeddingSettings();
}

/**
 * Effective settings after applying Chat Manager shared-config inheritance.
 * Used by the embedding pipeline and availability checks.
 * @returns {typeof DEFAULT_EMBEDDING_SETTINGS}
 */
export function getEmbeddingSettings() {
    const raw = ensureEmbeddingSettings();
    if (raw.useSharedConfig) {
        const cm = getChatManagerEmbeddingSettings();
        if (cm) {
            return {
                ...raw,
                provider: PROVIDERS.includes(cm.provider) ? cm.provider : raw.provider,
                apiKey: typeof cm.apiKey === 'string' && cm.apiKey ? cm.apiKey : raw.apiKey,
                model: typeof cm.model === 'string' && cm.model ? cm.model : raw.model,
                ollamaUrl: typeof cm.ollamaUrl === 'string' && cm.ollamaUrl ? cm.ollamaUrl : raw.ollamaUrl,
            };
        }
    }
    return { ...raw };
}

/**
 * Apply updates to the raw stored settings and persist.
 * @param {Partial<typeof DEFAULT_EMBEDDING_SETTINGS>} updates
 */
export function updateEmbeddingSettings(updates) {
    const settings = ensureEmbeddingSettings();
    Object.assign(settings, updates);
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Whether a usable provider/model/key combination is available.
 * @returns {boolean}
 */
export function isEmbeddingConfigured() {
    const s = getEmbeddingSettings();
    if (!PROVIDERS.includes(s.provider)) return false;
    if (!String(s.model || '').trim()) return false;
    if (s.provider === 'ollama') return true;
    return !!String(s.apiKey || '').trim();
}

/**
 * Whether semantic search should be offered (enabled + configured).
 * @returns {boolean}
 */
export function isSemanticSearchEnabled() {
    return getEmbeddingSettings().enabled === true && isEmbeddingConfigured();
}

/** True when sharing Chat Manager's config and it actually exists. */
export function isUsingSharedConfig() {
    const raw = ensureEmbeddingSettings();
    return raw.useSharedConfig === true && !!getChatManagerEmbeddingSettings();
}

/* ------------------------------------------------------------------ */
/*  Cache                                                             */
/* ------------------------------------------------------------------ */

function getEmbeddingCache() {
    if (embeddingCache) return embeddingCache;
    const localforage = SillyTavern.libs?.localforage;
    if (localforage?.createInstance) {
        embeddingCache = localforage.createInstance({ name: CACHE_DB_NAME });
        return embeddingCache;
    }
    // Fallback: minimal localforage-compatible shim over an in-memory Map.
    if (!memoryCache) memoryCache = new Map();
    embeddingCache = {
        getItem: async (k) => (memoryCache.has(k) ? memoryCache.get(k) : null),
        setItem: async (k, v) => { memoryCache.set(k, v); return v; },
        removeItem: async (k) => { memoryCache.delete(k); },
        clear: async () => { memoryCache.clear(); },
        iterate: async (fn) => { let i = 0; for (const [k, v] of memoryCache) fn(v, k, i++); },
    };
    return embeddingCache;
}

/**
 * FNV-1a 32-bit hash for stable content keys.
 * @param {string} input
 * @param {number} [seed]
 * @returns {string}
 */
export function fnv1aHash32(input, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a collision-resistant cache key from two hashes + length.
 * @param {string} text
 * @returns {string}
 */
export function makeTextCacheKey(text) {
    const normalized = String(text ?? '');
    const h1 = fnv1aHash32(normalized, 0x811c9dc5);
    const h2 = fnv1aHash32(normalized, 0x9e3779b1);
    return `txt_${h1}${h2}_${normalized.length.toString(16)}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function validateVector(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embedding API returned an empty/invalid vector.');
    }
    for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
            throw new Error('Embedding API returned non-numeric vector values.');
        }
    }
    return vector;
}

/**
 * @param {any} cached
 * @param {typeof DEFAULT_EMBEDDING_SETTINGS} settings
 * @param {number|null} expectedDims
 * @param {string} text
 * @returns {boolean}
 */
function isUsableCacheEntry(cached, settings, expectedDims, text) {
    if (!cached || typeof cached !== 'object') return false;
    if (cached.model !== settings.model) return false;
    if (cached.provider && cached.provider !== settings.provider) return false;
    if (typeof cached.text !== 'string' || cached.text !== text) return false;
    if (!Array.isArray(cached.vector) || cached.vector.length === 0) return false;
    if (!Number.isInteger(cached.dims) || cached.dims <= 0) return false;
    if (cached.dims !== cached.vector.length) return false;
    if (expectedDims != null && cached.dims !== expectedDims) return false;
    return true;
}

async function batchCacheGet(cache, items, concurrency = 50) {
    const results = new Array(items.length);
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const values = await Promise.all(chunk.map(item => cache.getItem(item.hash)));
        for (let j = 0; j < chunk.length; j++) {
            results[i + j] = values[j];
        }
    }
    return results;
}

/**
 * Batch read cached vectors for a list of texts (null where missing).
 * @param {string[]} texts
 * @returns {Promise<(number[]|null)[]>}
 */
export async function getCachedEmbeddingsForTexts(texts) {
    const settings = getEmbeddingSettings();
    const expectedDims = Number.isInteger(settings.dimensions) && settings.dimensions > 0 ? settings.dimensions : null;
    const cache = getEmbeddingCache();
    const items = texts.map(t => {
        const normalized = String(t ?? '');
        return { hash: makeTextCacheKey(normalized), text: normalized };
    });
    const cached = await batchCacheGet(cache, items);
    return cached.map((value, i) =>
        isUsableCacheEntry(value, settings, expectedDims, items[i].text) ? value.vector : null,
    );
}

/* ------------------------------------------------------------------ */
/*  Provider dispatch                                                */
/* ------------------------------------------------------------------ */

function extractErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.message === 'string') return payload.message;
    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
        return payload.error.message;
    }
    return '';
}

async function postJson(url, body, extraHeaders = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
    }

    if (!response.ok) {
        const detail = extractErrorMessage(payload);
        throw new Error(detail || `Embedding request failed (${response.status} ${response.statusText})`);
    }
    return payload;
}

async function embedOpenAICompatible(provider, settings, texts) {
    const endpoint = OPENAI_COMPAT_ENDPOINTS[provider];
    const payload = await postJson(
        endpoint,
        { model: settings.model, input: texts },
        { Authorization: `Bearer ${settings.apiKey}` },
    );
    if (!Array.isArray(payload?.data)) {
        throw new Error('Embedding API returned unexpected payload format.');
    }
    const ordered = payload.data
        .slice()
        .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        .map(item => validateVector(item?.embedding));
    if (ordered.length !== texts.length) {
        throw new Error(`Embedding API returned ${ordered.length} vectors for ${texts.length} texts.`);
    }
    return ordered;
}

let ollamaBatchSupported = true;

async function embedOllamaBatch(settings, texts) {
    const baseUrl = settings.ollamaUrl.replace(/\/+$/, '');
    const payload = await postJson(`${baseUrl}/api/embed`, { model: settings.model, input: texts });
    if (!Array.isArray(payload?.embeddings) || payload.embeddings.length !== texts.length) {
        throw new Error(`Ollama /api/embed returned ${payload?.embeddings?.length ?? 0} vectors for ${texts.length} texts.`);
    }
    return payload.embeddings.map(v => validateVector(v));
}

async function embedOllamaSingle(settings, text) {
    const baseUrl = settings.ollamaUrl.replace(/\/+$/, '');
    const payload = await postJson(`${baseUrl}/api/embeddings`, { model: settings.model, prompt: text });
    return validateVector(payload?.embedding);
}

/**
 * Auto-clear the cache when the provider/model changes to avoid mixing
 * incompatible vector dimensions.
 */
async function maybeHandleModelChange(provider, model) {
    const cache = getEmbeddingCache();
    const meta = await cache.getItem(CACHE_META_KEY);
    if (!meta || typeof meta !== 'object') return;
    if (meta.provider === provider && meta.model === model) return;

    await clearEmbeddingCache();
    const settings = ensureEmbeddingSettings();
    if (settings.dimensions !== null) {
        settings.dimensions = null;
        SillyTavern.getContext().saveSettingsDebounced();
    }
    if (typeof toastr !== 'undefined') {
        toastr.info('Embedding model changed — cleared the Scratch Pad embedding cache.');
    }
}

/* ------------------------------------------------------------------ */
/*  Public embedding API                                             */
/* ------------------------------------------------------------------ */

/**
 * Embed an array of texts, using the cache and batching by provider.
 * @param {string[]} texts
 * @param {{ onProgress?: (completed:number, total:number)=>void, _recovered?: boolean }} [options]
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, options = {}) {
    if (!Array.isArray(texts)) {
        throw new Error('embedTexts(texts) expects an array of strings.');
    }
    const normalizedTexts = texts.map(t => String(t ?? ''));
    const total = normalizedTexts.length;
    if (total === 0) return [];

    const settings = getEmbeddingSettings();
    if (!isEmbeddingConfigured()) {
        throw new Error('Embeddings are not configured. Set provider/model (and API key for cloud providers).');
    }

    const provider = settings.provider;
    const onProgress = options.onProgress;
    const cache = getEmbeddingCache();

    await maybeHandleModelChange(provider, String(settings.model).trim());

    const vectors = new Array(total);
    let completed = 0;
    const notify = () => { if (typeof onProgress === 'function') { try { onProgress(completed, total); } catch { /* ignore */ } } };
    notify();

    // Deduplicate by text so identical messages embed once.
    const uniqueByText = new Map();
    for (let i = 0; i < normalizedTexts.length; i++) {
        const text = normalizedTexts[i];
        const existing = uniqueByText.get(text);
        if (existing) {
            existing.indices.push(i);
        } else {
            uniqueByText.set(text, { hash: makeTextCacheKey(text), text, indices: [i] });
        }
    }

    const dimensionState = {
        expected: Number.isInteger(settings.dimensions) && settings.dimensions > 0 ? settings.dimensions : null,
        observed: null,
    };

    const uniqueItems = [...uniqueByText.values()];
    const cachedValues = await batchCacheGet(cache, uniqueItems);
    const pending = [];
    for (let ci = 0; ci < uniqueItems.length; ci++) {
        const item = uniqueItems[ci];
        const cached = cachedValues[ci];
        if (isUsableCacheEntry(cached, settings, dimensionState.expected, item.text)) {
            updateDimensionState(cached.dims, dimensionState);
            for (const idx of item.indices) vectors[idx] = cached.vector;
            completed += item.indices.length;
        } else {
            pending.push(item);
        }
    }
    notify();

    const batchSize = provider === 'ollama' ? OLLAMA_BATCH_SIZE : BATCH_SIZE;

    try {
        for (let i = 0; i < pending.length; i += batchSize) {
            const batch = pending.slice(i, i + batchSize);
            await sleep(0); // yield so the UI stays responsive
            const batchVectors = await embedBatch(provider, settings, batch.map(it => it.text));
            const writes = [];
            for (let j = 0; j < batch.length; j++) {
                const item = batch[j];
                const vector = batchVectors[j];
                const dims = Array.isArray(vector) ? vector.length : 0;
                updateDimensionState(dims, dimensionState);
                writes.push(cache.setItem(item.hash, {
                    vector, dims,
                    model: settings.model,
                    provider: settings.provider,
                    text: item.text,
                }));
                for (const idx of item.indices) vectors[idx] = vector;
                completed += item.indices.length;
            }
            await Promise.all(writes);
            notify();
        }
    } catch (error) {
        if (error instanceof EmbeddingDimensionMismatchError && !options._recovered) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Embedding dimensions changed. Clearing cache and re-embedding.');
            }
            await clearEmbeddingCache();
            const current = ensureEmbeddingSettings();
            current.dimensions = null;
            SillyTavern.getContext().saveSettingsDebounced();
            return embedTexts(normalizedTexts, { ...options, _recovered: true });
        }
        throw error;
    }

    const finalDims = dimensionState.expected ?? dimensionState.observed;
    if (finalDims) {
        const raw = ensureEmbeddingSettings();
        if (raw.dimensions !== finalDims) {
            raw.dimensions = finalDims;
            SillyTavern.getContext().saveSettingsDebounced();
        }
    }

    await cache.setItem(CACHE_META_KEY, { provider, model: settings.model, dimensions: finalDims ?? null });

    return vectors;
}

function updateDimensionState(dims, state) {
    if (!state.observed) {
        state.observed = dims;
    } else if (state.observed !== dims) {
        throw new Error(`Embedding provider returned mixed dimensions (${state.observed} vs ${dims}).`);
    }
    if (state.expected != null && dims !== state.expected) {
        throw new EmbeddingDimensionMismatchError(state.expected, dims);
    }
}

async function embedBatch(provider, settings, texts) {
    if (provider !== 'ollama') {
        return embedOpenAICompatible(provider, settings, texts);
    }
    if (ollamaBatchSupported) {
        try {
            return await embedOllamaBatch(settings, texts);
        } catch {
            ollamaBatchSupported = false;
        }
    }
    const out = [];
    for (const text of texts) {
        out.push(await embedOllamaSingle(settings, text));
    }
    return out;
}

/**
 * Convenience helper for embedding a single text.
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<number[]>}
 */
export async function embedText(text, options = {}) {
    const vectors = await embedTexts([String(text ?? '')], options);
    return vectors[0];
}

export async function clearEmbeddingCache() {
    const cache = getEmbeddingCache();
    await cache.clear();
}

/**
 * @returns {Promise<{ count: number, estimatedSizeKB: number }>}
 */
export async function getCacheStats() {
    const cache = getEmbeddingCache();
    let count = 0;
    let estimatedBytes = 0;
    await cache.iterate((value, key) => {
        if (key === CACHE_META_KEY) return;
        if (value && typeof value === 'object' && Array.isArray(value.vector)) {
            count += 1;
            estimatedBytes += (value.vector.length * 4) + (value.model ? value.model.length * 2 : 0) + 32;
        }
    });
    return { count, estimatedSizeKB: Math.round((estimatedBytes / 1024) * 10) / 10 };
}
