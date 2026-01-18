/**
 * Generation module for Scratch Pad extension
 * Handles AI generation and prompt building
 */

import { getSettings } from './settings.js';
import { getThread, updateThread, addMessage, updateMessage, saveMetadata } from './storage.js';

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

    let currentProfile = '';

    try {
        // Get current profile
        const profileResult = await executeSlashCommandsWithOptions('/profile', { handleParserErrors: false, handleExecutionErrors: false });
        if (profileResult && profileResult.pipe) {
            currentProfile = profileResult.pipe.trim();
        }

        // Switch to alternative profile
        await executeSlashCommandsWithOptions(`/profile ${profileName}`, { handleParserErrors: false, handleExecutionErrors: false });

        // Execute generation
        const result = await generateFn();
        return result;
    } finally {
        // Restore original profile
        if (currentProfile) {
            try {
                await executeSlashCommandsWithOptions(`/profile ${currentProfile}`, { handleParserErrors: false, handleExecutionErrors: false });
            } catch (e) {
                console.warn('[ScratchPad] Could not restore profile:', e);
            }
        }
    }
}

export async function generateRawPromptResponse(userPrompt, threadId, onStream = null) {
    const context = SillyTavern.getContext();
    const { generateRaw, eventSource, event_types } = context;
    const settings = getSettings();

    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

    const userMessage = addMessage(threadId, 'user', userPrompt, 'complete');
    if (!userMessage) {
        return { success: false, error: 'Failed to add user message' };
    }
    userMessage.noContext = true;

    const assistantMessage = addMessage(threadId, 'assistant', '', 'pending');
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
                    console.log('[ScratchPad] reasoningHandler fired! reasoning:', reasoning);
                    console.log('[ScratchPad] reasoning type:', typeof reasoning);
                    console.log('[ScratchPad] reasoning length:', reasoning ? reasoning.length : 0);
                    if (activeGenerationId === generationId && reasoning) {
                        structuredReasoning = reasoning;
                        console.log('[ScratchPad] Captured reasoning from event, length:', structuredReasoning.length);
                    }
                };

                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamHandler);

                // DEBUG: Log all available event types related to reasoning
                console.log('[ScratchPad] Available event_types:', Object.keys(event_types).filter(k => k.includes('REASON') || k.includes('THINK')));

                if (event_types?.STREAM_REASONING_DONE) {
                    console.log('[ScratchPad] STREAM_REASONING_DONE event exists, registering handler');
                    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningHandler);
                } else {
                    console.log('[ScratchPad] STREAM_REASONING_DONE event NOT available');
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
        if (settings.useAlternativeApi && settings.connectionProfile) {
            result = await generateWithProfile(settings.connectionProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        // Extract text and reasoning from result (which should be { text, reasoning } from doGenerate)
        const responseText = (result && typeof result === 'object') ? (result.text || '') : (result || '');
        const structuredReasoning = (result && typeof result === 'object') ? (result.reasoning || '') : '';

        console.log('[ScratchPad] Raw prompt - Extracted from result:', {
            resultType: typeof result,
            responseTextLength: responseText.length,
            structuredReasoningLength: structuredReasoning.length,
            resultKeys: (result && typeof result === 'object') ? Object.keys(result) : 'N/A',
            resultObject: (result && typeof result === 'object') ? result : 'N/A'
        });

        const { thinking: tagParsedThinking, cleanedResponse: responseWithoutThinking } = parseThinking(responseText);

        let combinedThinking = structuredReasoning || tagParsedThinking || null;
        if (structuredReasoning && tagParsedThinking) {
            combinedThinking = `${structuredReasoning}\n\n---\n\n${tagParsedThinking}`;
        }

        console.log('[ScratchPad] Raw prompt - Final thinking status:', {
            hasStructuredReasoning: !!structuredReasoning,
            hasTagParsedThinking: !!tagParsedThinking,
            hasCombinedThinking: !!combinedThinking,
            thinkingLength: combinedThinking ? combinedThinking.length : 0
        });

        // Check if generation was cancelled
        if (checkAndResetCancellation()) {
            console.log('[ScratchPad] Raw prompt generation was cancelled');
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

        console.log('[ScratchPad] Raw prompt - Updated message with thinking:', combinedThinking ? 'YES (' + combinedThinking.length + ' chars)' : 'NO');

        if (thread.messages.length <= 2) {
            updateThread(threadId, { name: generateFallbackTitle(userPrompt) });
        }

        await saveMetadata();

        return { success: true, response: responseWithoutThinking, thinking: combinedThinking };

    } catch (error) {
        // Check if this was a cancellation
        if (checkAndResetCancellation()) {
            console.log('[ScratchPad] Raw prompt generation was cancelled (caught)');
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
    const settings = getSettings();

    const parts = [];

    // OOC system instruction
    let systemPrompt = settings.oocSystemPrompt;

    // Add title instruction only for first message
    if (isFirstMessage) {
        systemPrompt += '\n\nAt the very beginning of your first response in this new conversation, provide a brief title (3-6 words) for this discussion on its own line, formatted as: **Title: [Your Title Here]**\n\nThen provide your response.';
    }

    parts.push(systemPrompt);

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
        prompt: parts.slice(1).join('\n\n') // Exclude system prompt from main prompt
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
        console.log('[ScratchPad] Cancelling generation:', activeGenerationId);
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
    console.log('[ScratchPad] generateScratchPadResponse called with:', {
        threadId,
        hasOnStream: !!onStream,
        questionLength: userQuestion.length
    });

    const context = SillyTavern.getContext();
    const { generateRaw, eventSource, event_types } = context;
    const settings = getSettings();

    console.log('[ScratchPad] Context retrieved:', {
        hasGenerateRaw: !!generateRaw,
        hasEventSource: !!eventSource,
        hasEventTypes: !!event_types
    });

    const thread = getThread(threadId);
    if (!thread) {
        return { success: false, error: 'Thread not found' };
    }

    // Add user message
    const userMessage = addMessage(threadId, 'user', userQuestion, 'complete');
    if (!userMessage) {
        return { success: false, error: 'Failed to add user message' };
    }

    // Add pending assistant message
    const assistantMessage = addMessage(threadId, 'assistant', '', 'pending');
    if (!assistantMessage) {
        return { success: false, error: 'Failed to add assistant message' };
    }

    await saveMetadata();

    try {
        const isFirstMessage = thread.messages.filter(m => m.role === 'assistant').length === 1;
        const { systemPrompt, prompt } = buildPrompt(userQuestion, thread, isFirstMessage);

        // Generation function
        const doGenerate = async () => {
            console.log('[ScratchPad] doGenerate started for regular scratchpad');
            let fullResponse = '';
            let structuredReasoning = ''; // Capture reasoning from STREAM_REASONING_DONE

            const useStreaming = onStream && eventSource && event_types?.STREAM_TOKEN_RECEIVED;
            console.log('[ScratchPad] Using streaming:', useStreaming);

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

                // Register event listeners
                console.log('[ScratchPad] Registering event listeners for scratchpad');
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamHandler);
                if (event_types?.STREAM_REASONING_DONE) {
                    console.log('[ScratchPad] Registering STREAM_REASONING_DONE handler for scratchpad');
                    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningHandler);
                } else {
                    console.log('[ScratchPad] STREAM_REASONING_DONE not available for scratchpad');
                }

                try {
                    // Generate - the response will come via events AND as final return
                    console.log('[ScratchPad] Calling generateRaw for scratchpad with systemPrompt:', systemPrompt.substring(0, 100) + '...');
                    const result = await generateRaw({
                        systemPrompt,
                        prompt
                    });
                    console.log('[ScratchPad] generateRaw completed for scratchpad');

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
        if (settings.useAlternativeApi && settings.connectionProfile) {
            result = await generateWithProfile(settings.connectionProfile, doGenerate);
        } else {
            result = await doGenerate();
        }

        // Extract text and structured reasoning from result
        const responseText = result.text || result; // Handle both new format and legacy string return
        const structuredReasoning = result.reasoning || '';

        // Parse thinking from response text (for models using XML tags like <think>)
        const { thinking: tagParsedThinking, cleanedResponse: responseWithoutThinking } = parseThinking(responseText);

        // Merge structured reasoning (Anthropic, Gemini, DeepSeek) with tag-parsed reasoning
        // Prefer structured reasoning if available, as it's the native format
        let combinedThinking = structuredReasoning || tagParsedThinking || null;
        if (structuredReasoning && tagParsedThinking) {
            // If we have both, combine them (unlikely but possible)
            combinedThinking = `${structuredReasoning}\n\n---\n\n${tagParsedThinking}`;
        }

        console.log('[ScratchPad] Final thinking status:', {
            hasStructuredReasoning: !!structuredReasoning,
            hasTagParsedThinking: !!tagParsedThinking,
            hasCombinedThinking: !!combinedThinking,
            thinkingLength: combinedThinking ? combinedThinking.length : 0
        });

        // Parse title if first message
        let finalResponse = responseWithoutThinking;
        if (isFirstMessage) {
            const { title, cleanedResponse } = parseThreadTitle(responseWithoutThinking);
            finalResponse = cleanedResponse;

            if (title) {
                updateThread(threadId, { name: title });
            } else {
                updateThread(threadId, { name: generateFallbackTitle(userQuestion) });
            }
        }

        // Check if generation was cancelled
        if (checkAndResetCancellation()) {
            console.log('[ScratchPad] Generation was cancelled');
            // Keep partial response if any, mark as cancelled
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

        console.log('[ScratchPad] Updated message with thinking:', combinedThinking ? 'YES (' + combinedThinking.length + ' chars)' : 'NO');

        await saveMetadata();

        return { success: true, response: finalResponse, thinking: combinedThinking };

    } catch (error) {
        // Check if this was a cancellation
        if (checkAndResetCancellation()) {
            console.log('[ScratchPad] Generation was cancelled (caught)');
            // Remove the pending message on cancel
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
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (thread.messages[i].role === 'user') {
            userQuestion = thread.messages[i].content;
            break;
        }
    }

    if (!userQuestion) {
        return { success: false, error: 'Could not find original question' };
    }

    // Remove the failed message
    thread.messages.splice(messageIndex, 1);

    // Also remove the user message so generateScratchPadResponse can re-add it
    const userMsgIndex = thread.messages.findIndex(m => m.content === userQuestion && m.role === 'user');
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
    return (chat && chat.length >= 0) && (characterId !== undefined || groupId !== undefined);
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
    const settings = getSettings();

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
        if (settings.useAlternativeApi && settings.connectionProfile) {
            response = await generateWithProfile(settings.connectionProfile, doGenerate);
        } else {
            response = await doGenerate();
        }

        // Clean up the response (remove quotes, extra whitespace, etc.)
        let title = response.trim();
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

