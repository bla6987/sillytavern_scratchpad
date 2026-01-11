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
 * @param {number} limit Maximum messages to include
 * @returns {string} Formatted chat history
 */
function formatChatHistory(chat, limit) {
    if (!chat || chat.length === 0) return '';
    
    const messages = limit > 0 ? chat.slice(-limit) : chat;
    
    return messages.map(msg => {
        const role = msg.is_user ? 'User' : (msg.name || 'Character');
        return `${role}: ${msg.mes}`;
    }).join('\n\n');
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

/**
 * Build the complete prompt for scratch pad generation
 * @param {string} userQuestion User's question
 * @param {Object} thread Thread object
 * @returns {Object} { systemPrompt, prompt }
 */
function buildPrompt(userQuestion, thread) {
    const context = SillyTavern.getContext();
    const { chat, characters, characterId } = context;
    const settings = getSettings();
    
    const parts = [];
    
    // OOC system instruction
    parts.push(settings.oocSystemPrompt);
    
    // Character card (if enabled)
    if (settings.includeCharacterCard && characterId !== undefined && characters[characterId]) {
        const charContext = buildCharacterContext(characters[characterId]);
        if (charContext) {
            parts.push('--- CHARACTER INFORMATION ---');
            parts.push(charContext);
        }
    }
    
    // Chat history
    if (chat && chat.length > 0) {
        const historyLimit = settings.chatHistoryLimit || 0;
        const chatHistory = formatChatHistory(chat, historyLimit);
        if (chatHistory) {
            parts.push('--- ROLEPLAY CHAT HISTORY ---');
            parts.push(chatHistory);
        }
    }
    
    // Thread history (for continuity)
    if (thread && thread.messages && thread.messages.length > 0) {
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
        systemPrompt: settings.oocSystemPrompt,
        prompt: parts.slice(1).join('\n\n') // Exclude system prompt from main prompt
    };
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
    const { generateRaw } = context;
    const settings = getSettings();
    
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
        const { systemPrompt, prompt } = buildPrompt(userQuestion, thread);
        const isFirstMessage = thread.messages.filter(m => m.role === 'assistant').length === 1;
        
        // Generation function
        const doGenerate = async () => {
            let fullResponse = '';
            
            if (onStream) {
                // Streaming generation
                const streamingResult = await generateRaw({
                    systemPrompt,
                    prompt,
                    streaming: true,
                    signal: null
                });
                
                if (typeof streamingResult === 'string') {
                    fullResponse = streamingResult;
                    onStream(fullResponse, false);
                } else if (streamingResult && typeof streamingResult[Symbol.asyncIterator] === 'function') {
                    for await (const chunk of streamingResult) {
                        fullResponse += chunk;
                        onStream(fullResponse, false);
                    }
                } else {
                    fullResponse = String(streamingResult || '');
                    onStream(fullResponse, false);
                }
                
                onStream(fullResponse, true);
            } else {
                // Non-streaming generation
                fullResponse = await generateRaw({
                    systemPrompt,
                    prompt
                });
            }
            
            return fullResponse;
        };
        
        // Execute with profile switching if enabled
        let response;
        if (settings.useAlternativeApi && settings.connectionProfile) {
            response = await generateWithProfile(settings.connectionProfile, doGenerate);
        } else {
            response = await doGenerate();
        }
        
        // Parse title if first message
        let finalResponse = response;
        if (isFirstMessage) {
            const { title, cleanedResponse } = parseThreadTitle(response);
            finalResponse = cleanedResponse;
            
            if (title) {
                updateThread(threadId, { name: title });
            } else {
                updateThread(threadId, { name: generateFallbackTitle(userQuestion) });
            }
        }
        
        // Update assistant message
        updateMessage(threadId, assistantMessage.id, {
            content: finalResponse,
            status: 'complete'
        });
        
        await saveMetadata();
        
        return { success: true, response: finalResponse };
        
    } catch (error) {
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
