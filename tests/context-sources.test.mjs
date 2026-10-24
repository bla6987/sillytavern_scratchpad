import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCharacterCardsContext,
    buildPersonaContext,
    buildWorldInfoContext,
    filterHiddenMessages,
    formatChatHistory,
    getChatCharacters,
    getLatestSummary,
    getUserName,
} from '../src/contextSources.js';

const characters = [
    { name: 'Seraphina', avatar: 'sera.png', description: 'Guardian of the forest' },
    { name: 'Bob', avatar: 'bob.png', description: 'A traveling merchant' },
    { name: 'Muted', avatar: 'muted.png', description: 'Should not appear' },
];

test('single chats use the selected character card', () => {
    const context = { characters, characterId: 1, groupId: undefined };
    assert.deepEqual(getChatCharacters(context).map(c => c.name), ['Bob']);
    assert.match(buildCharacterCardsContext(context), /Character Name: Bob/);
    assert.doesNotMatch(buildCharacterCardsContext(context), /Seraphina/);
});

test('group chats include every member card except muted members', () => {
    const context = {
        characters,
        characterId: undefined,
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['sera.png', 'bob.png', 'muted.png', 'missing.png'], disabled_members: ['muted.png'] }],
    };
    assert.deepEqual(getChatCharacters(context).map(c => c.name), ['Seraphina', 'Bob']);

    const cards = buildCharacterCardsContext(context);
    assert.match(cards, /Character Name: Seraphina/);
    assert.match(cards, /Guardian of the forest/);
    assert.match(cards, /Character Name: Bob/);
    assert.doesNotMatch(cards, /Muted/);
    assert.match(cards, /\n---\n/, 'cards are separated');
});

test('group chats prefer the group even when a character id is set', () => {
    const context = {
        characters,
        characterId: 0,
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['bob.png'] }],
    };
    assert.deepEqual(getChatCharacters(context).map(c => c.name), ['Bob']);
});

test('no character selected gives no cards', () => {
    assert.equal(buildCharacterCardsContext({ characters, characterId: undefined }), '');
    assert.equal(buildCharacterCardsContext({}), '');
});

test('persona uses the persona name and description', () => {
    const context = { name1: 'Aria', powerUserSettings: { persona_description: '  A wandering bard.  ' } };
    assert.equal(getUserName(context), 'Aria');
    assert.equal(buildPersonaContext(context), 'Name: Aria\n\nDescription: A wandering bard.');
    assert.equal(buildPersonaContext({ name1: 'Aria', powerUserSettings: { persona_description: ' ' } }), '');
    assert.equal(getUserName({}), 'User');
});

test('hidden messages are dropped and speakers are named', () => {
    const chat = [
        { is_user: true, name: 'Aria', mes: 'Hello' },
        { is_user: false, name: 'Seraphina', mes: 'Secret', is_system: true },
        { is_user: false, name: 'Seraphina', mes: 'Welcome' },
        { is_user: true, mes: 'No name stored' },
    ];
    const visible = filterHiddenMessages(chat.map((message, number) => ({ ...message, scratchPadMessageNumber: number })));
    assert.equal(visible.length, 3);
    assert.equal(formatChatHistory(visible, 'Aria'), '[Message #0 | Aria]\nHello\n\n[Message #2 | Seraphina]\nWelcome\n\n[Message #3 | Aria]\nNo name stored');
});

test('latest summary comes from the newest message carrying one', () => {
    const chat = [
        { mes: 'a', extra: { memory: 'Old summary' } },
        { mes: 'b', extra: { memory: 'New summary' } },
        { mes: 'c', extra: {} },
    ];
    assert.equal(getLatestSummary(chat), 'New summary');
    assert.equal(getLatestSummary([{ mes: 'x' }]), '');
    assert.equal(getLatestSummary(null), '');
});

test('world info is scanned as a dry run with the question as the newest message', async () => {
    const calls = [];
    const context = {
        name1: 'Aria',
        maxContext: 8000,
        getCharacterCardFields: () => ({ persona: 'P', description: 'D', personality: 'Pe', scenario: 'S', creatorNotes: 'C', charDepthPrompt: 'CD' }),
        getWorldInfoPrompt: async (...args) => {
            calls.push(args);
            return {
                worldInfoBefore: 'Before entry',
                worldInfoAfter: 'After entry',
                worldInfoDepth: [{ depth: 2, role: 0, entries: ['Depth entry'] }],
                anBefore: ['AN entry'],
                anAfter: [],
                worldInfoExamples: [{ position: 5, content: 'Example entry' }],
            };
        },
    };
    const chat = [
        { is_user: true, name: 'Aria', mes: 'first' },
        { is_user: false, name: 'Bob', mes: 'second' },
    ];

    const text = await buildWorldInfoContext(context, chat, 'Who is the king?', 4000);
    assert.equal(text, 'Before entry\n\nAfter entry\n\nDepth entry\n\nAN entry\n\nExample entry');

    const [scanChat, budget, isDryRun, globalScanData] = calls[0];
    assert.deepEqual(scanChat, ['Aria: Who is the king?', 'Bob: second', 'Aria: first']);
    assert.equal(budget, 4000);
    assert.equal(isDryRun, true);
    assert.equal(globalScanData.characterDescription, 'D');
    assert.equal(globalScanData.personaDescription, 'P');
    assert.equal(globalScanData.trigger, 'normal');
});

test('world info is skipped when SillyTavern does not provide the scanner', async () => {
    assert.equal(await buildWorldInfoContext({}, [], 'q'), '');
});
