/**
 * Generation module for Scratch Pad extension
 * Handles AI generation and prompt building
 */

import { getSettings, isGlobalApiProfileForced } from './settings.js';
import { getThread, updateThread, addMessage, updateMessage, getMessage, saveMetadata, DEFAULT_CONTEXT_SETTINGS, getThreadContextSettings, ensureSwipeFields, addSwipe, setActiveSwipe, deleteSwipe, syncSwipeToMessage } from './storage.js';
import { getConnectionProfile, getConnectionProfileApiMap, resolveConnectionProfileId } from './connectionProfiles.js';
import { parseThinkingFromText, extractReasoningFromResult, mergeReasoningCandidates, createHiddenReasoningCandidate, createReasoningMeta, REASONING_SOURCE, REASONING_STATE } from './reasoning.js';
import { isStreamingSupported, streamGeneration, buildStreamReasoning } from './streaming.js';
import { appendAuthorsNoteToMessages, appendAuthorsNoteToPromptParts } from './authorsNote.js';

const TITLE_REGEX = /^\*\*Title:\s*(.+?)\*\*\s*/m;

/**
 * Build character context from character data
 * @param {Object} char Character object
 * @returns {string} Formatted character context
 */
function buildCharacterContext(char) {
    if (!char) return '';

    const parts = [];

    if (char.name) {
        parts.push(`Character Name: ${char.name}`);
    }
    if (char.description) {
        parts.push(`Description: ${char.description}`);
    }
    if (char.personality) {
        parts.push(`Personality: ${char.personality}`);
    }
    if (char.scenario) {
        parts.push(`Scenario: ${char.scenario}`);
    }
    if (char.mes_example) {
        parts.push(`Example Messages:\n${char.mes_example}`);
    }

    return parts.join('\n\n');
}

/**
 * Get the Author's Note from the current chat's metadata
 * @returns {string} Author's Note text, or empty string if not set
 */
function getAuthorsNote() {
    const { chatMetadata } = SillyTavern.getContext();
    const note = chatMetadata?.note_prompt;
    return (typeof note === 'string' && note.trim()) ? note.trim() : '';
}

/**
 * Resolve SillyTavern's main system prompt across context variants.
 * @param {Object} [context] SillyTavern context
 * @returns {string} System prompt text, or empty string if unavailable
 */
function getStSystemPrompt(context = SillyTavern.getContext()) {
    const fromChatMetadata = context?.chatMetadata?.system_prompt;
    if (typeof fromChatMetadata === 'string' && fromChatMetadata.trim()) {
        return fromChatMetadata.trim();
    }

    const fromChatMetadataLegacy = context?.chat_metadata?.system_prompt;
    if (typeof fromChatMetadataLegacy === 'string' && fromChatMetadataLegacy.trim()) {
        return fromChatMetadataLegacy.trim();
    }

    return '';
}

/**
 * Format chat history for context
 * @param {Array} chat Chat messages array
 * @returns {string} Formatted chat history
 */
function formatChatHistory(chat) {
    if (!chat || chat.length === 0) return '';

    return chat.map(msg => {
        const role = msg.is_user ? 'User' : (msg.name || 'Character');
        return `${role}: ${msg.mes}`;
    }).join('\n\n');
}

function selectChatHistory(chat, settings) {
    if (!chat || chat.length === 0) return [];

    const rangeMode = settings.chatHistoryRangeMode || 'all';
    const rangeStart = settings.chatHistoryRangeStart;
    const rangeEnd = settings.chatHistoryRangeEnd;

    if (rangeMode !== 'all') {
        const total = chat.length;
        let startIndex = 0;
        let endIndex = total - 1;

        if (rangeMode === 'start_to') {
            if (!rangeEnd) return applyLimitFallback(chat, settings);
            endIndex = Math.min(total - 1, Math.max(0, rangeEnd - 1));
        } else if (rangeMode === 'from_to_end') {
            if (!rangeStart) return applyLimitFallback(chat, settings);
            startIndex = Math.min(total - 1, Math.max(0, rangeStart - 1));
        } else if (rangeMode === 'between') {
            if (!rangeStart || !rangeEnd) return applyLimitFallback(chat, settings);
            startIndex = Math.min(total - 1, Math.max(0, rangeStart - 1));
            endIndex = Math.min(total - 1, Math.max(0, rangeEnd - 1));
            if (startIndex > endIndex) {
                [startIndex, endIndex] = [endIndex, startIndex];
            }
        }

        return chat.slice(startIndex, endIndex + 1);
    }

    return applyLimitFallback(chat, settings);
}

function applyLimitFallback(chat, settings) {
    const historyLimit = settings.chatHistoryLimit || 0;
    return historyLimit > 0 ? chat.slice(-historyLimit) : chat;
}

/**
 * Format thread history for context
 * @param {Array} messages Thread messages array
 * @returns {string} Formatted thread history
 */
function formatThreadHistory(messages) {
    if (!messages || messages.length === 0) return '';

    return messages
        .filter(m => m.status === 'complete')
        .map(msg => {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            return `${role}: ${msg.content}`;
        }).join('\n\n');
}

/**
 * Build thread messages as an array of {role, content} objects for multi-message mode
 * @param {Array} messages Thread messages array
 * @returns {Array<{role: string, content: string}>} Messages array
 */
function buildThreadMessages(messages) {
    if (!messages || messages.length === 0) return [];

    return messages
        .filter(m => m.status === 'complete')
        .map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));
}

/**
 * Get the usable prompt budget from SillyTavern's active context settings.
 * Mirrors ST's max prompt budget by subtracting the configured response length.
 * @param {Object} context SillyTavern context
 * @returns {number|null} Prompt token budget, or null if unavailable
 */
function getPromptTokenBudget(context, profileId = null) {
    const profileBudget = getProfilePromptTokenBudget(context, profileId);
    if (profileBudget) {
        return profileBudget;
    }

    const chatSettings = context?.chatCompletionSettings || {};
    const textSettings = context?.textCompletionSettings || {};

    const maxContext = context?.mainApi === 'openai'
        ? Number(chatSettings.openai_max_context ?? context?.maxContext)
        : Number(context?.maxContext);
    const responseLength = context?.mainApi === 'openai'
        ? Number(chatSettings.openai_max_tokens ?? 0)
        : Number(textSettings.amount_gen ?? textSettings.max_length ?? 0);

    if (!Number.isFinite(maxContext) || maxContext <= 0) {
        return null;
    }

    const reservedResponse = Number.isFinite(responseLength) && responseLength > 0 ? responseLength : 0;
    return Math.max(1, maxContext - reservedResponse);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue) && numberValue > 0) {
            return numberValue;
        }
    }
    return null;
}

function getProfilePromptTokenBudget(context, profileId) {
    const profile = getConnectionProfile(profileId, context);
    if (!profile) return null;

    const apiMap = getConnectionProfileApiMap(profile, context);
    const presetApiId = apiMap?.selected === 'openai' ? 'openai' : 'textgenerationwebui';
    const preset = profile.preset && typeof context?.getPresetManager === 'function'
        ? context.getPresetManager(presetApiId)?.getCompletionPresetByName?.(profile.preset)
        : null;

    const chatSettings = context?.chatCompletionSettings || {};
    const textSettings = context?.textCompletionSettings || {};

    const maxContext = apiMap?.selected === 'openai'
        ? firstFiniteNumber(preset?.openai_max_context, chatSettings.openai_max_context, context?.maxContext)
        : firstFiniteNumber(preset?.max_length, textSettings.max_length, context?.maxContext);
    const responseLength = apiMap?.selected === 'openai'
        ? firstFiniteNumber(preset?.openai_max_tokens, chatSettings.openai_max_tokens)
        : firstFiniteNumber(preset?.genamt, textSettings.amount_gen, textSettings.max_length);

    if (!maxContext) return null;

    return Math.max(1, maxContext - (responseLength || 0));
}

/**
 * Count prompt tokens with SillyTavern's active tokenizer, falling back to a
 * conservative character estimate if the tokenizer is not available in tests.
 * @param {string} text Text to count
 * @returns {Promise<number>} Token count
 */
async function countPromptTokens(text) {
    const context = SillyTavern.getContext();
    const normalized = String(text || '').replace(/\r/gm, '');
    const padding = context?.powerUserSettings?.token_padding ?? 0;

    if (typeof context?.getTokenCountAsync === 'function') {
        return await context.getTokenCountAsync(normalized, padding);
    }

    return Math.ceil(normalized.length / 4) + Number(padding || 0);
}

/**
 * Convert a prompt payload to the text SillyTavern's tokenizer should budget.
 * @param {Object} promptData Prompt payload
 * @returns {string} Joined prompt text
 */
function promptDataToTokenText(promptData) {
    if (Array.isArray(promptData.messages)) {
        return [
            promptData.systemPrompt || '',
            ...promptData.messages.map(message => message?.content || ''),
        ].filter(Boolean).join('\n\n');
    }

    return [promptData.systemPrompt || '', promptData.prompt || ''].filter(Boolean).join('\n\n');
}

/**
 * Remove the oldest variable context item while preserving the current question
 * and fixed instructions.
 * @param {Array} chatMessages Roleplay chat messages
 * @param {Array} scratchpadMessages Previous scratchpad messages
 * @returns {boolean} True if an item was removed
 */
function removeOldestVariableContext(chatMessages, scratchpadMessages) {
    if (scratchpadMessages.length >= chatMessages.length && scratchpadMessages.length > 0) {
        scratchpadMessages.shift();
        return true;
    }

    if (chatMessages.length > 0) {
        chatMessages.shift();
        return true;
    }

    if (scratchpadMessages.length > 0) {
        scratchpadMessages.shift();
        return true;
    }

    return false;
}

/**
 * Parse thread title from AI response
 * @param {string} response AI response text
 * @returns {Object} { title: string|null, cleanedResponse: string }
 */
export function parseThreadTitle(response) {
    const match = response.match(TITLE_REGEX);

    if (match) {
        return {
            title: match[1].trim(),
            cleanedResponse: response.replace(TITLE_REGEX, '').trim()
        };
    }

    return {
        title: null,
        cleanedResponse: response
    };
}

/**
 * Parse thinking content from AI response
 * Supports <thinking>...</thinking> and <think>...</think> tags
 * @param {string} response AI response text
 * @returns {Object} { thinking: string|null, cleanedResponse: string }
 */
export function parseThinking(response) {
    const { thinking, cleanedResponse } = parseThinkingFromText(response);
    return { thinking, cleanedResponse };
}

/**
 * Generate a fallback thread name from user's question
 * @param {string} question User's question
 * @returns {string} Truncated question as thread name
 */
export function generateFallbackTitle(question) {
    const maxLength = 30;
    if (question.length <= maxLength) {
        return question;
    }
    return question.substring(0, maxLength) + '...';
}

/**
 * Get the effective connection profile for a thread
 * Priority: Thread override -> Global setting -> null (default API)
 * @param {string} threadId Thread ID
 * @returns {string|null} Profile ID to use, or null for default API
 */
export function getEffectiveProfileForThread(threadId) {
    return getEffectiveProfileResolutionForThread(threadId).profileId;
}

function getEffectiveProfileResolutionForThread(threadId) {
    const settings = getSettings();
    const globalValue = settings.connectionProfileId || settings.connectionProfile;

    if (isGlobalApiProfileForced()) {
        const globalProfileId = resolveConnectionProfileId(globalValue);
        if (globalProfileId) {
            return { profileId: globalProfileId, missingValue: null, scope: 'global' };
        }
        if (globalValue) {
            return { profileId: null, missingValue: globalValue, scope: 'global' };
        }
        return { profileId: null, missingValue: null, scope: 'global' };
    }

    const threadSettings = getThreadContextSettings(threadId);
    const threadValue = threadSettings.connectionProfileId || threadSettings.connectionProfile;
    const threadProfileId = resolveConnectionProfileId(threadValue);
    if (threadProfileId) {
        return { profileId: threadProfileId, missingValue: null, scope: 'thread' };
    }
    if (threadValue) {
        return { profileId: null, missingValue: threadValue, scope: 'thread' };
    }

    if (settings.useAlternativeApi) {
        const globalProfileId = resolveConnectionProfileId(globalValue);
        if (globalProfileId) {
            return { profileId: globalProfileId, missingValue: null, scope: 'global' };
        }
        if (globalValue) {
            return { profileId: null, missingValue: globalValue, scope: 'global' };
        }
    }

    return { profileId: null, missingValue: null, scope: null };
}

const warnedProfileFallbacks = new Set();

function warnProfileFallback(resolution) {
    if (!resolution?.missingValue) return;

    const key = `${resolution.scope}:${resolution.missingValue}`;
    if (warnedProfileFallbacks.has(key)) return;
    warnedProfileFallbacks.add(key);

    const message = `Scratch Pad connection profile not found (${resolution.missingValue}); using the active SillyTavern API.`;
    console.warn(`[ScratchPad] ${message}`);
    try {
        toastr?.warning?.(message, 'Scratch Pad');
    } catch {
        // Tests and headless environments may not have toastr.
    }
}

function trimGenerationString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeGenerationInfo(info) {
    const api = trimGenerationString(info?.api);
    const model = trimGenerationString(info?.model);
    return api || model ? { api, model } : null;
}

function getTrackerGenerationInfo() {
    try {
        const tracker = globalThis.window?.['TokenUsageTracker'];
        if (!tracker) return null;

        return normalizeGenerationInfo({
            api: tracker.getCurrentSourceId?.(),
            model: tracker.getCurrentModelId?.(),
        });
    } catch {
        return null;
    }
}

function getActiveGenerationInfo(context = SillyTavern.getContext()) {
    const trackerInfo = getTrackerGenerationInfo();
    const mainApi = trimGenerationString(context?.mainApi);
    const chatSettings = context?.chatCompletionSettings || {};
    const textSettings = context?.textCompletionSettings || {};

    switch (mainApi) {
        case 'openai':
            return normalizeGenerationInfo({
                api: chatSettings.chat_completion_source || trackerInfo?.api || 'openai',
                model: context?.getChatCompletionModel?.() || trackerInfo?.model,
            });
        case 'textgenerationwebui': {
            const type = trimGenerationString(textSettings.type);
            return normalizeGenerationInfo({
                api: type === 'ooba' ? 'textgenerationwebui' : type || trackerInfo?.api || 'textgenerationwebui',
                model: context?.onlineStatus || trackerInfo?.model,
            });
        }
        case 'kobold':
            return normalizeGenerationInfo({
                api: 'kobold',
                model: context?.onlineStatus || trackerInfo?.model,
            });
        default:
            return normalizeGenerationInfo({
                api: trackerInfo?.api || mainApi,
                model: trackerInfo?.model,
            });
    }
}

function getProfileGenerationInfo(profile) {
    return normalizeGenerationInfo({
        api: profile?.api,
        model: profile?.model,
    });
}

function getGenerationInfoForResolution(resolution, context = SillyTavern.getContext()) {
    if (resolution?.profileId) {
        const profile = getConnectionProfile(resolution.profileId, context);
        const profileInfo = getProfileGenerationInfo(profile);
        if (profileInfo) return profileInfo;
    }

    return getActiveGenerationInfo(context);
}

function generationInfoToExtra(generationInfo) {
    const normalized = normalizeGenerationInfo(generationInfo);
    return normalized ? { ...normalized } : {};
}

function buildReasoningPayload(responseText, streamReasoning = null, resultReasoning = null, hiddenReasoning = null) {
    const parsed = parseThinkingFromText(responseText);
    const merged = mergeReasoningCandidates(streamReasoning, resultReasoning, parsed.reasoning, hiddenReasoning);
    return {
        thinking: merged.text || null,
        reasoningMeta: {
            state: merged.state,
            durationMs: merged.durationMs,
            source: merged.source,
            signature: merged.signature,
        },
        cleanedResponse: parsed.cleanedResponse,
    };
}

function buildMessagesForGeneration({ systemPrompt = '', prompt = '', messages: prebuiltMessages = null }) {
    const context = SillyTavern.getContext();
    const substitute = context.substituteParams || ((text) => text);

    if (prebuiltMessages) {
        const msgs = [];
        if (systemPrompt) {
            msgs.push({ role: 'system', content: substitute(systemPrompt) });
        }
        for (const msg of prebuiltMessages) {
            msgs.push({ role: msg.role, content: substitute(msg.content) });
        }
        return msgs;
    }

    const msgs = [];
    if (systemPrompt) {
        msgs.push({ role: 'system', content: substitute(systemPrompt) });
    }
    msgs.push({ role: 'user', content: substitute(prompt) });
    return msgs;
}

function createReasoningCandidate(text, source = REASONING_SOURCE.RESULT) {
    const value = typeof text === 'string' ? text.trim() : '';
    return {
        text: value,
        ...createReasoningMeta({
            state: value ? REASONING_STATE.VISIBLE : REASONING_STATE.NONE,
            source,
        }),
    };
}

function isAbortError(error) {
    return error?.name === 'AbortError' || /abort|cancel/i.test(error?.message || '');
}

function isHiddenReasoningProfile(profile, context = SillyTavern.getContext()) {
    const apiMap = getConnectionProfileApiMap(profile, context);
    if (apiMap?.selected !== 'openai') return false;

    const model = String(profile?.model || '').trim();
    if (!model) return false;

    const hiddenReasoningModels = [
        'gpt-4.5',
        'o1',
        'o3',
        'gemini-2.0-flash-thinking-exp',
        'gemini-2.0-pro-exp',
    ];

    return hiddenReasoningModels.some(prefix => model.startsWith(prefix));
}

function createHiddenReasoningCandidateForProfile(durationMs, profile, context = SillyTavern.getContext()) {
    if (!isHiddenReasoningProfile(profile, context)) return null;

    return {
        text: '',
        ...createReasoningMeta({
            state: REASONING_STATE.HIDDEN,
            durationMs,
            source: REASONING_SOURCE.RESULT,
        }),
    };
}

async function reportProfileTokenUsage(inputText, generationResult, profile) {
    try {
        const tracker = window['TokenUsageTracker'];
        if (!tracker) return;

        const inputTokens = await tracker.countTokens(inputText);
        const outputTokens = await tracker.countTokens(generationResult.text || '');
        const reasoningText = generationResult.streamReasoning?.text || generationResult.resultReasoning?.text || '';
        const reasoningTokens = reasoningText ? await tracker.countTokens(reasoningText) : 0;
        const context = SillyTavern.getContext();
        const apiMap = getConnectionProfileApiMap(profile, context);
        const modelId = profile?.model || tracker.getCurrentModelId();
        const sourceId = apiMap?.source || apiMap?.type || profile?.api || tracker.getCurrentSourceId();
        const chatId = context.getCurrentChatId?.() || null;
        tracker.recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, reasoningTokens);
    } catch (e) {
        console.warn('[ScratchPad] Token usage reporting failed:', e);
    }
}

async function callConnectionProfileGeneration({ profileId, systemPrompt = '', prompt = '', messages: prebuiltMessages = null, onToken }) {
    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;
    const profile = getConnectionProfile(profileId, context);

    if (!service || !profile) {
        throw new Error(`Connection profile with ID "${profileId}" not found.`);
    }

    const requestMessages = buildMessagesForGeneration({ systemPrompt, prompt, messages: prebuiltMessages });
    const inputText = [
        systemPrompt || '',
        ...requestMessages.map(message => message?.content || ''),
    ].filter(Boolean).join('\n');
    const startedAt = Date.now();

    async function sendProfileRequest(stream) {
        const controller = new AbortController();
        activeAbortController = controller;

        try {
            const response = await service.sendRequest(profileId, requestMessages, undefined, {
                extractData: true,
                includePreset: true,
                stream,
                signal: controller.signal,
            });

            if (stream && typeof response === 'function') {
                let accumulatedText = '';
                let accumulatedReasoning = '';
                for await (const chunk of response()) {
                    accumulatedText = chunk?.text ?? accumulatedText;
                    accumulatedReasoning = chunk?.state?.reasoning ?? accumulatedReasoning;
                    if (onToken && chunk?.text !== undefined) {
                        onToken(accumulatedText, false);
                    }
                }

                return {
                    text: accumulatedText,
                    streamReasoning: createReasoningCandidate(accumulatedReasoning, REASONING_SOURCE.STREAM),
                    resultReasoning: null,
                };
            }

            return {
                text: response?.content || '',
                streamReasoning: null,
                resultReasoning: createReasoningCandidate(response?.reasoning || '', REASONING_SOURCE.RESULT),
            };
        } finally {
            if (activeAbortController === controller) {
                activeAbortController = null;
            }
        }
    }

    let generationResult;
    if (onToken) {
        try {
            generationResult = await sendProfileRequest(true);
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            console.warn('[ScratchPad] Connection profile streaming failed, falling back to non-streaming:', error.message);
        }
    }

    if (!generationResult) {
        generationResult = await sendProfileRequest(false);
    }

    generationResult.hiddenReasoning = createHiddenReasoningCandidateForProfile(Date.now() - startedAt, profile, context);
    await reportProfileTokenUsage(inputText, generationResult, profile);
    return generationResult;
}

/**
 * Unified generation helper.
 * When streaming is supported and onToken is provided, uses direct SSE streaming.
 * Otherwise uses sendGenerationRequest for the openai backend (returns raw API
 * response with structured reasoning fields), falls back to generateRaw for others.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt System prompt
 * @param {string} [options.prompt] User prompt (concatenated format)
 * @param {Array} [options.messages] Pre-built messages array (multi-message format)
 * @param {Function} [options.onToken] Callback for streaming tokens: (accumulatedText, false)
 * @returns {Promise<{text: string, streamReasoning: Object|null, resultReasoning: Object|null}>}
 */
async function callGeneration({ systemPrompt, prompt, messages: prebuiltMessages, onToken }) {
    const context = SillyTavern.getContext();
    const currentApi = context.mainApi;
    let generationResult;
    const startedAt = Date.now();

    // Try streaming first when supported and a token callback is provided
    if (onToken && currentApi === 'openai' && isStreamingSupported()) {
        try {
            const messages = buildMessagesForGeneration({ systemPrompt, prompt, messages: prebuiltMessages });

            const controller = new AbortController();
            activeAbortController = controller;

            let accumulatedText = '';
            let accumulatedReasoning = '';

            try {
                for await (const chunk of streamGeneration({ messages, signal: controller.signal })) {
                    if (chunk.text) accumulatedText += chunk.text;
                    if (chunk.reasoning) accumulatedReasoning += chunk.reasoning;
                    if (chunk.text) {
                        onToken(accumulatedText, false);
                    }
                }
            } finally {
                if (activeAbortController === controller) {
                    activeAbortController = null;
                }
            }

            const streamReasoning = buildStreamReasoning(accumulatedReasoning);
            generationResult = { text: accumulatedText, streamReasoning, resultReasoning: null };
        } catch (err) {
            if (err.name === 'AbortError' || /abort|cancel/i.test(err.message)) {
                throw err;
            }
            console.warn('[ScratchPad] Streaming failed, falling back to non-streaming:', err.message);
            // Fall through to non-streaming path
        }
    }

    // Non-streaming path
    if (!generationResult && currentApi === 'openai') {
        try {
            const messages = buildMessagesForGeneration({ systemPrompt, prompt, messages: prebuiltMessages });

            const data = await context.sendGenerationRequest('quiet', { prompt: messages });
            const text = context.extractMessageFromData(data) || '';
            const resultReasoning = extractReasoningFromResult(data);
            generationResult = { text, streamReasoning: null, resultReasoning };
        } catch (err) {
            if (err.name === 'AbortError' || /abort|cancel/i.test(err.message)) {
                throw err;
            }
            console.warn('[ScratchPad] sendGenerationRequest failed, falling back to generateRaw:', err.message);
            if (prebuiltMessages) {
                // For multi-message mode, pass the messages array to generateRaw
                const messages = buildMessagesForGeneration({ systemPrompt, prompt, messages: prebuiltMessages });
                const result = await context.generateRaw({ prompt: messages });
                generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
            } else {
                const result = await context.generateRaw({ systemPrompt, prompt });
                generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
            }
        }
    }

    if (!generationResult) {
        if (prebuiltMessages) {
            const messages = buildMessagesForGeneration({ systemPrompt, prompt, messages: prebuiltMessages });
            const result = await context.generateRaw({ prompt: messages });
            generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
        } else {
            const result = await context.generateRaw({ systemPrompt, prompt });
            generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
        }
    }

    const durationMs = Date.now() - startedAt;
    if (generationResult) {
        generationResult.hiddenReasoning = createHiddenReasoningCandidate(durationMs, context);
    }

    // Report token usage to Token Usage Tracker
    try {
        const tracker = window['TokenUsageTracker'];
        if (tracker) {
            let inputText;
            if (prebuiltMessages) {
                inputText = (systemPrompt || '') + '\n' + prebuiltMessages.map(m => m.content).join('\n');
            } else {
                inputText = (systemPrompt || '') + '\n' + (prompt || '');
            }
            const inputTokens = await tracker.countTokens(inputText);
            const outputTokens = await tracker.countTokens(generationResult.text || '');

            let reasoningTokens = 0;
            const reasoningText = generationResult.streamReasoning?.text || '';
            if (reasoningText) {
                reasoningTokens = await tracker.countTokens(reasoningText);
            }

            const modelId = tracker.getCurrentModelId();
            const sourceId = tracker.getCurrentSourceId();
            const chatId = SillyTavern.getContext().getCurrentChatId?.() || null;
            tracker.recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, reasoningTokens);
        }
    } catch (e) {
        console.warn('[ScratchPad] Token usage reporting failed:', e);
    }

    return generationResult;
}

/**
 * Compatibility generation using SillyTavern's generateRaw helper.
 * This keeps Scratch Pad in control of the context payload while still routing
 * through SillyTavern's API abstraction for providers that dislike the direct
 * request path.
 *
 * Returns the same shape as callGeneration() for downstream compatibility.
 * @param {Object} options
 * @param {string} [options.systemPrompt] System prompt
 * @param {string} [options.prompt] User prompt (concatenated format)
 * @param {Array} [options.messages] Pre-built messages array (multi-message format)
 * @returns {Promise<{text: string, streamReasoning: null, resultReasoning: null}>}
 */
async function callStandardGeneration({ systemPrompt = '', prompt = '', messages: prebuiltMessages = null }) {
    const context = SillyTavern.getContext();
    const startedAt = Date.now();

    function buildMessages() {
        const substitute = context.substituteParams || ((text) => text);
        const msgs = [];
        if (systemPrompt) {
            msgs.push({ role: 'system', content: substitute(systemPrompt) });
        }
        for (const msg of prebuiltMessages || []) {
            msgs.push({ role: msg.role, content: substitute(msg.content) });
        }
        return msgs;
    }

    try {
        let text;
        if (prebuiltMessages) {
            text = await context.generateRaw({ prompt: buildMessages() });
        } else {
            text = await context.generateRaw({ systemPrompt, prompt });
        }

        // Report token usage (approximate, mirrors the custom generation path)
        try {
            const tracker = window['TokenUsageTracker'];
            if (tracker) {
                const inputText = prebuiltMessages
                    ? (systemPrompt || '') + '\n' + prebuiltMessages.map(m => m.content).join('\n')
                    : (systemPrompt || '') + '\n' + (prompt || '');
                const inputTokens = await tracker.countTokens(inputText);
                const outputTokens = await tracker.countTokens(text || '');
                const modelId = tracker.getCurrentModelId();
                const sourceId = tracker.getCurrentSourceId();
                const chatId = SillyTavern.getContext().getCurrentChatId?.() || null;
                tracker.recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, 0);
            }
        } catch (e) {
            console.warn('[ScratchPad] Token usage reporting failed:', e);
        }

        return {
            text: text || '',
            streamReasoning: null,
            resultReasoning: null,
            hiddenReasoning: createHiddenReasoningCandidate(Date.now() - startedAt, context),
        };
    } catch (err) {
        if (err.name === 'AbortError' || /abort|cancel/i.test(err.message)) {
            throw err;
        }
        throw err;
    }
}

async function runGenerationForThread({ threadId, promptData, onStream = null, useStandardGeneration = false, profileResolution = null, generationInfo = null }) {
    const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    activeGenerationId = generationId;

    try {
        const resolution = profileResolution || getEffectiveProfileResolutionForThread(threadId);
        const resolvedGenerationInfo = normalizeGenerationInfo(generationInfo) || getGenerationInfoForResolution(resolution);
        warnProfileFallback(resolution);

        const onToken = onStream ? (partialText) => onStream(partialText, false) : undefined;
        const result = resolution.profileId
            ? await callConnectionProfileGeneration({
                profileId: resolution.profileId,
                systemPrompt: promptData.systemPrompt,
                prompt: promptData.prompt,
                messages: promptData.messages,
                onToken,
            })
            : useStandardGeneration
                ? await callStandardGeneration(promptData)
                : await callGeneration({
                    systemPrompt: promptData.systemPrompt,
                    prompt: promptData.prompt,
                    messages: promptData.messages,
                    onToken,
                });

        if (onStream) onStream(result.text, true);
        result.generationInfo = resolvedGenerationInfo;
        return result;
    } finally {
        if (activeGenerationId === generationId) activeGenerationId = null;
    }
}

/**
 * Extract swipe context (user question + sliced thread) from a thread/message pair.
 * Used by both buildPromptForSwipe (custom generation) and standard generation swipe path.
 * @param {string} threadId Thread ID
 * @param {string} messageId Target assistant message ID
 * @returns {Object|null} { userQuestion, contextThread } or null
 */
function getSwipeContext(threadId, messageId) {
    const thread = getThread(threadId);
    if (!thread) return null;

    const messageIndex = thread.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return null;

    // Find the preceding user message
    let userQuestion = '';
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (thread.messages[i].role === 'user') {
            userQuestion = thread.messages[i].content;
            break;
        }
    }
    if (!userQuestion) return null;

    // Create context thread sliced to before the target, without the triggering user msg
    const contextThread = { ...thread, messages: thread.messages.slice(0, messageIndex) };
    let userIdx = -1;
    for (let i = contextThread.messages.length - 1; i >= 0; i--) {
        if (contextThread.messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx !== -1) {
        contextThread.messages = [
            ...contextThread.messages.slice(0, userIdx),
            ...contextThread.messages.slice(userIdx + 1)
        ];
    }

    return { userQuestion, contextThread };
}

function excludeMessagesFromThread(thread, messageIds) {
    const excluded = new Set(messageIds.filter(Boolean));
    return {
        ...thread,
        messages: (thread?.messages || []).filter(message => !excluded.has(message.id)),
    };
}

export const GENERAL_ASK_SYSTEM_PROMPT = 'You are a helpful general-purpose AI assistant. Answer the user directly and do not rely on any prior chat context.';

async function generateNoContextResponse(userPrompt, threadId, onStream = null, systemPrompt = '') {
    const context = SillyTavern.getContext();

    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

    // Capture chat index at question time for branch filtering
    const chatIndexAtQuestion = context.chat ? context.chat.length : null;

    const userMessage = addMessage(threadId, 'user', userPrompt, 'complete', chatIndexAtQuestion);
    if (!userMessage) {
        return { success: false, error: 'Failed to add user message' };
    }
    userMessage.noContext = true;

    const assistantMessage = addMessage(threadId, 'assistant', '', 'pending', chatIndexAtQuestion);
    if (!assistantMessage) {
        return { success: false, error: 'Failed to add assistant message' };
    }
    assistantMessage.noContext = true;
    assistantMessage.gen_started = new Date().toISOString();
    assistantMessage.gen_finished = null;
    const profileResolution = getEffectiveProfileResolutionForThread(threadId);
    const generationInfo = getGenerationInfoForResolution(profileResolution);
    assistantMessage.extra = generationInfoToExtra(generationInfo);

    await saveMetadata();

    let genFinished = null;
    try {
        const globalSettings = getSettings();
        const result = await runGenerationForThread({
            threadId,
            promptData: { systemPrompt, prompt: userPrompt },
            onStream,
            useStandardGeneration: globalSettings.useStandardGeneration,
            profileResolution,
            generationInfo,
        });
        const resultGenerationInfo = result.generationInfo || generationInfo;

        genFinished = new Date().toISOString();
        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning, result.hiddenReasoning);
        const combinedThinking = reasoningPayload.thinking;
        const reasoningMeta = reasoningPayload.reasoningMeta;
        const responseWithoutThinking = reasoningPayload.cleanedResponse;

        // Check if generation was cancelled
        if (checkAndResetCancellation()) {
            updateMessage(threadId, assistantMessage.id, {
                content: responseText || '',
                thinking: combinedThinking,
                reasoningMeta,
                noContext: true,
                gen_started: assistantMessage.gen_started,
                gen_finished: genFinished,
                extra: generationInfoToExtra(resultGenerationInfo),
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '', gen_started: assistantMessage.gen_started, gen_finished: genFinished, generationInfo: resultGenerationInfo };
        }

        updateMessage(threadId, assistantMessage.id, {
            content: responseWithoutThinking,
            thinking: combinedThinking,
            reasoningMeta,
            noContext: true,
            gen_started: assistantMessage.gen_started,
            gen_finished: genFinished,
            extra: generationInfoToExtra(resultGenerationInfo),
            status: 'complete'
        });

        if (thread.messages.length <= 2) {
            updateThread(threadId, { name: generateFallbackTitle(userPrompt), titled: true });
        }

        await saveMetadata();

        return { success: true, response: responseWithoutThinking, thinking: combinedThinking, reasoningMeta, gen_started: assistantMessage.gen_started, gen_finished: genFinished, generationInfo: resultGenerationInfo };

    } catch (error) {
        genFinished = genFinished || new Date().toISOString();
        // Check if this was a cancellation
        if (checkAndResetCancellation()) {
            const thread = getThread(threadId);
            if (thread) {
                const msgIndex = thread.messages.findIndex(m => m.id === assistantMessage.id);
                if (msgIndex !== -1) {
                    thread.messages.splice(msgIndex, 1);
                }
            }
            await saveMetadata();
            return { success: false, cancelled: true };
        }

        console.error('[ScratchPad] Generation error:', error);

        updateMessage(threadId, assistantMessage.id, {
            content: '',
            noContext: true,
            gen_started: assistantMessage.gen_started,
            gen_finished: genFinished,
            extra: generationInfoToExtra(generationInfo),
            status: 'failed',
            error: error.message
        });

        await saveMetadata();

        return { success: false, error: error.message };
    }
}

export async function generateRawPromptResponse(userPrompt, threadId, onStream = null) {
    return generateNoContextResponse(userPrompt, threadId, onStream, '');
}

export async function generateGeneralAskResponse(userPrompt, threadId, onStream = null) {
    return generateNoContextResponse(userPrompt, threadId, onStream, GENERAL_ASK_SYSTEM_PROMPT);
}

/**
 * Build the complete prompt for scratch pad generation
 * @param {string} userQuestion User's question
 * @param {Object} thread Thread object
 * @param {boolean} isFirstMessage Whether this is the first message in the thread
 * @param {string|null} [profileId] Optional Connection Manager profile ID for budget resolution
 * @returns {Promise<Object>} { systemPrompt, prompt } or { systemPrompt, messages } when multi-message mode
 */
async function buildPrompt(userQuestion, thread, isFirstMessage = false, profileId = null) {
    const context = SillyTavern.getContext();
    const { chat, characters, characterId } = context;
    const globalSettings = getSettings();

    // Use thread's context settings, falling back to defaults for missing values
    const contextSettings = thread?.contextSettings
        ? { ...DEFAULT_CONTEXT_SETTINGS, ...thread.contextSettings }
        : DEFAULT_CONTEXT_SETTINGS;

    // Merge: thread settings for context options, global for oocSystemPrompt and chatHistoryLimit
    const settings = {
        ...contextSettings,
        oocSystemPrompt: globalSettings.oocSystemPrompt,
        chatHistoryLimit: globalSettings.chatHistoryLimit
    };

    // OOC system instruction
    let systemPrompt = settings.oocSystemPrompt;

    // Add title instruction only for first message
    if (isFirstMessage) {
        systemPrompt += '\n\nAt the very beginning of your first response in this new conversation, provide a brief title (3-6 words) for this discussion on its own line, formatted as: **Title: [Your Title Here]**\n\nThen provide your response.';
    }

    const selectedChat = (!settings.characterCardOnly && chat && chat.length > 0)
        ? selectChatHistory(chat, settings).slice()
        : [];
    const scratchpadMessages = (!settings.characterCardOnly && thread && thread.messages && thread.messages.length > 0)
        ? thread.messages.filter(m => m.status === 'complete').slice()
        : [];

    function buildPromptData(chatMessages, previousScratchpadMessages) {
        // Multi-message format: return structured messages array
        if (globalSettings.useMultiMessageFormat) {
            const messages = [];

            // ST system prompt as a system message
            if (settings.includeSystemPrompt) {
                try {
                    const stContext = SillyTavern.getContext();
                    const stSystemPrompt = getStSystemPrompt(stContext);
                    if (stSystemPrompt) {
                        messages.push({ role: 'system', content: stSystemPrompt });
                    }
                } catch (e) {
                    console.warn('[ScratchPad] Could not retrieve system prompt:', e);
                }
            }

            // Character card as a system message
            if ((settings.includeCharacterCard || settings.characterCardOnly) && characterId !== undefined && characters[characterId]) {
                const charContext = buildCharacterContext(characters[characterId]);
                if (charContext) {
                    messages.push({ role: 'system', content: charContext });
                }
            }

            // Author's Note as a system message
            appendAuthorsNoteToMessages(messages, settings.includeAuthorsNote, getAuthorsNote());

            // Chat history as a system message
            if (chatMessages.length > 0) {
                const chatHistory = formatChatHistory(chatMessages);
                if (chatHistory) {
                    messages.push({ role: 'system', content: `Roleplay chat history:\n\n${chatHistory}` });
                }
            }

            // Thread history as alternating user/assistant messages
            if (previousScratchpadMessages.length > 0) {
                const threadMessages = buildThreadMessages(previousScratchpadMessages);
                messages.push(...threadMessages);
            }

            // Current user question
            messages.push({ role: 'user', content: userQuestion });

            return { systemPrompt, messages };
        }

        // Default: concatenated single-prompt format
        const parts = [];

        // Include SillyTavern's main system prompt if enabled
        if (settings.includeSystemPrompt) {
            try {
                const stContext = SillyTavern.getContext();
                const stSystemPrompt = getStSystemPrompt(stContext);
                if (stSystemPrompt) {
                    parts.push('--- SYSTEM PROMPT ---');
                    parts.push(stSystemPrompt);
                }
            } catch (e) {
                console.warn('[ScratchPad] Could not retrieve system prompt:', e);
            }
        }

        // Character card (if enabled)
        if ((settings.includeCharacterCard || settings.characterCardOnly) && characterId !== undefined && characters[characterId]) {
            const charContext = buildCharacterContext(characters[characterId]);
            if (charContext) {
                parts.push('--- CHARACTER INFORMATION ---');
                parts.push(charContext);
            }
        }

        // Author's Note
        appendAuthorsNoteToPromptParts(parts, settings.includeAuthorsNote, getAuthorsNote());

        // Chat history
        if (chatMessages.length > 0) {
            const chatHistory = formatChatHistory(chatMessages);
            if (chatHistory) {
                parts.push('--- ROLEPLAY CHAT HISTORY ---');
                parts.push(chatHistory);
            }
        }

        // Thread history (for continuity)
        if (previousScratchpadMessages.length > 0) {
            const threadHistory = formatThreadHistory(previousScratchpadMessages);
            if (threadHistory) {
                parts.push('--- PREVIOUS SCRATCH PAD DISCUSSION ---');
                parts.push(threadHistory);
            }
        }

        // User question
        parts.push('--- USER QUESTION ---');
        parts.push(userQuestion);

        return {
            systemPrompt: systemPrompt,
            prompt: parts.join('\n\n')
        };
    }

    const tokenBudget = getPromptTokenBudget(context, profileId);
    let promptData = buildPromptData(selectedChat, scratchpadMessages);

    if (!tokenBudget) {
        return promptData;
    }

    let tokenCount = await countPromptTokens(promptDataToTokenText(promptData));
    let removedContextItems = 0;
    while (tokenCount > tokenBudget && removeOldestVariableContext(selectedChat, scratchpadMessages)) {
        removedContextItems += 1;
        promptData = buildPromptData(selectedChat, scratchpadMessages);
        tokenCount = await countPromptTokens(promptDataToTokenText(promptData));
    }

    if (removedContextItems > 0) {
        console.info(`[ScratchPad] Trimmed ${removedContextItems} context item(s) to fit ${tokenCount}/${tokenBudget} prompt tokens.`);
    } else if (tokenCount > tokenBudget) {
        console.warn(`[ScratchPad] Fixed prompt context exceeds the configured token budget (${tokenCount}/${tokenBudget}).`);
    }

    return promptData;
}

// Track active generation for streaming token identification
let activeGenerationId = null;
let isCancellationRequested = false;
let activeAbortController = null;

/**
 * Cancel any active generation
 * @returns {boolean} True if there was an active generation to cancel
 */
export function cancelGeneration() {
    if (activeGenerationId) {
        isCancellationRequested = true;
        activeGenerationId = null;

        // Abort our own streaming request if active
        if (activeAbortController) {
            try { activeAbortController.abort(); } catch { /* noop */ }
            activeAbortController = null;
        }

        // Try to stop SillyTavern's generation if possible
        try {
            const context = SillyTavern.getContext();
            if (context.stopGeneration) {
                context.stopGeneration();
            }
        } catch (e) {
            console.warn('[ScratchPad] Could not stop ST generation:', e);
        }

        return true;
    }
    return false;
}

/**
 * Check if generation is currently active
 * @returns {boolean} True if generation is active
 */
export function isGenerationActive() {
    return activeGenerationId !== null;
}

/**
 * Check and reset cancellation flag
 * @returns {boolean} True if cancellation was requested
 */
function checkAndResetCancellation() {
    const wasCancelled = isCancellationRequested;
    isCancellationRequested = false;
    return wasCancelled;
}

/**
 * Generate a scratch pad response
 * @param {string} userQuestion User's question
 * @param {string} threadId Thread ID
 * @param {Function} onStream Callback for streaming updates
 * @returns {Promise<Object>} { success, response, thinking, reasoningMeta, error }
 */
export async function generateScratchPadResponse(userQuestion, threadId, onStream = null) {
    const context = SillyTavern.getContext();

    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

    // Capture chat index at question time for branch filtering
    const chatIndexAtQuestion = context.chat ? context.chat.length : null;

    // Add user message
    const userMessage = addMessage(threadId, 'user', userQuestion, 'complete', chatIndexAtQuestion);
    if (!userMessage) {
        return { success: false, error: 'Failed to add user message' };
    }

    // Add pending assistant message
    const assistantMessage = addMessage(threadId, 'assistant', '', 'pending', chatIndexAtQuestion);
    if (!assistantMessage) {
        return { success: false, error: 'Failed to add assistant message' };
    }
    assistantMessage.gen_started = new Date().toISOString();
    assistantMessage.gen_finished = null;
    const profileResolution = getEffectiveProfileResolutionForThread(threadId);
    const generationInfo = getGenerationInfoForResolution(profileResolution);
    assistantMessage.extra = generationInfoToExtra(generationInfo);

    await saveMetadata();

    let genFinished = null;
    try {
        const currentThread = getThread(threadId);  // Re-fetch to get latest messages
        if (!currentThread) {
            return { success: false, error: 'Thread not found' };
        }
        const promptThread = excludeMessagesFromThread(currentThread, [userMessage.id, assistantMessage.id]);
        const isFirstMessage = !currentThread.titled;
        const globalSettings = getSettings();
        const promptData = await buildPrompt(userQuestion, promptThread, isFirstMessage, profileResolution.profileId);
        const result = await runGenerationForThread({
            threadId,
            promptData,
            onStream,
            useStandardGeneration: globalSettings.useStandardGeneration,
            profileResolution,
            generationInfo,
        });
        const resultGenerationInfo = result.generationInfo || generationInfo;

        genFinished = new Date().toISOString();
        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning, result.hiddenReasoning);
        const combinedThinking = reasoningPayload.thinking;
        const reasoningMeta = reasoningPayload.reasoningMeta;
        const responseWithoutThinking = reasoningPayload.cleanedResponse;

        // Always strip titles from responses; only update thread name on first message
        const { title, cleanedResponse } = parseThreadTitle(responseWithoutThinking);
        let finalResponse = cleanedResponse;
        if (isFirstMessage) {
            if (title) {
                updateThread(threadId, { name: title, titled: true });
            } else {
                updateThread(threadId, { name: generateFallbackTitle(userQuestion), titled: true });
            }
        }

        // Check if generation was cancelled
        if (checkAndResetCancellation()) {
            updateMessage(threadId, assistantMessage.id, {
                content: responseText || '',
                thinking: combinedThinking,
                reasoningMeta,
                gen_started: assistantMessage.gen_started,
                gen_finished: genFinished,
                extra: generationInfoToExtra(resultGenerationInfo),
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '', gen_started: assistantMessage.gen_started, gen_finished: genFinished, generationInfo: resultGenerationInfo };
        }

        // Update assistant message with content and thinking
        updateMessage(threadId, assistantMessage.id, {
            content: finalResponse,
            thinking: combinedThinking,
            reasoningMeta,
            gen_started: assistantMessage.gen_started,
            gen_finished: genFinished,
            extra: generationInfoToExtra(resultGenerationInfo),
            status: 'complete'
        });

        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking, reasoningMeta, gen_started: assistantMessage.gen_started, gen_finished: genFinished, generationInfo: resultGenerationInfo };

    } catch (error) {
        genFinished = genFinished || new Date().toISOString();
        if (checkAndResetCancellation()) {
            const thread = getThread(threadId);
            if (thread) {
                const msgIndex = thread.messages.findIndex(m => m.id === assistantMessage.id);
                if (msgIndex !== -1) {
                    thread.messages.splice(msgIndex, 1);
                }
            }
            await saveMetadata();
            return { success: false, cancelled: true };
        }

        console.error('[ScratchPad] Generation error:', error);

        // Mark message as failed
        updateMessage(threadId, assistantMessage.id, {
            content: '',
            gen_started: assistantMessage.gen_started,
            gen_finished: genFinished,
            extra: generationInfoToExtra(generationInfo),
            status: 'failed',
            error: error.message
        });

        await saveMetadata();

        return { success: false, error: error.message };
    }
}

/**
 * Build prompt for a swipe regeneration
 * Slices thread messages to before the target message so all swipes see the same context
 * @param {string} threadId Thread ID
 * @param {string} messageId Target assistant message ID
 * @param {string|null} [profileId] Optional Connection Manager profile ID for budget resolution
 * @returns {Promise<Object|null>} { systemPrompt, prompt, userQuestion } or { systemPrompt, messages, userQuestion } or null
 */
async function buildPromptForSwipe(threadId, messageId, profileId = null) {
    const swipeCtx = getSwipeContext(threadId, messageId);
    if (!swipeCtx) return null;
    const promptData = await buildPrompt(swipeCtx.userQuestion, swipeCtx.contextThread, false, profileId);
    return { ...promptData, userQuestion: swipeCtx.userQuestion };
}

/**
 * Generate a new swipe for an existing assistant message
 * @param {string} threadId Thread ID
 * @param {string} messageId Target assistant message ID
 * @param {Function} onStream Callback for streaming updates
 * @returns {Promise<Object>} { success, response, thinking, reasoningMeta, swipeIndex, error, cancelled }
 */
export async function generateSwipe(threadId, messageId, onStream = null) {
    const thread = getThread(threadId);
    if (!thread) return { success: false, error: 'Thread not found' };

    const message = getMessage(threadId, messageId);
    if (!message || message.role !== 'assistant') {
        return { success: false, error: 'Assistant message not found' };
    }

    const globalSettings = getSettings();
    const profileResolution = getEffectiveProfileResolutionForThread(threadId);
    const generationInfo = getGenerationInfoForResolution(profileResolution);

    // Build prompt / context for swipe
    let swipeCtx = null;
    let promptData = null;
    if (globalSettings.useStandardGeneration) {
        swipeCtx = getSwipeContext(threadId, messageId);
        if (!swipeCtx) return { success: false, error: 'Could not build prompt for swipe' };
        promptData = await buildPrompt(swipeCtx.userQuestion, swipeCtx.contextThread, false, profileResolution.profileId);
    } else {
        promptData = await buildPromptForSwipe(threadId, messageId, profileResolution.profileId);
        if (!promptData) return { success: false, error: 'Could not build prompt for swipe' };
    }

    // Initialize swipe fields and add empty swipe
    ensureSwipeFields(message);
    const previousSwipeId = message.swipeId;
    addSwipe(threadId, messageId, '', null, null, null, generationInfoToExtra(generationInfo));
    const newSwipeIndex = message.swipeId;
    const genStarted = new Date().toISOString();
    message.swipeGenStarted[newSwipeIndex] = genStarted;
    message.swipeGenFinished[newSwipeIndex] = null;
    message.swipeExtra[newSwipeIndex] = generationInfoToExtra(generationInfo);
    message.gen_started = genStarted;
    message.gen_finished = null;
    message.extra = generationInfoToExtra(generationInfo);
    message.status = 'pending';
    await saveMetadata();

    let genFinished = null;
    try {
        const result = await runGenerationForThread({
            threadId,
            promptData,
            onStream,
            useStandardGeneration: globalSettings.useStandardGeneration,
            profileResolution,
            generationInfo,
        });
        const resultGenerationInfo = result.generationInfo || generationInfo;

        genFinished = new Date().toISOString();
        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning, result.hiddenReasoning);
        const combinedThinking = reasoningPayload.thinking;
        const reasoningMeta = reasoningPayload.reasoningMeta;
        const responseWithoutThinking = reasoningPayload.cleanedResponse;

        // Strip title tags from swipe responses and apply extracted title to thread
        const { title, cleanedResponse: finalResponse } = parseThreadTitle(responseWithoutThinking);
        if (title) {
            updateThread(threadId, { name: title, titled: true });
        }

        // Check cancellation
        if (checkAndResetCancellation()) {
            // Remove the empty swipe and restore previous
            deleteSwipe(threadId, messageId, newSwipeIndex);
            setActiveSwipe(threadId, messageId, Math.min(previousSwipeId, (message.swipes?.length || 1) - 1));
            message.status = 'complete';
            syncSwipeToMessage(message);
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '', generationInfo: resultGenerationInfo };
        }

        // Update the swipe content
        message.swipes[newSwipeIndex] = finalResponse;
        message.swipeThinking[newSwipeIndex] = combinedThinking;
        message.swipeReasoningMeta[newSwipeIndex] = reasoningMeta;
        message.swipeTimestamps[newSwipeIndex] = new Date().toISOString();
        message.swipeGenStarted[newSwipeIndex] = genStarted;
        message.swipeGenFinished[newSwipeIndex] = genFinished;
        message.swipeExtra[newSwipeIndex] = generationInfoToExtra(resultGenerationInfo);
        message.status = 'complete';
        syncSwipeToMessage(message);
        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking, reasoningMeta, swipeIndex: newSwipeIndex, gen_started: genStarted, gen_finished: genFinished, generationInfo: resultGenerationInfo };

    } catch (error) {
        genFinished = genFinished || new Date().toISOString();
        if (checkAndResetCancellation()) {
            deleteSwipe(threadId, messageId, newSwipeIndex);
            setActiveSwipe(threadId, messageId, Math.min(previousSwipeId, (message.swipes?.length || 1) - 1));
            message.status = 'complete';
            syncSwipeToMessage(message);
            await saveMetadata();
            return { success: false, cancelled: true };
        }

        console.error('[ScratchPad] Swipe generation error:', error);

        // Remove the failed swipe and restore previous
        deleteSwipe(threadId, messageId, newSwipeIndex);
        setActiveSwipe(threadId, messageId, Math.min(previousSwipeId, (message.swipes?.length || 1) - 1));
        message.status = 'complete';
        syncSwipeToMessage(message);
        await saveMetadata();

        return { success: false, error: error.message };
    }
}

/**
 * Retry a failed message
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID to retry
 * @param {Function} onStream Callback for streaming updates
 * @returns {Promise<Object>} { success, response, error }
 */
export async function retryMessage(threadId, messageId, onStream = null) {
    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

    let message = getMessage(threadId, messageId);
    if (!message) {
        message = [...thread.messages].reverse().find(m => m.role === 'assistant' && m.status === 'failed') || null;
    }
    if (!message) {
        return { success: false, error: 'Message not found' };
    }

    // If the message has swipes, remove the failed swipe and generate a new one
    if (message.swipes && message.swipes.some(swipe => typeof swipe === 'string' && swipe.trim())) {
        const failedIdx = message.swipeId ?? (message.swipes.length - 1);
        deleteSwipe(threadId, message.id, failedIdx);
        message.status = 'complete';
        syncSwipeToMessage(message);
        await saveMetadata();
        return await generateSwipe(threadId, message.id, onStream);
    }

    // Legacy path: no swipes
    const messageIndex = thread.messages.findIndex(m => m.id === message.id);
    if (messageIndex === -1) {
        return { success: false, error: 'Message not found' };
    }

    // Find the user message before this assistant message
    let userQuestion = '';
    let userMsgIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (thread.messages[i].role === 'user') {
            userQuestion = thread.messages[i].content;
            userMsgIndex = i;
            break;
        }
    }

    if (!userQuestion) {
        return { success: false, error: 'Could not find original question' };
    }

    // Remove the failed message
    thread.messages.splice(messageIndex, 1);

    // Also remove the user message so generateScratchPadResponse can re-add it
    if (userMsgIndex !== -1) {
        thread.messages.splice(userMsgIndex, 1);
    }

    await saveMetadata();

    // Re-generate
    return await generateScratchPadResponse(userQuestion, threadId, onStream);
}

/**
 * Regenerate an assistant message by adding a new swipe alternative
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID to regenerate
 * @param {Function} onStream Callback for streaming updates
 * @returns {Promise<Object>} { success, response, error }
 */
export async function regenerateMessage(threadId, messageId, onStream = null) {
    return await generateSwipe(threadId, messageId, onStream);
}

/**
 * Check if a chat is active
 * @returns {boolean} True if a chat is active
 */
export function isChatActive() {
    const { characterId, groupId } = SillyTavern.getContext();
    const hasCharacterTarget = characterId !== undefined && characterId !== null && characterId !== -1;
    const hasGroupTarget = groupId !== undefined && groupId !== null && groupId !== -1;
    return hasCharacterTarget || hasGroupTarget;
}

/**
 * Check if Guided Generations extension is installed
 * @returns {boolean}
 */
export function isGuidedGenerationsInstalled() {
    return !!document.querySelector('#gg_swipe_button');
}

/**
 * Trigger Guided Generations swipe with given text
 * @param {string} guidanceText - Text to use as guidance
 * @returns {Promise<Object>} { success, error }
 */
export async function triggerGuidedSwipe(guidanceText) {
    const swipeBtn = document.querySelector('#gg_swipe_button');
    if (!swipeBtn) {
        return { success: false, error: 'Guided Generations extension not found' };
    }

    const input = document.querySelector('#send_textarea');
    if (!input) {
        return { success: false, error: 'Input field not found' };
    }

    try {
        // Fill the main ST input with guidance
        input.value = guidanceText;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Small delay to ensure input is registered
        await new Promise(resolve => setTimeout(resolve, 50));

        // Click the GG swipe button
        swipeBtn.click();

        return { success: true };
    } catch (error) {
        console.error('[ScratchPad] Failed to trigger guided swipe:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Trigger Guided Generations response with given text
 * @param {string} guidanceText - Text to use as guidance
 * @returns {Promise<Object>} { success, error }
 */
export async function triggerGuidedResponse(guidanceText) {
    const responseBtn = document.querySelector('#gg_response_button');
    if (!responseBtn) {
        return { success: false, error: 'Guided Generations extension not found' };
    }

    const input = document.querySelector('#send_textarea');
    if (!input) {
        return { success: false, error: 'Input field not found' };
    }

    try {
        input.value = guidanceText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        responseBtn.click();

        return { success: true };
    } catch (error) {
        console.error('[ScratchPad] Failed to trigger guided response:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Generate an AI-suggested title for a thread based on its content
 * @param {Object} thread Thread object
 * @returns {Promise<Object>} { success, title, error }
 */
export async function generateThreadTitle(thread) {
    if (!thread || !thread.messages || thread.messages.length === 0) {
        return { success: false, error: 'Thread has no messages' };
    }

    try {
        // Build a concise summary of the thread for context
        const threadHistory = formatThreadHistory(thread.messages);

        const systemPrompt = 'You are a helpful assistant that creates concise, descriptive titles for conversations.';

        const prompt = `Based on the following conversation, suggest a brief, descriptive title (3-6 words maximum) that captures the main topic or question being discussed.

--- CONVERSATION ---
${threadHistory}

Respond with ONLY the title, nothing else. Do not use quotes or formatting.`;

        const { text: response } = await runGenerationForThread({
            threadId: thread.id,
            promptData: { systemPrompt, prompt },
            useStandardGeneration: getSettings().useStandardGeneration,
        });

        // Clean up the response (remove quotes, extra whitespace, etc.)
        let title = (response || '').trim();
        title = title.replace(/^["']|["']$/g, ''); // Remove surrounding quotes
        title = title.replace(/^\*\*Title:\s*/i, ''); // Remove "Title:" prefix if present
        title = title.replace(/^\*\*(.*?)\*\*$/, '$1'); // Remove markdown bold
        title = title.trim();

        // Limit length
        if (title.length > 60) {
            title = title.substring(0, 57) + '...';
        }

        return { success: true, title };

    } catch (error) {
        console.error('[ScratchPad] Title generation error:', error);
        return { success: false, error: error.message };
    }
}
