import assert from 'node:assert/strict';

// draftStore.js has no imports and no SillyTavern/DOM access, so it loads under plain node.
const {
    NEW_THREAD_DRAFT_KEY,
    getDraft,
    setDraft,
    prependToDraft,
    deleteDraft,
    clearDrafts,
    getDraftCount,
    joinDraftText,
} = await import(new URL('../src/draftStore.js', import.meta.url));

/* ---- set/get, kept as typed and separate per key ---- */
{
    clearDrafts();
    setDraft('a', 'hello ');
    setDraft('b', 'line1\nline2');
    setDraft(NEW_THREAD_DRAFT_KEY, 'new thread text');
    assert.equal(getDraft('a'), 'hello '); // not trimmed
    assert.equal(getDraft('b'), 'line1\nline2');
    assert.equal(getDraft(NEW_THREAD_DRAFT_KEY), 'new thread text');
    setDraft('a', 'replaced');
    assert.equal(getDraft('a'), 'replaced');
    assert.equal(getDraftCount(), 3);
}

/* ---- missing key → '' ---- */
{
    clearDrafts();
    assert.equal(getDraft('missing'), '');
    assert.equal(getDraftCount(), 0);
}

/* ---- empty or whitespace-only text deletes the entry ---- */
{
    clearDrafts();
    setDraft('a', 'x');
    setDraft('a', '');
    assert.equal(getDraft('a'), '');
    assert.equal(getDraftCount(), 0);

    setDraft('b', 'x');
    setDraft('b', '  \n\t ');
    assert.equal(getDraftCount(), 0);

    setDraft('c', '   '); // never stored in the first place
    setDraft('d', undefined);
    assert.equal(getDraftCount(), 0);
}

/* ---- prependToDraft puts the new text first ---- */
{
    clearDrafts();
    setDraft('a', 'typed later');
    prependToDraft('a', 'queued earlier');
    assert.equal(getDraft('a'), 'queued earlier\n\ntyped later');

    prependToDraft('missing', 'only text'); // into a missing key
    assert.equal(getDraft('missing'), 'only text');

    prependToDraft('a', '   '); // blank text changes nothing
    assert.equal(getDraft('a'), 'queued earlier\n\ntyped later');

    prependToDraft('empty', ''); // blank into a missing key stores nothing
    assert.equal(getDraft('empty'), '');
    assert.equal(getDraftCount(), 2);
}

/* ---- deleteDraft and clearDrafts ---- */
{
    clearDrafts();
    setDraft('a', 'x');
    setDraft('b', 'y');
    deleteDraft('a');
    deleteDraft('missing'); // no-op
    assert.equal(getDraft('a'), '');
    assert.equal(getDraft('b'), 'y');
    assert.equal(getDraftCount(), 1);

    setDraft(NEW_THREAD_DRAFT_KEY, 'z');
    clearDrafts();
    assert.equal(getDraftCount(), 0);
    assert.equal(getDraft('b'), '');
    assert.equal(getDraft(NEW_THREAD_DRAFT_KEY), '');
}

/* ---- joinDraftText ---- */
{
    assert.equal(joinDraftText('one', 'two'), 'one\n\ntwo');
    assert.equal(joinDraftText('one', '', '   ', null, undefined, 'two'), 'one\n\ntwo');
    assert.equal(joinDraftText('only'), 'only');
    assert.equal(joinDraftText(), '');
    assert.equal(joinDraftText('', undefined), '');
    assert.equal(joinDraftText('line1\nline2', 'three'), 'line1\nline2\n\nthree'); // inner newlines kept
}

/* ---- scale: thousands of threads leave nothing behind ---- */
{
    clearDrafts();
    const count = 5000;
    for (let i = 0; i < count; i++) {
        setDraft(`thread-${i}`, `draft ${i}`);
    }
    assert.equal(getDraftCount(), count);
    assert.equal(getDraft('thread-4321'), 'draft 4321');
    for (let i = 0; i < count; i++) {
        deleteDraft(`thread-${i}`);
    }
    assert.equal(getDraftCount(), 0);
}

console.log('draft-store tests passed');
