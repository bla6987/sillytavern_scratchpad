/**
 * Generation module for Scratch Pad extension
 * Handles AI generation and prompt building
 */

import { getSettings } from './settings.js';
import { getThread, updateThread, addMessage, updateMessage, getMessage, saveMetadata, DEFAULT_CONTEXT_SETTINGS, getThreadContextSettings, ensureSwipeFields, addSwipe, setActiveSwipe, deleteSwipe, syncSwipeToMessage } from './storage.js';
import { parseThinkingFromText, extractReasoningFromResult, mergeReasoningCandidates } from './reasoning.js';
import { isStreamingSupported, streamGeneration, buildStreamReasoning } from './streaming.js';

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

// Mutex lock for profile switching to prevent race conditions
let profileSwitchLock = Promise.resolve();

/**
 * Switch to a different connection profile temporarily
 * @param {string} profileName Profile name
 * @param {Function} generateFn Function to execute with the profile
 * @returns {Promise<*>} Result from generateFn
 */
async function generateWithProfile(profileName, generateFn) {
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();

    if (!profileName || !executeSlashCommandsWithOptions) {
        return await generateFn();
    }

    // Wait for any pending profile switches to complete
    await profileSwitchLock;

    // Create a new lock that will be released when we're done
    let releaseLock;
    profileSwitchLock = new Promise(resolve => { releaseLock = resolve; });

    let currentProfile = '';
    let didSwitch = false;

    try {
        // Get current profile
        const profileResult = await executeSlashCommandsWithOptions('/profile', { handleParserErrors: false, handleExecutionErrors: false });
        if (profileResult && profileResult.pipe) {
            currentProfile = profileResult.pipe.trim();
        }

        // Switch to alternative profile
        const safeProfileName = profileName.replace(/\|/g, '').replace(/^\//gm, '');
        await executeSlashCommandsWithOptions(`/profile ${safeProfileName}`, { handleParserErrors: false, handleExecutionErrors: false });
        didSwitch = true;

        // Execute generation
        const result = await generateFn();
        return result;
    } finally {
        // Restore original profile
        if (didSwitch) {
            try {
                // /profile returns '<None>' when no profile is active, and
                // /profile <None> clears the active profile back to default.
                // Fall back to '<None>' if the pipe was unexpectedly empty.
                const restoreProfile = currentProfile || '<None>';
                const safeRestoreProfile = restoreProfile.replace(/\|/g, '').replace(/^\//gm, '');
                await executeSlashCommandsWithOptions(`/profile ${safeRestoreProfile}`, { handleParserErrors: false, handleExecutionErrors: false });
            } catch (e) {
                console.warn('[ScratchPad] Could not restore profile:', e);
                toastr.warning('Could not restore your previous connection profile. You may need to switch back manually.', 'Scratch Pad');
            }
        }
        // Release the lock
        releaseLock();
    }
}

/**
 * Get the effective connection profile for a thread
 * Priority: Thread override -> Global setting -> null (default API)
 * @param {string} threadId Thread ID
 * @returns {string|null} Profile name to use, or null for default API
 */
export function getEffectiveProfileForThread(threadId) {
    const thread = getThread(threadId);
    const settings = getSettings();

    // Check thread's connectionProfile override first
    const threadSettings = getThreadContextSettings(threadId);
    if (threadSettings.connectionProfile) {
        return threadSettings.connectionProfile;
    }

    // Fall back to global settings
    if (settings.useAlternativeApi && settings.connectionProfile) {
        return settings.connectionProfile;
    }

    return null;
}

function buildReasoningPayload(responseText, streamReasoning = null, resultReasoning = null) {
    const parsed = parseThinkingFromText(responseText);
    const merged = mergeReasoningCandidates(streamReasoning, resultReasoning, parsed.reasoning);
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

    /**
     * Build the messages array for the API request.
     * When prebuiltMessages is provided (multi-message mode), prepend the system prompt
     * and apply substituteParams. Otherwise, build the traditional 2-message array.
     */
    function buildMessages() {
        if (prebuiltMessages) {
            const msgs = [];
            if (systemPrompt) {
                msgs.push({ role: 'system', content: context.substituteParams(systemPrompt) });
            }
            for (const msg of prebuiltMessages) {
                msgs.push({ role: msg.role, content: context.substituteParams(msg.content) });
            }
            return msgs;
        }
        const msgs = [];
        if (systemPrompt) {
            msgs.push({ role: 'system', content: context.substituteParams(systemPrompt) });
        }
        msgs.push({ role: 'user', content: context.substituteParams(prompt) });
        return msgs;
    }

    // Try streaming first when supported and a token callback is provided
    if (onToken && currentApi === 'openai' && isStreamingSupported()) {
        try {
            const messages = buildMessages();

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
            const messages = buildMessages();

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
                const messages = buildMessages();
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
            const messages = buildMessages();
            const result = await context.generateRaw({ prompt: messages });
            generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
        } else {
            const result = await context.generateRaw({ systemPrompt, prompt });
            generationResult = { text: result || '', streamReasoning: null, resultReasoning: null };
        }
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
 * Standard generation using SillyTavern's full pipeline (generateQuietPrompt).
 * Returns the same shape as callGeneration() for downstream compatibility.
 * @param {Object} options
 * @param {string} options.quietPrompt Prompt injected into ST's pipeline
 * @returns {Promise<{text: string, streamReasoning: null, resultReasoning: null}>}
 */
async function callStandardGeneration({ quietPrompt }) {
    const context = SillyTavern.getContext();
    const text = await context.generateQuietPrompt({
        quietPrompt,
        removeReasoning: false, // we parse reasoning ourselves
    });

    // Report token usage (approximate — only our quiet prompt, not ST's full constructed prompt)
    try {
        const tracker = window['TokenUsageTracker'];
        if (tracker) {
            const inputTokens = await tracker.countTokens(quietPrompt || '');
            const outputTokens = await tracker.countTokens(text || '');
            const modelId = tracker.getCurrentModelId();
            const sourceId = tracker.getCurrentSourceId();
            const chatId = SillyTavern.getContext().getCurrentChatId?.() || null;
            tracker.recordUsage(inputTokens, outputTokens, chatId, modelId, sourceId, 0);
        }
    } catch (e) {
        console.warn('[ScratchPad] Token usage reporting failed:', e);
    }

    return { text: text || '', streamReasoning: null, resultReasoning: null };
}

/**
 * Build the quiet prompt string for standard generation mode.
 * ST already includes character card + chat history + world info,
 * so we only include extension-specific context (OOC instruction, thread history, question).
 * @param {string} userQuestion User's question
 * @param {Object} thread Thread object (for previous discussion history)
 * @param {boolean} isFirstMessage Whether to request a title
 * @returns {string} Combined quiet prompt
 */
function buildQuietPrompt(userQuestion, thread, isFirstMessage) {
    const settings = getSettings();
    const parts = [];

    // OOC system instruction
    parts.push(settings.oocSystemPrompt);

    // Title instruction for first message
    if (isFirstMessage) {
        parts.push('At the very beginning of your response, provide a brief title (3-6 words) formatted as: **Title: [Your Title Here]**\nThen provide your response.');
    }

    // Thread history (previous scratch pad discussion)
    if (thread?.messages?.length > 0) {
        const threadHistory = formatThreadHistory(thread.messages);
        if (threadHistory) {
            parts.push('--- PREVIOUS SCRATCH PAD DISCUSSION ---');
            parts.push(threadHistory);
        }
    }

    // User question
    parts.push('--- USER QUESTION ---');
    parts.push(userQuestion);

    return parts.join('\n\n');
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

export async function generateRawPromptResponse(userPrompt, threadId, onStream = null) {
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

    await saveMetadata();

    try {
        const globalSettings = getSettings();

        const doGenerate = globalSettings.useStandardGeneration
            ? async () => {
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const result = await callStandardGeneration({ quietPrompt: userPrompt });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            }
            : async () => {
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const onToken = onStream ? (partialText) => onStream(partialText, false) : undefined;
                    const result = await callGeneration({ systemPrompt: '', prompt: userPrompt, onToken });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            };

        let result;
        const effectiveProfile = getEffectiveProfileForThread(threadId);
        if (effectiveProfile) {
            result = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning);
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
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '' };
        }

        updateMessage(threadId, assistantMessage.id, {
            content: responseWithoutThinking,
            thinking: combinedThinking,
            reasoningMeta,
            noContext: true,
            status: 'complete'
        });

        if (thread.messages.length <= 2) {
            updateThread(threadId, { name: generateFallbackTitle(userPrompt), titled: true });
        }

        await saveMetadata();

        return { success: true, response: responseWithoutThinking, thinking: combinedThinking, reasoningMeta };

    } catch (error) {
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
            status: 'failed',
            error: error.message
        });

        await saveMetadata();

        return { success: false, error: error.message };
    }
}

/**
 * Build the complete prompt for scratch pad generation
 * @param {string} userQuestion User's question
 * @param {Object} thread Thread object
 * @param {boolean} isFirstMessage Whether this is the first message in the thread
 * @returns {Object} { systemPrompt, prompt } or { systemPrompt, messages } when multi-message mode
 */
function buildPrompt(userQuestion, thread, isFirstMessage = false) {
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

    // Multi-message format: return structured messages array
    if (globalSettings.useMultiMessageFormat) {
        const messages = [];

        // ST system prompt as a system message
        if (settings.includeSystemPrompt) {
            try {
                const stContext = SillyTavern.getContext();
                let stSystemPrompt = '';
                if (typeof stContext.getSystemPrompt === 'function') {
                    stSystemPrompt = stContext.getSystemPrompt();
                } else if (typeof stContext.systemPrompt === 'string') {
                    stSystemPrompt = stContext.systemPrompt;
                }
                if (stSystemPrompt && stSystemPrompt.trim()) {
                    messages.push({ role: 'system', content: stSystemPrompt.trim() });
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

        // Chat history as a system message
        if (!settings.characterCardOnly && chat && chat.length > 0) {
            const selectedChat = selectChatHistory(chat, settings);
            const chatHistory = formatChatHistory(selectedChat);
            if (chatHistory) {
                messages.push({ role: 'system', content: `Roleplay chat history:\n\n${chatHistory}` });
            }
        }

        // Thread history as alternating user/assistant messages
        if (!settings.characterCardOnly && thread && thread.messages && thread.messages.length > 0) {
            const threadMessages = buildThreadMessages(thread.messages);
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
            let stSystemPrompt = '';
            if (typeof stContext.getSystemPrompt === 'function') {
                stSystemPrompt = stContext.getSystemPrompt();
            } else if (typeof stContext.systemPrompt === 'string') {
                stSystemPrompt = stContext.systemPrompt;
            }
            if (stSystemPrompt && stSystemPrompt.trim()) {
                parts.push('--- SYSTEM PROMPT ---');
                parts.push(stSystemPrompt.trim());
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

    // Chat history
    if (!settings.characterCardOnly && chat && chat.length > 0) {
        const selectedChat = selectChatHistory(chat, settings);
        const chatHistory = formatChatHistory(selectedChat);
        if (chatHistory) {
            parts.push('--- ROLEPLAY CHAT HISTORY ---');
            parts.push(chatHistory);
        }
    }

    // Thread history (for continuity)
    if (!settings.characterCardOnly && thread && thread.messages && thread.messages.length > 0) {
        const threadHistory = formatThreadHistory(thread.messages);
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
            } else if (context.abortController) {
                context.abortController.abort();
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

    await saveMetadata();

    try {
        const currentThread = getThread(threadId);  // Re-fetch to get latest messages
        if (!currentThread) {
            return { success: false, error: 'Thread not found' };
        }
        const isFirstMessage = !currentThread.titled;
        const globalSettings = getSettings();

        const doGenerate = globalSettings.useStandardGeneration
            ? async () => {
                const quietPrompt = buildQuietPrompt(userQuestion, currentThread, isFirstMessage);
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const result = await callStandardGeneration({ quietPrompt });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            }
            : async () => {
                const promptData = buildPrompt(userQuestion, currentThread, isFirstMessage);
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const onToken = onStream ? (partialText) => onStream(partialText, false) : undefined;
                    const result = await callGeneration({
                        systemPrompt: promptData.systemPrompt,
                        prompt: promptData.prompt,
                        messages: promptData.messages,
                        onToken,
                    });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            };

        // Execute with profile switching if enabled
        let result;
        const effectiveProfile = getEffectiveProfileForThread(threadId);
        if (effectiveProfile) {
            result = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning);
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
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '' };
        }

        // Update assistant message with content and thinking
        updateMessage(threadId, assistantMessage.id, {
            content: finalResponse,
            thinking: combinedThinking,
            reasoningMeta,
            status: 'complete'
        });

        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking, reasoningMeta };

    } catch (error) {
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
 * @returns {Object|null} { systemPrompt, prompt, userQuestion } or { systemPrompt, messages, userQuestion } or null
 */
function buildPromptForSwipe(threadId, messageId) {
    const swipeCtx = getSwipeContext(threadId, messageId);
    if (!swipeCtx) return null;
    const promptData = buildPrompt(swipeCtx.userQuestion, swipeCtx.contextThread, false);
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

    // Build prompt / context for swipe
    let swipeCtx = null;
    let promptData = null;
    if (globalSettings.useStandardGeneration) {
        swipeCtx = getSwipeContext(threadId, messageId);
        if (!swipeCtx) return { success: false, error: 'Could not build prompt for swipe' };
    } else {
        promptData = buildPromptForSwipe(threadId, messageId);
        if (!promptData) return { success: false, error: 'Could not build prompt for swipe' };
    }

    // Initialize swipe fields and add empty swipe
    ensureSwipeFields(message);
    const previousSwipeId = message.swipeId;
    addSwipe(threadId, messageId, '', null, null, null);
    const newSwipeIndex = message.swipeId;
    message.status = 'pending';
    await saveMetadata();

    try {
        const doGenerate = globalSettings.useStandardGeneration
            ? async () => {
                const quietPrompt = buildQuietPrompt(swipeCtx.userQuestion, swipeCtx.contextThread, false);
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const result = await callStandardGeneration({ quietPrompt });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            }
            : async () => {
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;
                try {
                    const onToken = onStream ? (partialText) => onStream(partialText, false) : undefined;
                    const result = await callGeneration({
                        systemPrompt: promptData.systemPrompt,
                        prompt: promptData.prompt,
                        messages: promptData.messages,
                        onToken,
                    });
                    if (onStream) onStream(result.text, true);
                    return result;
                } finally {
                    if (activeGenerationId === generationId) activeGenerationId = null;
                }
            };

        let result;
        const effectiveProfile = getEffectiveProfileForThread(threadId);
        if (effectiveProfile) {
            result = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        const responseText = result.text || '';
        const reasoningPayload = buildReasoningPayload(responseText, result.streamReasoning, result.resultReasoning);
        const combinedThinking = reasoningPayload.thinking;
        const reasoningMeta = reasoningPayload.reasoningMeta;
        const responseWithoutThinking = reasoningPayload.cleanedResponse;

        // Strip title tags from swipe responses (they shouldn't appear in regenerations)
        const { cleanedResponse: finalResponse } = parseThreadTitle(responseWithoutThinking);

        // Check cancellation
        if (checkAndResetCancellation()) {
            // Remove the empty swipe and restore previous
            deleteSwipe(threadId, messageId, newSwipeIndex);
            setActiveSwipe(threadId, messageId, Math.min(previousSwipeId, (message.swipes?.length || 1) - 1));
            message.status = 'complete';
            syncSwipeToMessage(message);
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '' };
        }

        // Update the swipe content
        message.swipes[newSwipeIndex] = finalResponse;
        message.swipeThinking[newSwipeIndex] = combinedThinking;
        message.swipeReasoningMeta[newSwipeIndex] = reasoningMeta;
        message.swipeTimestamps[newSwipeIndex] = new Date().toISOString();
        message.status = 'complete';
        syncSwipeToMessage(message);
        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking, reasoningMeta, swipeIndex: newSwipeIndex };

    } catch (error) {
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

    const message = getMessage(threadId, messageId);
    if (!message) {
        return { success: false, error: 'Message not found' };
    }

    // If the message has swipes, remove the failed swipe and generate a new one
    if (message.swipes && message.swipes.length > 0) {
        const failedIdx = message.swipeId ?? (message.swipes.length - 1);
        deleteSwipe(threadId, messageId, failedIdx);
        message.status = 'complete';
        syncSwipeToMessage(message);
        await saveMetadata();
        return await generateSwipe(threadId, messageId, onStream);
    }

    // Legacy path: no swipes
    const messageIndex = thread.messages.findIndex(m => m.id === messageId);
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
    const { chat, characterId, groupId } = SillyTavern.getContext();
    return (chat && chat.length > 0) && (characterId !== undefined || groupId !== undefined);
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

        const doGenerate = getSettings().useStandardGeneration
            ? async () => {
                const titleQuiet = `${systemPrompt}\n\n${prompt}`;
                const { text } = await callStandardGeneration({ quietPrompt: titleQuiet });
                return text;
            }
            : async () => {
                const { text } = await callGeneration({ systemPrompt, prompt });
                return text;
            };

        // Execute with profile switching if enabled
        let response;
        const effectiveProfile = getEffectiveProfileForThread(thread.id);
        if (effectiveProfile) {
            response = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            response = await doGenerate();
        }

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
