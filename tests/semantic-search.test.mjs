import assert from 'node:assert/strict';

// These modules pull in storage.js / embeddings.js via static imports, but none
// of them touch SillyTavern at module scope, so a real file-URL import loads
// cleanly under plain node (unlike the data-URL trick, relative imports resolve).
const semantic = await import(new URL('../src/semanticSearch.js', import.meta.url));
const embeddings = await import(new URL('../src/embeddings.js', import.meta.url));

const {
    cosineSimilarity,
    combineScore,
    scoreEntries,
    reduceToBestPerThread,
    SEMANTIC_WEIGHT,
    KEYWORD_WEIGHT,
} = semantic;
const { fnv1aHash32, makeTextCacheKey } = embeddings;

function approx(actual, expected, eps = 1e-9) {
    assert.ok(Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`);
}

/* ---- cosineSimilarity ---- */
{
    approx(cosineSimilarity([1, 0], [1, 0]), 1);          // identical
    approx(cosineSimilarity([1, 0], [0, 1]), 0);          // orthogonal
    approx(cosineSimilarity([1, 0], [-1, 0]), -1);        // opposite
    approx(cosineSimilarity([2, 0], [5, 0]), 1);          // scale-invariant
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0); // length mismatch → 0
    assert.equal(cosineSimilarity([], []), 0);            // empty → 0
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);    // zero vector → 0
}

/* ---- combineScore (0.7 semantic + 0.3 keyword) ---- */
{
    assert.equal(SEMANTIC_WEIGHT, 0.7);
    assert.equal(KEYWORD_WEIGHT, 0.3);
    approx(combineScore(1, true), 1.0);
    approx(combineScore(1, false), 0.7);
    approx(combineScore(0, true), 0.3);
    approx(combineScore(0, false), 0);
    approx(combineScore(0.5, false), 0.35);
}

/* ---- scoreEntries ---- */
{
    const entries = [
        { threadId: 't1', text: 'alpha', branchLabel: 'Current branch' },
        { threadId: 't1', text: 'beta', branchLabel: 'Current branch' },
        { threadId: 't2', text: 'gamma', branchLabel: 'Other branch' },
        { threadId: 't3', text: 'novec', branchLabel: 'Current branch' },
    ];
    const vectors = { alpha: [1, 0], beta: [0, 1], gamma: [1, 0] }; // novec missing
    const queryVector = [1, 0];
    const scored = scoreEntries(entries, (t) => vectors[t], queryVector, 'alpha');

    // Entry without a vector is skipped entirely.
    assert.equal(scored.length, 3);
    const byText = Object.fromEntries(scored.map(s => [s.text, s]));

    approx(byText.alpha.semantic, 1);
    assert.equal(byText.alpha.keywordHit, true);  // 'alpha' contains query 'alpha'
    approx(byText.alpha.combined, 1.0);

    approx(byText.beta.semantic, 0);
    assert.equal(byText.beta.keywordHit, false);
    approx(byText.beta.combined, 0);

    approx(byText.gamma.semantic, 1);
    assert.equal(byText.gamma.keywordHit, false); // 'gamma' lacks 'alpha'
    approx(byText.gamma.combined, 0.7);
}

/* ---- reduceToBestPerThread ---- */
{
    const scored = [
        { threadId: 't1', text: 'a', combined: 0.4 },
        { threadId: 't1', text: 'b', combined: 0.9 }, // best for t1
        { threadId: 't2', text: 'c', combined: 0.6 },
        { threadId: 't2', text: 'd', combined: 0.2 },
    ];
    const best = reduceToBestPerThread(scored);
    assert.equal(best.length, 2);                 // one per thread
    assert.equal(best[0].threadId, 't1');         // sorted by combined desc
    assert.equal(best[0].text, 'b');              // best variant kept
    approx(best[0].combined, 0.9);
    assert.equal(best[1].threadId, 't2');
    assert.equal(best[1].text, 'c');
}

/* ---- hashing ---- */
{
    assert.equal(fnv1aHash32(''), '811c9dc5');           // seed for empty string
    assert.equal(fnv1aHash32('abc'), fnv1aHash32('abc')); // deterministic
    assert.notEqual(fnv1aHash32('abc'), fnv1aHash32('abd'));

    const key = makeTextCacheKey('hello world');
    assert.match(key, /^txt_[0-9a-f]{16}_[0-9a-f]+$/);   // format
    assert.equal(makeTextCacheKey('hello world'), key);   // stable
    assert.notEqual(makeTextCacheKey('hello world'), makeTextCacheKey('hello worlD'));
}

console.log('semantic-search.test.mjs: all assertions passed');
