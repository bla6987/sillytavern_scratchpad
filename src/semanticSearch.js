/**
 * Semantic search for Scratch Pad threads.
 *
 * Builds a corpus of thread titles + message variants, embeds them lazily
 * (cache-first), then ranks threads against an embedded query using a hybrid
 * score `0.7 * cosineSimilarity + 0.3 * keywordHit` — mirroring the approach in
 * the sibling `chat_manager` extension.
 *
 * The scoring/dedup helpers are pure (no SillyTavern/browser dependencies) so
 * they can be unit-tested directly.
 */

import { getThreads, getCurrentChatLength } from './storage.js';
import { embedTexts, embedText, getCachedEmbeddingsForTexts, isSemanticSearchEnabled } from './embeddings.js';

const MAX_EMBED_CHARS = 8000;
const SNIPPET_RADIUS = 42;
export const SEMANTIC_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;
/** Minimum combined score for a thread to be shown (unless a keyword hit). */
export const MIN_COMBINED_SCORE = 0.2;

/** In-memory query → vector cache (small LRU-ish). */
const queryEmbeddingCache = new Map();
const QUERY_CACHE_LIMIT = 32;

/* ------------------------------------------------------------------ */
/*  Pure math / scoring (unit-tested)                                */
/* ------------------------------------------------------------------ */

/**
 * Cosine similarity in [-1, 1]. Returns 0 for degenerate vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
        return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        dot += ai * bi;
        normA += ai * ai;
        normB += bi * bi;
    }
    if (normA <= 1e-12 || normB <= 1e-12) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Hybrid score for one corpus entry.
 * @param {number} semantic Cosine similarity in [-1, 1]
 * @param {boolean} keywordHit Whether the entry text contains the query
 * @returns {number}
 */
export function combineScore(semantic, keywordHit) {
    return (SEMANTIC_WEIGHT * semantic) + (KEYWORD_WEIGHT * (keywordHit ? 1 : 0));
}

/**
 * Score corpus entries against a query vector.
 * Pure: callers provide the per-text vector lookup.
 * @param {Array<{threadId:string, text:string, branchLabel:string, isTitle?:boolean}>} entries
 * @param {(text:string)=>(number[]|null|undefined)} vectorFor
 * @param {number[]} queryVector
 * @param {string} query
 * @returns {Array<object>} Scored entries (unsorted)
 */
export function scoreEntries(entries, vectorFor, queryVector, query) {
    const queryLower = String(query || '').toLowerCase();
    const scored = [];
    for (const entry of entries) {
        const vector = vectorFor(entry.text);
        if (!Array.isArray(vector) || vector.length === 0) continue;
        const semantic = cosineSimilarity(queryVector, vector);
        const textLower = entry.text.toLowerCase();
        const matchIndex = queryLower ? textLower.indexOf(queryLower) : -1;
        const keywordHit = matchIndex >= 0;
        const combined = combineScore(semantic, keywordHit);
        scored.push({ ...entry, semantic, keywordHit, matchIndex, combined });
    }
    return scored;
}

/**
 * Reduce scored entries to one best result per thread.
 * @param {Array<object>} scored
 * @returns {Array<object>} Best entry per threadId, sorted by combined desc
 */
export function reduceToBestPerThread(scored) {
    const bestByThread = new Map();
    for (const entry of scored) {
        const current = bestByThread.get(entry.threadId);
        if (!current || entry.combined > current.combined) {
            bestByThread.set(entry.threadId, entry);
        }
    }
    return [...bestByThread.values()].sort((a, b) => b.combined - a.combined);
}

/* ------------------------------------------------------------------ */
/*  Corpus building (SillyTavern data)                               */
/* ------------------------------------------------------------------ */

function truncateForEmbedding(text) {
    const s = String(text ?? '');
    return s.length > MAX_EMBED_CHARS ? s.slice(0, MAX_EMBED_CHARS) : s;
}

/**
 * Searchable text variants for a message (active content + unique swipes).
 * Mirrors getMessageSearchTexts in ui/threadList.js.
 * @param {object} message
 * @returns {string[]}
 */
function getMessageSearchTexts(message) {
    const texts = [];
    const seen = new Set();
    for (const text of [message?.content, ...(Array.isArray(message?.swipes) ? message.swipes : [])]) {
        if (!text || seen.has(text)) continue;
        seen.add(text);
        texts.push(text);
    }
    return texts;
}

function getMessageBranchLabel(message, currentLength) {
    if (currentLength === null || message.chatMessageIndex === undefined || message.chatMessageIndex === null) {
        return 'Current branch';
    }
    return message.chatMessageIndex <= currentLength ? 'Current branch' : 'Other branch';
}

/**
 * Build the searchable corpus from all threads in the current chat.
 * @returns {{ entries: Array<object>, threadsById: Map<string, object>, texts: string[] }}
 */
export function buildCorpus() {
    const threads = getThreads();
    const currentLength = getCurrentChatLength();
    const entries = [];
    const threadsById = new Map();
    const textSet = new Set();

    for (const thread of threads) {
        threadsById.set(thread.id, thread);

        const titleText = truncateForEmbedding(thread.name || '');
        if (titleText.trim()) {
            entries.push({
                threadId: thread.id,
                messageId: null,
                swipeIndex: null,
                isTitle: true,
                text: titleText,
                branchLabel: 'Current branch',
            });
            textSet.add(titleText);
        }

        for (const msg of thread.messages || []) {
            const branchLabel = getMessageBranchLabel(msg, currentLength);
            const variants = getMessageSearchTexts(msg);
            for (let i = 0; i < variants.length; i++) {
                const text = truncateForEmbedding(variants[i]);
                if (!text.trim()) continue;
                entries.push({
                    threadId: thread.id,
                    messageId: msg.id,
                    swipeIndex: i,
                    isTitle: false,
                    text,
                    branchLabel,
                });
                textSet.add(text);
            }
        }
    }

    return { entries, threadsById, texts: [...textSet] };
}

/**
 * Ensure embeddings exist for all corpus texts (cache-first, embeds misses).
 * @param {string[]} texts Unique corpus texts
 * @param {{ onProgress?: (completed:number, total:number)=>void }} [options]
 * @returns {Promise<Map<string, number[]>>} text → vector
 */
export async function ensureIndex(texts, options = {}) {
    const map = new Map();
    if (!texts.length) return map;

    const cached = await getCachedEmbeddingsForTexts(texts);
    const missing = [];
    for (let i = 0; i < texts.length; i++) {
        if (Array.isArray(cached[i]) && cached[i].length) {
            map.set(texts[i], cached[i]);
        } else {
            missing.push(texts[i]);
        }
    }

    if (missing.length) {
        const vectors = await embedTexts(missing, options);
        for (let i = 0; i < missing.length; i++) {
            if (Array.isArray(vectors[i]) && vectors[i].length) {
                map.set(missing[i], vectors[i]);
            }
        }
    }

    return map;
}

async function getQueryVector(query) {
    const trimmed = String(query || '').trim();
    if (queryEmbeddingCache.has(trimmed)) {
        return queryEmbeddingCache.get(trimmed);
    }
    const vector = await embedText(trimmed);
    queryEmbeddingCache.set(trimmed, vector);
    if (queryEmbeddingCache.size > QUERY_CACHE_LIMIT) {
        const firstKey = queryEmbeddingCache.keys().next().value;
        queryEmbeddingCache.delete(firstKey);
    }
    return vector;
}

/** Clear the transient query-embedding cache (e.g. on chat change). */
export function resetQueryCache() {
    queryEmbeddingCache.clear();
}

/**
 * Best-effort incremental indexing: embed freshly created text in the
 * background so the next semantic search is instant. No-op unless semantic
 * search is enabled+configured. Errors are swallowed — lazy sync will catch up.
 * @param {string|string[]} texts
 */
export function warmEmbeddings(texts) {
    if (!isSemanticSearchEnabled()) return;
    const list = (Array.isArray(texts) ? texts : [texts])
        .map(t => truncateForEmbedding(t))
        .filter(t => t.trim());
    if (!list.length) return;
    Promise.resolve()
        .then(() => embedTexts(list))
        .catch(() => { /* best-effort; ignore */ });
}

function createSnippet(text, query, matchIndex) {
    if (matchIndex >= 0) {
        const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
        const end = Math.min(text.length, matchIndex + query.length + SNIPPET_RADIUS);
        const prefix = start > 0 ? '...' : '';
        const suffix = end < text.length ? '...' : '';
        return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
    }
    const head = text.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, ' ').trim();
    return text.length > head.length ? `${head}...` : head;
}

/**
 * Run a semantic search over all threads in the current chat.
 * @param {string} query
 * @param {{ maxResults?: number, onProgress?: (completed:number, total:number)=>void }} [options]
 * @returns {Promise<Array<{thread:object, snippet:string, matchType:string, branchLabel:string, score:number}>>}
 */
export async function searchThreadsSemantic(query, options = {}) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return [];

    const { entries, threadsById, texts } = buildCorpus();
    if (!entries.length) return [];

    const [vectorMap, queryVector] = await Promise.all([
        ensureIndex(texts, { onProgress: options.onProgress }),
        getQueryVector(trimmed),
    ]);

    if (!Array.isArray(queryVector) || queryVector.length === 0) return [];

    const scored = scoreEntries(entries, (text) => vectorMap.get(text), queryVector, trimmed);
    const best = reduceToBestPerThread(scored)
        .filter(entry => entry.combined >= MIN_COMBINED_SCORE || entry.keywordHit);

    const limit = Number.isInteger(options.maxResults) ? options.maxResults : best.length;
    const results = [];
    for (const entry of best.slice(0, limit)) {
        const thread = threadsById.get(entry.threadId);
        if (!thread) continue;
        results.push({
            thread,
            snippet: createSnippet(entry.text, trimmed.toLowerCase(), entry.matchIndex),
            matchType: 'Semantic',
            branchLabel: entry.branchLabel,
            score: entry.combined,
        });
    }
    return results;
}
