import test from 'node:test';
import assert from 'node:assert/strict';

import { neutralizeSlashCommandText } from '../src/generation.js';
import { speakText, isTTSAvailable } from '../src/tts.js';
import { renderMarkdown } from '../src/ui/components.js';

// What SillyTavern does to an escaped unnamed argument: the parser drops the
// backslash before `|` and `{:`, then the closure unescapes `\{` and `\}`
function stUnescape(text) {
    return text.replace(/\\\|/g, '|').replace(/\\\{/g, '{').replace(/\\\}/g, '}');
}

test('guidance text cannot end the slash command, open a closure or expand a macro', () => {
    const attack = 'Nice reply | /delchat | {: /echo hi :}() {{user}} {{setvar::x::1}}';
    const safe = neutralizeSlashCommandText(attack);

    assert.doesNotMatch(safe, /(^|[^\\])\|/, 'every pipe is escaped');
    assert.doesNotMatch(safe, /(^|[^\\])\{/, 'every opening brace is escaped');
    assert.doesNotMatch(safe, /(^|[^\\])\}/, 'every closing brace is escaped');
    assert.doesNotMatch(safe, /\{\{|:\}/, 'no macro opener or closure end survives');
    assert.equal(stUnescape(safe), attack, 'the guidance reads the same after SillyTavern unescapes it');
});

test('existing backslashes cannot cancel the escapes', () => {
    const safe = neutralizeSlashCommandText('a \\| /delchat \\\\{: x :}');
    assert.equal(safe, 'a \\| /delchat \\{: x :\\}');
});

test('a leading key=value is not read as a named argument', () => {
    assert.equal(neutralizeSlashCommandText('depth=0 role=user hi'), 'depth\\=0 role=user hi');
    assert.equal(neutralizeSlashCommandText('  id=x'), '  id\\=x');
    assert.equal(neutralizeSlashCommandText('Say x=1'), 'Say x=1');
    assert.equal(neutralizeSlashCommandText(null), '');
});

function setupTts({ voice = '', speak } = {}) {
    const calls = [];
    const executed = [];
    const context = {
        extensionSettings: { scratchPad: { ttsEnabled: true, ttsVoice: voice } },
        executeSlashCommandsWithOptions: async (command) => {
            executed.push(command);
            return {};
        },
        SlashCommandParser: {
            commands: speak === null ? {} : {
                speak: { callback: speak ?? (async (args, value) => { calls.push([args, value]); return ''; }) },
            },
        },
    };
    globalThis.SillyTavern = { getContext: () => context };
    return { calls, executed };
}

test('TTS hands the text to the /speak callback without building a command string', async () => {
    const { calls, executed } = setupTts({ voice: ' Narrator ' });
    const text = 'Hello | /delchat {: /echo hi :}() voice=evil';

    assert.equal(await speakText(text), true);
    assert.deepEqual(executed, [], 'no STscript is executed');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], { voice: 'Narrator' });
    assert.equal(calls[0][1], 'Hello | /delchat {: /echo hi :}() voice=evil');
});

test('TTS strips macro braces and omits an empty voice', async () => {
    const { calls } = setupTts();
    assert.equal(await speakText('Hi {{user}}, {{setvar::x::1}}'), true);
    assert.deepEqual(calls[0][0], {});
    assert.equal(calls[0][1], 'Hi user, setvar::x::1');
});

test('TTS is unavailable without the /speak command', async () => {
    setupTts({ speak: null });
    assert.equal(isTTSAvailable(), false);
    assert.equal(await speakText('Hello'), false);
});

test('markdown is sanitized with a strict config', () => {
    const configs = [];
    globalThis.SillyTavern = {
        libs: {
            showdown: { Converter: class { makeHtml(text) { return `<p>${text}</p>`; } } },
            DOMPurify: { sanitize(html, config) { configs.push(config); return html; } },
        },
    };

    renderMarkdown('<style>body{display:none}</style>');
    const [config] = configs;
    assert.ok(config.FORBID_TAGS.includes('style'));
    assert.ok(config.FORBID_TAGS.includes('form'));
    assert.ok(config.FORBID_ATTR.includes('style'));
    assert.ok(config.FORBID_ATTR.includes('id'));
    assert.equal(config.MESSAGE_SANITIZE, true);
});
