import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSwipeContext } from '../src/swipeContext.js';

const message = (is_user, swipes, swipe_id = 0) => ({
    is_user, name: is_user ? 'Player' : 'Character', swipes, swipe_id, mes: swipes[swipe_id],
});

test('finds the latest message of each role, skips system messages, and keeps chat unchanged', () => {
    const chat = [
        message(false, ['OLD_AI_A', 'OLD_AI_B']),
        message(true, ['USER_A', 'USER_B'], 1),
        message(false, ['AI_A', 'AI_B']),
        { ...message(false, ['SYSTEM_A', 'SYSTEM_B']), is_system: true },
    ];
    const original = structuredClone(chat);
    const context = buildSwipeContext(chat, 'both');
    assert.match(context, /Latest user message \(#1, Player\)/);
    assert.match(context, /Latest AI message \(#2, Character\)/);
    assert.match(context, /Swipe 2 \(currently selected\):\nUSER_B/);
    assert.match(context, /Swipe 1 \(currently selected\):\nAI_A/);
    assert.match(context, /not consecutive story events/);
    assert.match(context, /not paired branches/);
    assert.doesNotMatch(context, /OLD_AI|SYSTEM_/);
    assert.deepEqual(chat, original);
});

test('uses current displayed edits for the selected swipe and preserves original numbering', () => {
    const msg = message(true, ['OLD_EDIT', '', '   ', null, 'OTHER'], 0);
    msg.mes = 'NEW_EDIT';
    const context = buildSwipeContext([msg], 'user');
    assert.match(context, /Swipe 1 \(currently selected\):\nNEW_EDIT/);
    assert.match(context, /Swipe 5:\nOTHER/);
    assert.doesNotMatch(context, /OLD_EDIT|Swipe [234]/);
    assert.equal(msg.swipes[0], 'OLD_EDIT');
});

test('does not fall back to older swiped messages when the latest has no alternatives', () => {
    const chat = [message(false, ['OLDER_A', 'OLDER_B']), { is_user: false, mes: 'Latest' }];
    const context = buildSwipeContext(chat, 'both');
    assert.match(context, /Latest user message: unavailable/);
    assert.match(context, /Latest AI message \(#1, AI\): no alternate swipes available/);
    assert.doesNotMatch(context, /OLDER_/);
    assert.match(buildSwipeContext([message(true, ['Only', '', null])], 'user'), /no alternate swipes available/);
});

test('includes only the requested role and keeps disabled or unknown modes empty', () => {
    const chat = [message(true, ['USER_A', 'USER_B']), message(false, ['AI_A', 'AI_B'])];
    assert.doesNotMatch(buildSwipeContext(chat, 'user'), /AI_[AB]/);
    assert.doesNotMatch(buildSwipeContext(chat, 'assistant'), /USER_[AB]/);
    assert.equal(buildSwipeContext(chat), '');
    assert.equal(buildSwipeContext(chat, 'unknown'), '');
    assert.match(buildSwipeContext(undefined, 'both'), /unavailable/);
});

test('handles a missing or invalid selected index without dropping alternatives', () => {
    const msg = message(false, ['A', 'B']);
    delete msg.swipe_id;
    assert.match(buildSwipeContext([msg], 'assistant'), /Swipe 1 \(currently selected\)/);
    msg.swipe_id = 5;
    msg.mes = 'CURRENT';
    const context = buildSwipeContext([msg], 'assistant');
    assert.match(context, /Swipe 1:\nA/);
    assert.match(context, /Swipe 2:\nB/);
    assert.match(context, /swipe number unavailable\):\nCURRENT/);
    assert.doesNotMatch(context, /Swipe \d+ \(currently selected\)/);
});

test('every quoted swipe and invalid-index fallback is processed without changing stored data', () => {
    const msg = message(false, ['VISIBLE<junk>SECRET_A</junk>', '<junk>SECRET_B</junk>'], 0);
    msg.swipe_id = 9;
    msg.mes = 'CURRENT<junk>SECRET_C</junk>';
    const original = structuredClone(msg);
    const seen = [];
    const context = buildSwipeContext([msg], 'assistant', (text, source) => {
        assert.equal(source, msg);
        seen.push(text);
        return text.replace(/<junk>.*?<\/junk>/g, '');
    });
    assert.match(context, /Swipe 1:\nVISIBLE/);
    assert.match(context, /Swipe 2:\n\[Empty after prompt regex processing\]/);
    assert.match(context, /swipe number unavailable\):\nCURRENT/);
    assert.doesNotMatch(context, /SECRET|<junk>|no alternate swipes/);
    assert.equal(seen.length, 3);
    assert.deepEqual(msg, original);
});
