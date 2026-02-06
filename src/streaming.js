/**
 * Streaming module for Scratch Pad extension
 * Handles direct SSE streaming from the chat-completions backend
 */

import { createReasoningMeta, REASONING_STATE, REASONING_SOURCE } from './reasoning.js';

const GENERATE_URL = '/api/backends/chat-completions/generate';

/**
 * Chat completion source identifiers (mirrors ST's chat_completion_sources)
 */
const SOURCES = {
    OPENAI: 'openai',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    MAKERSUITE: 'makersuite',
    VERTEXAI: 'vertexai',
    MISTRALAI: 'mistralai',
    CUSTOM: 'custom',
    COHERE: 'cohere',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    CHUTES: 'chutes',
    ELECTRONHUB: 'electronhub',
    NANOGPT: 'nanogpt',
    DEEPSEEK: 'deepseek',
    AIMLAPI: 'aimlapi',
    XAI: 'xai',
    POLLINATIONS: 'pollinations',
    MOONSHOT: 'moonshot',
    FIREWORKS: 'fireworks',
    COMETAPI: 'cometapi',
    AZURE_OPENAI: 'azure_openai',
    ZAI: 'zai',
    SILICONFLOW: 'siliconflow',
    AI21: 'ai21',
};

/**
 * Check if the current API backend supports streaming
 * @returns {boolean}
 */
export function isStreamingSupported() {
    try {
        const context = SillyTavern.getContext();
        if (context.mainApi !== 'openai') return false;

        const settings = context.chatCompletionSettings;
        if (!settings) return false;

        return !!settings.stream_openai;
    } catch {
        return false;
    }
}

/**
 * Build the request body for a streaming chat-completion request.
 * Mirrors SillyTavern's createGenerationParameters but simplified for
 * our quiet-generation use case.
 * @param {Array} messages Chat messages array [{role, content}]
 * @param {Object} settings chatCompletionSettings (oai_settings)
 * @param {string} model Model name
 * @returns {Object} Request body
 */
function buildRequestBody(messages, settings, model) {
    const source = settings.chat_completion_source;

    const body = {
        type: 'quiet',
        messages,
        model,
        temperature: Number(settings.temp_openai),
        frequency_penalty: Number(settings.freq_pen_openai),
        presence_penalty: Number(settings.pres_pen_openai),
        top_p: Number(settings.top_p_openai),
        max_tokens: settings.openai_max_tokens,
        stream: true,
        chat_completion_source: source,
        include_reasoning: Boolean(settings.show_thoughts),
        custom_prompt_post_processing: settings.custom_prompt_post_processing,
    };

    // Reasoning effort
    if (settings.reasoning_effort && settings.reasoning_effort !== 'auto') {
        body.reasoning_effort = settings.reasoning_effort;
    }

    // Proxy support
    const proxySources = [SOURCES.CLAUDE, SOURCES.OPENAI, SOURCES.MISTRALAI, SOURCES.MAKERSUITE, SOURCES.VERTEXAI, SOURCES.DEEPSEEK, SOURCES.XAI];
    if (settings.reverse_proxy && proxySources.includes(source)) {
        body.reverse_proxy = settings.reverse_proxy;
        body.proxy_password = settings.proxy_password;
    }

    // Source-specific fields
    if (source === SOURCES.AZURE_OPENAI) {
        body.azure_base_url = settings.azure_base_url;
        body.azure_deployment_name = settings.azure_deployment_name;
        body.azure_api_version = settings.azure_api_version;
    }

    if (source === SOURCES.CLAUDE) {
        body.top_k = Number(settings.top_k_openai);
        body.use_sysprompt = settings.use_sysprompt;
    }

    if (source === SOURCES.OPENROUTER) {
        body.top_k = Number(settings.top_k_openai);
        body.min_p = Number(settings.min_p_openai);
        body.repetition_penalty = Number(settings.repetition_penalty_openai);
        body.top_a = Number(settings.top_a_openai);
        body.use_fallback = settings.openrouter_use_fallback;
        body.provider = settings.openrouter_providers;
        body.allow_fallbacks = settings.openrouter_allow_fallbacks;
        body.middleout = settings.openrouter_middleout;
    }

    if ([SOURCES.MAKERSUITE, SOURCES.VERTEXAI].includes(source)) {
        body.top_k = Number(settings.top_k_openai);
        body.use_sysprompt = settings.use_sysprompt;
        if (source === SOURCES.VERTEXAI) {
            body.vertexai_auth_mode = settings.vertexai_auth_mode;
            body.vertexai_region = settings.vertexai_region;
            body.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }

    if (source === SOURCES.CUSTOM) {
        body.custom_url = settings.custom_url;
        body.custom_include_body = settings.custom_include_body;
        body.custom_exclude_body = settings.custom_exclude_body;
        body.custom_include_headers = settings.custom_include_headers;
    }

    if (source === SOURCES.COHERE) {
        body.top_p = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
        body.top_k = Number(settings.top_k_openai);
        body.frequency_penalty = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
        body.presence_penalty = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
    }

    if (source === SOURCES.DEEPSEEK) {
        body.top_p = body.top_p || Number.EPSILON;
    }

    if (source === SOURCES.PERPLEXITY) {
        body.top_k = Number(settings.top_k_openai);
    }

    if (source === SOURCES.ELECTRONHUB) {
        body.top_k = Number(settings.top_k_openai);
    }

    if (source === SOURCES.CHUTES) {
        body.min_p = Number(settings.min_p_openai);
        body.top_k = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
        body.repetition_penalty = Number(settings.repetition_penalty_openai);
    }

    if (source === SOURCES.NANOGPT) {
        body.top_k = Number(settings.top_k_openai);
        body.min_p = Number(settings.min_p_openai);
        body.repetition_penalty = Number(settings.repetition_penalty_openai);
        body.top_a = Number(settings.top_a_openai);
    }

    if (source === SOURCES.ZAI) {
        body.top_p = body.top_p || 0.01;
        body.zai_endpoint = settings.zai_endpoint || 'common';
        delete body.presence_penalty;
        delete body.frequency_penalty;
    }

    if (source === SOURCES.POLLINATIONS) {
        delete body.max_tokens;
    }

    // Seed support
    const seedSources = [SOURCES.OPENAI, SOURCES.AZURE_OPENAI, SOURCES.OPENROUTER, SOURCES.MISTRALAI, SOURCES.CUSTOM, SOURCES.COHERE, SOURCES.GROQ, SOURCES.ELECTRONHUB, SOURCES.NANOGPT, SOURCES.XAI, SOURCES.POLLINATIONS, SOURCES.AIMLAPI, SOURCES.VERTEXAI, SOURCES.MAKERSUITE, SOURCES.CHUTES];
    if (seedSources.includes(source) && settings.seed >= 0) {
        body.seed = settings.seed;
    }

    return body;
}

/**
 * Extract text and reasoning tokens from an SSE data chunk.
 * Handles all provider-specific response formats.
 * @param {Object} data Parsed JSON from SSE event
 * @param {string} source chat_completion_source value
 * @returns {{ text: string, reasoning: string }}
 */
function extractTokens(data, source) {
    let text = '';
    let reasoning = '';

    if (source === SOURCES.COHERE) {
        // Cohere: delta.message.content.text
        text = data?.delta?.message?.content?.text || '';
    } else if ([SOURCES.MAKERSUITE, SOURCES.VERTEXAI].includes(source)) {
        // Google: candidates[0].content.parts
        const parts = data?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (part.thought) {
                    reasoning += part.text || '';
                } else {
                    text += part.text || '';
                }
            }
        }
    } else if (source === SOURCES.CLAUDE) {
        // Claude native: delta.text or delta.thinking
        const delta = data?.delta;
        if (delta) {
            if (delta.type === 'thinking_delta') {
                reasoning = delta.thinking || '';
            } else if (delta.type === 'text_delta') {
                text = delta.text || '';
            } else if (delta.type === 'signature_delta') {
                // Ignore signature deltas for token extraction
            } else {
                text = delta.text || '';
            }
        }
        // Also check for OpenAI-format wrapping (some proxies)
        const choice = data?.choices?.[0]?.delta;
        if (choice) {
            text = text || choice.content || '';
            reasoning = reasoning || choice.reasoning_content || choice.reasoning || '';
        }
    } else {
        // OpenAI-like format: choices[0].delta
        const delta = data?.choices?.[0]?.delta;
        if (delta) {
            text = delta.content || '';
            reasoning = delta.reasoning_content || delta.reasoning || '';
        }
    }

    return { text, reasoning };
}

/**
 * Async generator that streams a chat-completion request.
 * Yields incremental { text, reasoning } objects as tokens arrive.
 *
 * @param {Object} options
 * @param {Array} options.messages Chat messages [{role, content}]
 * @param {AbortSignal} [options.signal] AbortSignal for cancellation
 * @yields {{ text: string, reasoning: string }}
 */
export async function* streamGeneration({ messages, signal }) {
    const context = SillyTavern.getContext();
    const settings = context.chatCompletionSettings;
    const model = context.getChatCompletionModel();
    const headers = context.getRequestHeaders();
    const source = settings.chat_completion_source;

    const body = buildRequestBody(messages, settings, model);

    const response = await fetch(GENERATE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Streaming request failed (${response.status}): ${errorText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Split on SSE double-newline boundaries
            const events = buffer.split(/\n\n/);
            // Keep the last (potentially incomplete) chunk
            buffer = events.pop() || '';

            for (const event of events) {
                const lines = event.split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;

                    const payload = line.slice(5).trim();
                    if (payload === '[DONE]') return;

                    let data;
                    try {
                        data = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    const tokens = extractTokens(data, source);
                    if (tokens.text || tokens.reasoning) {
                        yield tokens;
                    }
                }
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            const lines = buffer.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') return;
                let data;
                try {
                    data = JSON.parse(payload);
                } catch {
                    continue;
                }
                const tokens = extractTokens(data, source);
                if (tokens.text || tokens.reasoning) {
                    yield tokens;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Build a streaming reasoning result from accumulated reasoning text.
 * Returns an object compatible with mergeReasoningCandidates.
 * @param {string} reasoningText Accumulated reasoning text
 * @returns {Object|null} Reasoning candidate or null
 */
export function buildStreamReasoning(reasoningText) {
    if (!reasoningText) return null;

    return {
        text: reasoningText,
        ...createReasoningMeta({
            state: REASONING_STATE.VISIBLE,
            source: REASONING_SOURCE.STREAM,
        }),
    };
}
