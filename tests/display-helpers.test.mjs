import test from 'node:test';
import assert from 'node:assert/strict';

import { formatPromptStats, formatTokenCount, escapeHtml } from '../src/ui/components.js';
import { appendBlock } from '../src/chatActions.js';
import { parseQuickPrompts } from '../src/settings.js';

test('token counts are compact', () => {
    assert.equal(formatTokenCount(950), '950');
    assert.equal(formatTokenCount(1000), '1k');
    assert.equal(formatTokenCount(12345), '12.3k');
    assert.equal(formatTokenCount(128000), '128k');
    assert.equal(formatTokenCount(undefined), '?');
});

test('context stats summarize usage and trimming', () => {
    const untrimmed = formatPromptStats({ promptTokens: 12345, tokenBudget: 32000, chatMessages: 40, chatMessagesTrimmed: 0, threadMessagesTrimmed: 0 });
    assert.equal(untrimmed.summary, 'Context: 12.3k / 32k tokens');
    assert.equal(untrimmed.trimmed, 0);
    assert.match(untrimmed.detail, /Main chat messages sent: 40/);
    assert.doesNotMatch(untrimmed.detail, /Dropped/);

    const trimmed = formatPromptStats({ promptTokens: 31900, tokenBudget: 32000, chatMessages: 80, chatMessagesTrimmed: 40, threadMessagesTrimmed: 2 });
    assert.equal(trimmed.summary, 'Context: 31.9k / 32k tokens · trimmed 42 older messages');
    assert.match(trimmed.detail, /Dropped to fit the context window: 40 main chat, 2 Scratch Pad messages/);

    const noBudget = formatPromptStats({ promptTokens: 500, tokenBudget: null, chatMessages: 3 });
    assert.equal(noBudget.summary, 'Context: 500 tokens');

    assert.equal(formatPromptStats(null), null);
    assert.equal(formatPromptStats({}), null);
});

test('html is escaped for toasts', () => {
    assert.equal(escapeHtml('<b>"Tom" & \'Jerry\'</b>'), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
});

test('text sent to the chat goes after existing text with a blank line', () => {
    assert.equal(appendBlock('', 'new'), 'new');
    assert.equal(appendBlock(undefined, 'new'), 'new');
    assert.equal(appendBlock('existing  \n', 'new'), 'existing\n\nnew');
});

test('quick prompts are read one per line', () => {
    assert.deepEqual(parseQuickPrompts('  First \n\n Second\n  '), ['First', 'Second']);
    assert.deepEqual(parseQuickPrompts(''), []);
});
