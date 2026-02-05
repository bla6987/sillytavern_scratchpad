/**
 * Generation module for Scratch Pad extension
 * Handles AI generation and prompt building
 */

import { getSettings } from './settings.js';
import { getThread, updateThread, addMessage, updateMessage, saveMetadata, DEFAULT_CONTEXT_SETTINGS, getThreadContextSettings } from './storage.js';

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
    if (!response) return { thinking: null, cleanedResponse: '' };

    // Match <thinking>...</thinking> or <think>...</think> (case insensitive, multiline)
    const thinkingRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;

    let thinking = null;
    let cleanedResponse = response;

    // Collect all thinking blocks
    const matches = [...response.matchAll(thinkingRegex)];
    if (matches.length > 0) {
        thinking = matches.map(m => m[1].trim()).join('\n\n');
        cleanedResponse = response.replace(thinkingRegex, '').trim();
    }

    return { thinking, cleanedResponse };
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
    }

    return '';
}

function contentBlocksToAssistantText(blocks) {
    if (!Array.isArray(blocks)) return '';

    const parts = [];
    for (const b of blocks) {
        if (!b) continue;
        if (typeof b === 'string') {
            parts.push(b);
            continue;
        }
        if (typeof b !== 'object') continue;

        const type = typeof b.type === 'string' ? b.type : '';

        // Anthropic content blocks commonly contain separate "thinking" blocks.
        // Only render user-visible text blocks into the assistant message.
        if (type === 'text' || type === 'output_text') {
            const t = normalizeTextContent(b.text) || normalizeTextContent(b.output_text) || normalizeTextContent(b.content);
            if (t) parts.push(t);
        }
    }

    return parts.join('').trim();
}

function contentBlocksToReasoning(blocks) {
    if (!Array.isArray(blocks)) return '';

    const parts = [];
    for (const b of blocks) {
        if (!b) continue;
        if (typeof b !== 'object') continue;

        const type = typeof b.type === 'string' ? b.type : '';
        if (!type) continue;

        // Anthropic-style reasoning blocks.
        if (type === 'thinking' || type === 'reasoning' || type === 'reasoning.text') {
            const t = normalizeTextContent(b.thinking) || normalizeTextContent(b.reasoning) || normalizeTextContent(b.text) || normalizeTextContent(b.summary);
            if (t) parts.push(t.trim());
        }
    }

    return parts.join('\n\n').trim();
}

function reasoningDetailsToString(details) {
    if (!Array.isArray(details)) return '';

    const parts = [];
    for (const item of details) {
        if (!item) continue;
        if (item.type === 'reasoning.encrypted') continue;

        if (typeof item.text === 'string' && item.text.trim()) {
            parts.push(item.text.trim());
            continue;
        }

        if (typeof item.summary === 'string' && item.summary.trim()) {
            parts.push(item.summary.trim());
        }
    }

    return parts.join('\n\n').trim();
}

function extractAssistantText(result, fallback = '') {
    if (!result) return fallback;
    if (typeof result === 'string') return result;

    if (typeof result.text === 'string' && result.text) return result.text;
    if (typeof result.response === 'string' && result.response) return result.response;
    if (typeof result.content === 'string' && result.content) return result.content;

    const choice = result.choices?.[0];
    const msg = choice?.message || choice?.delta;
    const msgContent = msg?.content;
    const msgText = contentBlocksToAssistantText(msgContent) || normalizeTextContent(msgContent) || normalizeTextContent(msg?.text);
    if (msgText) return msgText;

    const directMsgText = normalizeTextContent(result.message?.content) || normalizeTextContent(result.message?.text);
    if (directMsgText) return directMsgText;

    return fallback;
}

function extractStructuredReasoning(result) {
    if (!result) return '';
    if (typeof result === 'string') return '';

    const directCandidates = [
        result.thinking,
        result.reasoning,
        result.extended_thinking,
        result.extra?.thinking,
        result.extra?.reasoning,
    ];

    for (const c of directCandidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }

    const detailsCandidates = [
        result.reasoning_details,
        result.extra?.reasoning_details,
        result.choices?.[0]?.message?.reasoning_details,
        result.choices?.[0]?.delta?.reasoning_details,
    ];

    for (const d of detailsCandidates) {
        const text = reasoningDetailsToString(d);
        if (text) return text;
    }

    const contentCandidates = [
        result.choices?.[0]?.message?.content,
        result.choices?.[0]?.delta?.content,
        result.message?.content,
    ];

    for (const c of contentCandidates) {
        const text = contentBlocksToReasoning(c);
        if (text) return text;
    }

    const stringCandidates = [
        result.choices?.[0]?.message?.reasoning,
        result.choices?.[0]?.delta?.reasoning,
    ];

    for (const c of stringCandidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }

    return '';
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

    try {
        // Get current profile
        const profileResult = await executeSlashCommandsWithOptions('/profile', { handleParserErrors: false, handleExecutionErrors: false });
        if (profileResult && profileResult.pipe) {
            currentProfile = profileResult.pipe.trim();
        }

        // Switch to alternative profile
        const safeProfileName = profileName.replace(/\|/g, '').replace(/^\//gm, '');
        await executeSlashCommandsWithOptions(`/profile ${safeProfileName}`, { handleParserErrors: false, handleExecutionErrors: false });

        // Execute generation
        const result = await generateFn();
        return result;
    } finally {
        // Restore original profile
        if (currentProfile) {
            try {
                const safeCurrentProfile = currentProfile.replace(/\|/g, '').replace(/^\//gm, '');
                await executeSlashCommandsWithOptions(`/profile ${safeCurrentProfile}`, { handleParserErrors: false, handleExecutionErrors: false });
            } catch (e) {
                console.warn('[ScratchPad] Could not restore profile:', e);
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

export async function generateRawPromptResponse(userPrompt, threadId, onStream = null) {
    const context = SillyTavern.getContext();
    const { generateRaw, eventSource, event_types } = context;

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
        const doGenerate = async () => {
            let fullResponse = '';
            let structuredReasoning = '';

            if (onStream && eventSource && event_types?.STREAM_TOKEN_RECEIVED) {
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;

                const streamHandler = (text) => {
                    if (activeGenerationId === generationId) {
                        fullResponse = text;
                        onStream(fullResponse, false);
                    }
                };

                const reasoningHandler = (reasoning) => {
                    if (activeGenerationId === generationId && reasoning) {
                        structuredReasoning = reasoning;
                    }
                };

                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamHandler);

                if (event_types?.STREAM_REASONING_DONE) {
                    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningHandler);
                }

                try {
                    const result = await generateRaw({
                        systemPrompt: '',
                        prompt: userPrompt,
                    });

                    // Handle result - can be string or object with thinking/reasoning
                    if (result && typeof result === 'object') {
                        fullResponse = extractAssistantText(result, fullResponse);
                        // Capture thinking from multiple possible locations (Anthropic, OpenAI, etc.)
                        if (!structuredReasoning) {
                            structuredReasoning = extractStructuredReasoning(result);
                        }
                    } else {
                        fullResponse = result || fullResponse;
                    }
                    onStream(fullResponse, true);
                } finally {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamHandler);
                    if (event_types?.STREAM_REASONING_DONE) {
                        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningHandler);
                    }
                    if (activeGenerationId === generationId) {
                        activeGenerationId = null;
                    }
                }
            } else {
                const result = await generateRaw({
                    systemPrompt: '',
                    prompt: userPrompt,
                });

                // Handle result - can be string or object with thinking/reasoning
                if (result && typeof result === 'object') {
                    fullResponse = extractAssistantText(result, '');
                    structuredReasoning = extractStructuredReasoning(result);
                } else {
                    fullResponse = result || '';
                }

                if (onStream) {
                    onStream(fullResponse, true);
                }
            }

            return { text: fullResponse, reasoning: structuredReasoning };
        };

        let result;
        const effectiveProfile = getEffectiveProfileForThread(threadId);
        if (effectiveProfile) {
            result = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        // Extract text and reasoning from result (which should be { text, reasoning } from doGenerate)
        const responseText = (result && typeof result === 'object') ? (result.text || '') : (result || '');
        const structuredReasoning = (result && typeof result === 'object') ? (result.reasoning || '') : '';

        const { thinking: tagParsedThinking, cleanedResponse: responseWithoutThinking } = parseThinking(responseText);

        let combinedThinking = structuredReasoning || tagParsedThinking || null;
        if (structuredReasoning && tagParsedThinking) {
            combinedThinking = `${structuredReasoning}\n\n---\n\n${tagParsedThinking}`;
        }

        // Check if generation was cancelled
        if (checkAndResetCancellation()) {
            updateMessage(threadId, assistantMessage.id, {
                content: responseText || '',
                thinking: combinedThinking,
                noContext: true,
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '' };
        }

        updateMessage(threadId, assistantMessage.id, {
            content: responseWithoutThinking,
            thinking: combinedThinking,
            noContext: true,
            status: 'complete'
        });

        if (thread.messages.length <= 2) {
            updateThread(threadId, { name: generateFallbackTitle(userPrompt), titled: true });
        }

        await saveMetadata();

        return { success: true, response: responseWithoutThinking, thinking: combinedThinking };

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
 * @returns {Object} { systemPrompt, prompt }
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

    const parts = [];

    // OOC system instruction
    let systemPrompt = settings.oocSystemPrompt;

    // Add title instruction only for first message
    if (isFirstMessage) {
        systemPrompt += '\n\nAt the very beginning of your first response in this new conversation, provide a brief title (3-6 words) for this discussion on its own line, formatted as: **Title: [Your Title Here]**\n\nThen provide your response.';
    }

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

/**
 * Cancel any active generation
 * @returns {boolean} True if there was an active generation to cancel
 */
export function cancelGeneration() {
    if (activeGenerationId) {
        isCancellationRequested = true;
        activeGenerationId = null;

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
 * @returns {Promise<Object>} { success, response, error }
 */
export async function generateScratchPadResponse(userQuestion, threadId, onStream = null) {
    const context = SillyTavern.getContext();
    const { generateRaw, eventSource, event_types } = context;

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
        const { systemPrompt, prompt } = buildPrompt(userQuestion, currentThread, isFirstMessage);

        // Generation function
        const doGenerate = async () => {
            let fullResponse = '';
            let structuredReasoning = '';

            const useStreaming = onStream && eventSource && event_types?.STREAM_TOKEN_RECEIVED;

            if (useStreaming) {
                // Use event-based streaming (SillyTavern v1.12.6+)
                const generationId = `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                activeGenerationId = generationId;

                // Handler for streaming tokens
                const streamHandler = (text) => {
                    // Only process if this is our active generation
                    if (activeGenerationId === generationId) {
                        fullResponse = text;
                        onStream(fullResponse, false);
                    }
                };

                // Handler for structured reasoning (Anthropic extended thinking, DeepSeek, Gemini, etc.)
                const reasoningHandler = (reasoning) => {
                    if (activeGenerationId === generationId && reasoning) {
                        structuredReasoning = reasoning;
                    }
                };

                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamHandler);
                if (event_types?.STREAM_REASONING_DONE) {
                    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningHandler);
                }

                try {
                    const result = await generateRaw({
                        systemPrompt,
                        prompt
                    });

                    // Handle result - can be string or object with thinking/reasoning
                    if (result && typeof result === 'object') {
                        fullResponse = extractAssistantText(result, fullResponse);
                        // Capture thinking from multiple possible locations (Anthropic, OpenAI, etc.)
                        if (!structuredReasoning) {
                            structuredReasoning = extractStructuredReasoning(result);
                        }
                    } else {
                        fullResponse = result || fullResponse;
                    }
                    onStream(fullResponse, true);
                } finally {
                    // Clean up: remove listeners and clear active generation
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamHandler);
                    if (event_types?.STREAM_REASONING_DONE) {
                        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningHandler);
                    }
                    if (activeGenerationId === generationId) {
                        activeGenerationId = null;
                    }
                }
            } else {
                // Non-streaming generation (or streaming not available)
                const result = await generateRaw({
                    systemPrompt,
                    prompt
                });

                // Handle result - can be string or object with thinking/reasoning
                if (result && typeof result === 'object') {
                    fullResponse = extractAssistantText(result, '');
                    structuredReasoning = extractStructuredReasoning(result);
                } else {
                    fullResponse = result || '';
                }

                if (onStream) {
                    // Call onStream with final result if callback provided but streaming unavailable
                    onStream(fullResponse, true);
                }
            }

            return { text: fullResponse, reasoning: structuredReasoning };
        };

        // Execute with profile switching if enabled
        let result;
        const effectiveProfile = getEffectiveProfileForThread(threadId);
        if (effectiveProfile) {
            result = await generateWithProfile(effectiveProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        // Extract text and structured reasoning from result
        const responseText = (result && typeof result === 'object') ? (result.text || '') : (result || '');
        const structuredReasoning = (result && typeof result === 'object') ? (result.reasoning || '') : '';

        // Parse thinking from response text (for models using XML tags like <think>)
        const { thinking: tagParsedThinking, cleanedResponse: responseWithoutThinking } = parseThinking(responseText);

        // Merge structured reasoning (Anthropic, Gemini, DeepSeek) with tag-parsed reasoning
        // Prefer structured reasoning if available, as it's the native format
        let combinedThinking = structuredReasoning || tagParsedThinking || null;
        if (structuredReasoning && tagParsedThinking) {
            // If we have both, combine them (unlikely but possible)
            combinedThinking = `${structuredReasoning}\n\n---\n\n${tagParsedThinking}`;
        }

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
                status: responseText ? 'complete' : 'cancelled'
            });
            await saveMetadata();
            return { success: false, cancelled: true, response: responseText || '' };
        }

        // Update assistant message with content and thinking
        updateMessage(threadId, assistantMessage.id, {
            content: finalResponse,
            thinking: combinedThinking,
            status: 'complete'
        });

        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking };

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
    // Note: after splicing messageIndex, userMsgIndex is still valid since it's before messageIndex
    if (userMsgIndex !== -1) {
        thread.messages.splice(userMsgIndex, 1);
    }

    await saveMetadata();

    // Re-generate
    return await generateScratchPadResponse(userQuestion, threadId, onStream);
}

/**
 * Regenerate an assistant message (removes all messages after it, creating a branch point)
 * @param {string} threadId Thread ID
 * @param {string} messageId Message ID to regenerate
 * @param {Function} onStream Callback for streaming updates
 * @returns {Promise<Object>} { success, response, error }
 */
export async function regenerateMessage(threadId, messageId, onStream = null) {
    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

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

    // Remove the assistant message and all messages after it (branch effect)
    thread.messages.splice(messageIndex);

    // Also remove the user message so generateScratchPadResponse can re-add it
    if (userMsgIndex !== -1) {
        thread.messages.splice(userMsgIndex, 1);
    }

    await saveMetadata();

    // Re-generate
    return await generateScratchPadResponse(userQuestion, threadId, onStream);
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

    const context = SillyTavern.getContext();
    const { generateRaw } = context;

    try {
        // Build a concise summary of the thread for context
        const threadHistory = formatThreadHistory(thread.messages);

        const systemPrompt = 'You are a helpful assistant that creates concise, descriptive titles for conversations.';

        const prompt = `Based on the following conversation, suggest a brief, descriptive title (3-6 words maximum) that captures the main topic or question being discussed.

--- CONVERSATION ---
${threadHistory}

Respond with ONLY the title, nothing else. Do not use quotes or formatting.`;

        // Generation function
        const doGenerate = async () => {
            return await generateRaw({
                systemPrompt,
                prompt
            });
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
        let title = extractAssistantText(response, '').trim();
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

