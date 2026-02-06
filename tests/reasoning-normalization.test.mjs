import assert from 'node:assert/strict';
import fs from 'node:fs';

async function loadReasoningModule() {
    const sourcePath = new URL('../src/reasoning.js', import.meta.url);
    const code = fs.readFileSync(sourcePath, 'utf8');
    return await import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const reasoning = await loadReasoningModule();

{
    const parsed = reasoning.parseThinkingFromText('<think>hidden plan</think>Visible answer');
    assert.equal(parsed.thinking, 'hidden plan');
    assert.equal(parsed.cleanedResponse, 'Visible answer');
    assert.equal(parsed.reasoning.state, 'visible');
}

{
    const extracted = reasoning.extractReasoningFromResult({
        choices: [{ message: { reasoning_content: 'provider reasoning' } }],
    });
    assert.equal(extracted.text, 'provider reasoning');
    assert.equal(extracted.state, 'visible');
}

{
    const extracted = reasoning.extractReasoningFromResult({
        choices: [{
            message: {
                reasoning_details: [
                    { type: 'reasoning.encrypted', data: 'sig-123' },
                    { type: 'reasoning.text', text: 'detail text' },
                ],
            },
        }],
    });
    assert.equal(extracted.text, 'detail text');
    assert.equal(extracted.signature, 'sig-123');
}

{
    const extracted = reasoning.extractReasoningFromResult({
        responseContent: {
            parts: [
                { thought: true, text: 'gemini thought' },
                { thought: false, text: 'ignored' },
            ],
        },
    });
    assert.equal(extracted.text, 'gemini thought');
}

{
    const merged = reasoning.mergeReasoningCandidates(
        { text: '', state: 'hidden', durationMs: 1850, source: 'stream' },
        null,
        null,
    );
    assert.equal(merged.state, 'hidden');
    assert.equal(merged.durationMs, 1850);
    assert.equal(merged.text, '');
}

{
    const merged = reasoning.mergeReasoningCandidates(
        { text: 'stream reasoning', state: 'visible', source: 'stream' },
        { text: 'result reasoning', state: 'visible', source: 'result' },
        null,
    );
    assert.equal(merged.state, 'visible');
    assert.equal(merged.source, 'stream');
    assert.equal(merged.text, 'stream reasoning\n\n---\n\nresult reasoning');
}

console.log('reasoning normalization tests passed');
