import assert from 'node:assert/strict';
import fs from 'node:fs';

async function loadAuthorsNoteModule() {
    const sourcePath = new URL('../src/authorsNote.js', import.meta.url);
    const code = fs.readFileSync(sourcePath, 'utf8');
    return await import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const authorsNote = await loadAuthorsNoteModule();

{
    const parts = ['--- USER QUESTION ---', 'Q'];
    authorsNote.appendAuthorsNoteToPromptParts(parts, false, 'secret note');
    assert.deepEqual(parts, ['--- USER QUESTION ---', 'Q']);
}

{
    const parts = [];
    authorsNote.appendAuthorsNoteToPromptParts(parts, true, 'secret note');
    assert.deepEqual(parts, ["--- AUTHOR'S NOTE ---", 'secret note']);
}

{
    const messages = [];
    authorsNote.appendAuthorsNoteToMessages(messages, false, 'note');
    assert.equal(messages.length, 0);
}

{
    const messages = [];
    authorsNote.appendAuthorsNoteToMessages(messages, true, 'note');
    assert.deepEqual(messages, [{ role: 'system', content: "Author's Note: note" }]);
}

{
    const parts = [];
    const messages = [];
    authorsNote.appendAuthorsNoteToPromptParts(parts, true, '');
    authorsNote.appendAuthorsNoteToMessages(messages, true, '');
    assert.equal(parts.length, 0);
    assert.equal(messages.length, 0);
}

{
    const setCalls = [];
    const context = {
        extensionPrompts: {
            '2_floating_prompt': {
                value: 'saved note',
                position: 2,
                depth: 5,
                scan: true,
                role: 1,
            },
        },
        setExtensionPrompt: (...args) => setCalls.push(args),
    };

    const restore = authorsNote.suppressAuthorsNoteForGeneration(context, false);
    assert.equal(setCalls.length, 1);
    assert.deepEqual(setCalls[0], ['2_floating_prompt', '', 2, 5, true, 1]);

    restore();
    assert.equal(setCalls.length, 2);
    assert.deepEqual(setCalls[1], ['2_floating_prompt', 'saved note', 2, 5, true, 1]);
}

{
    const warnings = [];
    const context = {
        extensionPrompts: {},
        setExtensionPrompt: () => {
            throw new Error('should not be called when prompt is missing');
        },
    };
    const logger = { warn: (msg) => warnings.push(msg) };

    const restore = authorsNote.suppressAuthorsNoteForGeneration(context, false, logger);
    restore();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /includeAuthorsNote=false/);
}

console.log("author's note tests passed");
