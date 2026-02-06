/**
 * Reasoning normalization helpers.
 * Parity reference: SillyTavern `public/scripts/reasoning.js` and `public/scripts/events.js`
 */

export const REASONING_STATE = Object.freeze({
    NONE: 'none',
    VISIBLE: 'visible',
    HIDDEN: 'hidden',
});

export const REASONING_SOURCE = Object.freeze({
    STREAM: 'stream',
    RESULT: 'result',
    TAG_PARSE: 'tag_parse',
    LEGACY: 'legacy',
});

const THINKING_TAG_REGEX = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isReasoningSource(value) {
    return Object.values(REASONING_SOURCE).includes(value);
}

function parseReasoningState(value) {
    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;

    if (normalized === REASONING_STATE.HIDDEN) return REASONING_STATE.HIDDEN;
    if (normalized === REASONING_STATE.VISIBLE || normalized === 'done' || normalized === 'thinking') {
        return REASONING_STATE.VISIBLE;
    }
    if (normalized === REASONING_STATE.NONE) return REASONING_STATE.NONE;
    return null;
}

function normalizeDuration(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

function normalizeTextContent(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
        return value.map(normalizeTextContent).filter(Boolean).join('');
    }

    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.output_text === 'string') return value.output_text;
        if (typeof value.summary === 'string') return value.summary;
    }

    return '';
}

function normalizeSignature(...candidates) {
    for (const candidate of candidates) {
        const value = trimString(candidate);
        if (value) return value;
    }
    return null;
}

export function createReasoningMeta({
    state = REASONING_STATE.NONE,
    durationMs = null,
    source = REASONING_SOURCE.RESULT,
    signature = null,
} = {}) {
    return {
        state: parseReasoningState(state) || REASONING_STATE.NONE,
        durationMs: normalizeDuration(durationMs),
        source: isReasoningSource(source) ? source : REASONING_SOURCE.RESULT,
        signature: normalizeSignature(signature),
    };
}

export function createLegacyReasoningMeta(thinking = null) {
    return createReasoningMeta({
        state: trimString(thinking) ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE,
        source: REASONING_SOURCE.LEGACY,
        durationMs: null,
        signature: null,
    });
}

export function normalizeReasoningMeta(meta, fallbackThinking = null) {
    if (!meta || typeof meta !== 'object') {
        return createLegacyReasoningMeta(fallbackThinking);
    }

    const hasThinking = !!trimString(fallbackThinking);
    const parsedState = parseReasoningState(meta.state);
    const state = parsedState || (hasThinking ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE);

    return createReasoningMeta({
        state: hasThinking && parsedState === REASONING_STATE.HIDDEN ? REASONING_STATE.VISIBLE : state,
        durationMs: meta.durationMs,
        source: isReasoningSource(meta.source)
            ? meta.source
            : (hasThinking ? REASONING_SOURCE.LEGACY : REASONING_SOURCE.RESULT),
        signature: meta.signature,
    });
}

function dedupeTexts(texts) {
    const seen = new Set();
    const out = [];

    for (const text of texts) {
        const value = trimString(text);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }

    return out;
}

function normalizeReasoningCandidate(candidate, fallbackSource) {
    const text = trimString(candidate?.text);
    const parsedState = parseReasoningState(candidate?.state);
    const state = text
        ? REASONING_STATE.VISIBLE
        : (parsedState || REASONING_STATE.NONE);

    return {
        text,
        state,
        durationMs: normalizeDuration(candidate?.durationMs),
        source: isReasoningSource(candidate?.source) ? candidate.source : fallbackSource,
        signature: normalizeSignature(candidate?.signature),
    };
}

export function parseThinkingFromText(response) {
    const input = typeof response === 'string' ? response : '';
    if (!input) {
        return {
            thinking: null,
            cleanedResponse: '',
            reasoning: {
                text: '',
                ...createReasoningMeta({ state: REASONING_STATE.NONE, source: REASONING_SOURCE.TAG_PARSE }),
            },
        };
    }

    const matches = [...input.matchAll(THINKING_TAG_REGEX)];
    const thinking = matches.length > 0
        ? matches.map(match => trimString(match[1])).filter(Boolean).join('\n\n')
        : null;
    const cleanedResponse = matches.length > 0 ? input.replace(THINKING_TAG_REGEX, '').trim() : input;

    return {
        thinking,
        cleanedResponse,
        reasoning: {
            text: thinking || '',
            ...createReasoningMeta({
                state: thinking ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE,
                source: REASONING_SOURCE.TAG_PARSE,
            }),
        },
    };
}

function contentBlocksToReasoning(blocks) {
    if (!Array.isArray(blocks)) return '';

    const parts = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;

        const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
        const isReasoningType = type === 'thinking'
            || type === 'reasoning'
            || type === 'reasoning.text'
            || type === 'thought'
            || block.thought === true
            || Array.isArray(block.thinking);

        if (!isReasoningType) continue;

        let text = normalizeTextContent(block.thinking)
            || normalizeTextContent(block.reasoning)
            || normalizeTextContent(block.text)
            || normalizeTextContent(block.summary);

        if (!text && Array.isArray(block.thinking)) {
            text = block.thinking
                .map(part => normalizeTextContent(part?.text ?? part))
                .filter(Boolean)
                .join('\n\n');
        }

        const value = trimString(text);
        if (value) parts.push(value);
    }

    return dedupeTexts(parts).join('\n\n').trim();
}

function reasoningDetailsToReasoning(details) {
    if (!Array.isArray(details)) return { text: '', signature: null };

    const parts = [];
    let signature = null;

    for (const item of details) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'reasoning.encrypted') {
            if (!signature && (!item.id || !/^tool_/i.test(item.id))) {
                signature = normalizeSignature(item.data);
            }
            continue;
        }

        const text = trimString(item.text)
            || trimString(item.summary)
            || trimString(normalizeTextContent(item.reasoning));
        if (text) parts.push(text);
    }

    return {
        text: dedupeTexts(parts).join('\n\n').trim(),
        signature,
    };
}

function geminiPartsToReasoning(parts) {
    if (!Array.isArray(parts)) return '';
    const text = parts
        .filter(part => part && typeof part === 'object' && part.thought)
        .map(part => normalizeTextContent(part.text))
        .filter(Boolean);
    return dedupeTexts(text).join('\n\n').trim();
}

function mistralContentToReasoning(content) {
    if (!Array.isArray(content)) return '';
    const text = [];
    for (const part of content) {
        if (!part || typeof part !== 'object' || !Array.isArray(part.thinking)) continue;
        const value = part.thinking
            .map(item => normalizeTextContent(item?.text ?? item))
            .filter(Boolean)
            .join('\n\n')
            .trim();
        if (value) text.push(value);
    }
    return dedupeTexts(text).join('\n\n').trim();
}

function extractReasoningSignature(result, detailsSignature = null) {
    const directSignature = normalizeSignature(
        result?.signature,
        result?.reasoning_signature,
        result?.extra?.reasoning_signature,
        result?.choices?.[0]?.message?.reasoning_signature,
        result?.choices?.[0]?.delta?.reasoning_signature,
    );
    if (directSignature) return directSignature;

    if (detailsSignature) return detailsSignature;

    if (Array.isArray(result?.responseContent?.parts)) {
        for (const part of result.responseContent.parts) {
            if (!part || typeof part !== 'object') continue;
            const signature = normalizeSignature(part.thoughtSignature);
            if (signature && typeof part.text === 'string') {
                return signature;
            }
        }
    }

    return null;
}

export function extractReasoningFromResult(result) {
    if (!result || typeof result !== 'object') {
        return {
            text: '',
            ...createReasoningMeta({ state: REASONING_STATE.NONE, source: REASONING_SOURCE.RESULT }),
        };
    }

    const candidates = [];
    const addCandidate = (value) => {
        const text = trimString(normalizeTextContent(value));
        if (text) candidates.push(text);
    };

    // Provider-specific fields mirrored from ST reasoning extraction.
    addCandidate(result?.choices?.[0]?.message?.reasoning_content);
    addCandidate(result?.choices?.[0]?.delta?.reasoning_content);
    addCandidate(result?.choices?.[0]?.reasoning);
    addCandidate(result?.choices?.[0]?.message?.reasoning);
    addCandidate(result?.choices?.[0]?.delta?.reasoning);

    addCandidate(result?.thinking);
    addCandidate(result?.reasoning);
    addCandidate(result?.extended_thinking);
    addCandidate(result?.extra?.thinking);
    addCandidate(result?.extra?.reasoning);

    addCandidate(contentBlocksToReasoning(result?.content));
    addCandidate(contentBlocksToReasoning(result?.choices?.[0]?.message?.content));
    addCandidate(contentBlocksToReasoning(result?.choices?.[0]?.delta?.content));
    addCandidate(contentBlocksToReasoning(result?.message?.content));

    addCandidate(geminiPartsToReasoning(result?.responseContent?.parts));

    if (Array.isArray(result?.content)) {
        const claudeThinking = result.content.find(part => part?.type === 'thinking');
        addCandidate(claudeThinking?.thinking);
    }

    addCandidate(mistralContentToReasoning(result?.choices?.[0]?.message?.content));

    const detailsCandidates = [
        result?.reasoning_details,
        result?.extra?.reasoning_details,
        result?.choices?.[0]?.message?.reasoning_details,
        result?.choices?.[0]?.delta?.reasoning_details,
    ];

    let detailsSignature = null;
    for (const details of detailsCandidates) {
        const parsed = reasoningDetailsToReasoning(details);
        addCandidate(parsed.text);
        if (!detailsSignature && parsed.signature) {
            detailsSignature = parsed.signature;
        }
    }

    const text = dedupeTexts(candidates)[0] || '';
    const signature = extractReasoningSignature(result, detailsSignature);

    return {
        text,
        ...createReasoningMeta({
            state: text ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE,
            source: REASONING_SOURCE.RESULT,
            signature,
        }),
    };
}

export function normalizeReasoningEvent(...args) {
    const payload = args[0];

    const text = trimString(
        normalizeTextContent(payload?.reasoning)
        || normalizeTextContent(payload?.text)
        || normalizeTextContent(payload),
    );

    const durationMs = normalizeDuration(
        payload?.durationMs
        ?? payload?.duration
        ?? args[1],
    );

    const state = parseReasoningState(payload?.state)
        || parseReasoningState(args[3])
        || parseReasoningState(args[2])
        || (text ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE);

    const signature = normalizeSignature(
        payload?.signature,
        payload?.reasoning_signature,
        payload?.reasoningSignature,
    );

    return {
        text,
        ...createReasoningMeta({
            state: text && state === REASONING_STATE.HIDDEN ? REASONING_STATE.VISIBLE : state,
            durationMs,
            source: REASONING_SOURCE.STREAM,
            signature,
        }),
    };
}

export function mergeReasoningCandidates(streamCandidate = null, resultCandidate = null, tagCandidate = null) {
    const candidates = [
        normalizeReasoningCandidate(streamCandidate, REASONING_SOURCE.STREAM),
        normalizeReasoningCandidate(resultCandidate, REASONING_SOURCE.RESULT),
        normalizeReasoningCandidate(tagCandidate, REASONING_SOURCE.TAG_PARSE),
    ];

    const visibleTexts = dedupeTexts(
        candidates
            .filter(candidate => candidate.state === REASONING_STATE.VISIBLE && candidate.text)
            .map(candidate => candidate.text),
    );

    const hiddenCandidate = candidates.find(candidate => candidate.state === REASONING_STATE.HIDDEN);
    const firstUsedCandidate = candidates.find(candidate =>
        candidate.state !== REASONING_STATE.NONE
        || candidate.durationMs !== null
        || candidate.signature,
    );

    const state = visibleTexts.length > 0
        ? REASONING_STATE.VISIBLE
        : (hiddenCandidate ? REASONING_STATE.HIDDEN : REASONING_STATE.NONE);

    const text = visibleTexts.length > 0 ? visibleTexts.join('\n\n---\n\n') : '';
    const durationMs = candidates.find(candidate => candidate.durationMs !== null)?.durationMs ?? null;
    const signature = normalizeSignature(...candidates.map(candidate => candidate.signature));
    const source = visibleTexts.length > 0
        ? (candidates.find(candidate => candidate.state === REASONING_STATE.VISIBLE && candidate.text)?.source || REASONING_SOURCE.RESULT)
        : (hiddenCandidate?.source || firstUsedCandidate?.source || REASONING_SOURCE.RESULT);

    return {
        text,
        ...createReasoningMeta({
            state,
            durationMs,
            source,
            signature,
        }),
    };
}
