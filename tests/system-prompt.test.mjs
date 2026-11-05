import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSystemPrompt } from '../src/systemPrompt.js';

function setup() {
    return { mainApi: 'openai', characterId: 0, chatMetadata: {},
        characters: [{ data: { system_prompt: 'Card override: {{original}}' } }],
        powerUserSettings: { prefer_character_prompt: true },
        chatCompletionSettings: { prompts: [{ identifier: 'main', content: 'Main instructions' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] },
        substituteParams: (text, { original }) => text.replaceAll('{{original}}', original),
    };
}

test('system prompt follows chat/card/preset precedence and override preference', () => {
    const context = setup();
    assert.equal(resolveSystemPrompt(context), 'Card override: Main instructions');
    context.chatMetadata.system_prompt = 'Chat override';
    assert.equal(resolveSystemPrompt(context), 'Chat override');
    context.powerUserSettings.prefer_character_prompt = false;
    assert.equal(resolveSystemPrompt(context), 'Main instructions');
    context.powerUserSettings.prefer_character_prompt = true;
    context.chatCompletionSettings.prompts[0].forbid_overrides = true;
    assert.equal(resolveSystemPrompt(context), 'Main instructions');
});

test('disabled or untriggered Prompt Manager main prompt stays excluded', () => {
    const context = setup();
    const main = context.chatCompletionSettings.prompts[0];
    context.chatCompletionSettings.prompt_order[0].order[0].enabled = false;
    assert.equal(resolveSystemPrompt(context), '');
    context.chatCompletionSettings.prompt_order[0].order[0].enabled = true;
    main.injection_trigger = ['continue'];
    assert.equal(resolveSystemPrompt(context), '');
});

test('host Prompt Manager prepares the selected override without modifying its prompt', () => {
    const context = setup();
    const main = { content: 'Host main', forbid_overrides: false };
    const manager = { getPromptCollection: () => ({ get: () => main }), isPromptDisabledForActiveCharacter: () => false,
        preparePrompt: (prompt, original) => ({ content: prompt.content.replace('{{original}}', original) }) };
    assert.equal(resolveSystemPrompt(context, manager), 'Card override: Host main');
    assert.equal(main.content, 'Host main');
});

test('text completion uses only the enabled system prompt and honors the character preference', () => {
    const context = setup();
    context.mainApi = 'textgenerationwebui';
    context.powerUserSettings.sysprompt = { enabled: true, content: 'Text system' };
    assert.equal(resolveSystemPrompt(context), 'Card override: Text system');
    context.powerUserSettings.prefer_character_prompt = false;
    assert.equal(resolveSystemPrompt(context), 'Text system');
    context.powerUserSettings.sysprompt.enabled = false;
    assert.equal(resolveSystemPrompt(context), '');
});
