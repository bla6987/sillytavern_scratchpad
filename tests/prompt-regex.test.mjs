import test from 'node:test';
import assert from 'node:assert/strict';
import { regexMock, regex_placement } from './helpers/regex-engine.mjs';
import { createPromptRegexProcessor } from '../src/promptRegex.js';

test('prompt regex uses user/AI placements and full-chat visible depths without changing messages', async () => {
    const chat = [
        { is_user: true, mes: 'USER' },
        { is_system: true, mes: 'HIDDEN' },
        { is_user: false, mes: 'AI', swipes: ['AI', 'ALTERNATIVE'] },
        { is_system: true, mes: 'HIDDEN_TAIL' },
    ];
    const original = structuredClone(chat);
    regexMock.reset((text, placement, { depth }) => `${placement}:${depth}:${text}`);
    const process = await createPromptRegexProcessor(chat);

    assert.equal(process(chat[0].mes, chat[0]), '1:1:USER');
    assert.equal(process(chat[2].mes, chat[2]), '2:0:AI');
    assert.equal(process(chat[2].swipes[1], chat[2]), '2:0:ALTERNATIVE');
    assert.equal(process(chat[1].mes, chat[1]), '2:1:HIDDEN');
    assert.deepEqual(regexMock.calls.map(call => call.options), [
        { isPrompt: true, depth: 1 },
        { isPrompt: true, depth: 0 },
        { isPrompt: true, depth: 0 },
        { isPrompt: true, depth: 1 },
    ]);
    assert.deepEqual(chat, original);
});

test('hidden tool messages count toward depth only when ST supports tool calling', async () => {
    const chat = [
        { is_user: true, mes: 'USER' },
        { is_system: true, mes: 'TOOL', extra: { tool_invocations: [] } },
        { is_user: false, mes: 'AI' },
    ];
    regexMock.reset();
    (await createPromptRegexProcessor(chat))(chat[0].mes, chat[0]);
    (await createPromptRegexProcessor(chat, true))(chat[0].mes, chat[0]);
    assert.deepEqual(regexMock.calls.map(call => call.options.depth), [1, 2]);
});

test('the selected version shared by history and swipe context is processed once per prompt', async () => {
    const chat = [{ is_user: true, mes: 'SELECTED' }];
    regexMock.reset(text => `${text}!`);
    const process = await createPromptRegexProcessor(chat);
    assert.equal(process('SELECTED', chat[0]), 'SELECTED!');
    assert.equal(process('SELECTED', chat[0]), 'SELECTED!');
    assert.equal(regexMock.calls.length, 1);
    assert.equal(regexMock.calls[0].placement, regex_placement.USER_INPUT);
});
