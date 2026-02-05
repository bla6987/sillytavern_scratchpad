/**
 * TTS (Text-to-Speech) utilities for Scratch Pad extension
 * Uses SillyTavern's built-in /speak command
 */

import { getSettings } from './settings.js';

/**
 * Speak text using SillyTavern's TTS system
 * @param {string} text Text to speak
 * @returns {Promise<boolean>} True if successful
 */
export async function speakText(text) {
    if (!text || typeof text !== 'string') {
        console.warn('[ScratchPad TTS] No text provided');
        return false;
    }

    const settings = getSettings();
    if (!settings.ttsEnabled) {
        console.warn('[ScratchPad TTS] TTS is disabled');
        return false;
    }

    try {
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        if (!executeSlashCommandsWithOptions) {
            console.error('[ScratchPad TTS] executeSlashCommandsWithOptions not available');
            return false;
        }

        // Clean the text for TTS - remove markdown and special characters
        const cleanedText = cleanTextForTTS(text);
        if (!cleanedText) {
            console.warn('[ScratchPad TTS] Text is empty after cleaning');
            return false;
        }

        // Sanitize text to prevent command injection via pipe characters or leading slashes
        const safeText = cleanedText.replace(/\|/g, '').replace(/^\//gm, '');

        // Build the /speak command
        // Format: /speak voice="name" text
        // If no voice specified, just use /speak text
        let command;
        if (settings.ttsVoice && settings.ttsVoice.trim()) {
            const safeName = settings.ttsVoice.trim().replace(/"/g, '').replace(/\|/g, '');
            command = `/speak voice="${safeName}" ${safeText}`;
        } else {
            command = `/speak ${safeText}`;
        }

        const result = await executeSlashCommandsWithOptions(command, {
            handleParserErrors: false,
            handleExecutionErrors: false
        });

        if (result && result.isError) {
            console.error('[ScratchPad TTS] Command error:', result.errorMessage);
            return false;
        }

        return true;
    } catch (error) {
        console.error('[ScratchPad TTS] Error speaking text:', error);
        return false;
    }
}

/**
 * Clean text for TTS - remove markdown formatting and other non-speech elements
 * @param {string} text Raw text
 * @returns {string} Cleaned text suitable for TTS
 */
function cleanTextForTTS(text) {
    if (!text) return '';

    let cleaned = text;

    // Remove thinking/reasoning blocks
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Remove code blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    cleaned = cleaned.replace(/`[^`]+`/g, '');

    // Remove markdown links but keep text
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove markdown images
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

    // Remove markdown headers
    cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');

    // Remove markdown bold/italic
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

    // Remove markdown strikethrough
    cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');

    // Remove horizontal rules
    cleaned = cleaned.replace(/^[-*_]{3,}$/gm, '');

    // Remove blockquotes
    cleaned = cleaned.replace(/^>\s*/gm, '');

    // Remove list markers
    cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, '');
    cleaned = cleaned.replace(/^[\s]*\d+\.\s+/gm, '');

    // Remove HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');

    // Collapse multiple newlines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim whitespace
    cleaned = cleaned.trim();

    return cleaned;
}

/**
 * Check if TTS is available and enabled
 * @returns {boolean} True if TTS can be used
 */
export function isTTSAvailable() {
    const settings = getSettings();
    if (!settings.ttsEnabled) return false;

    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    return !!executeSlashCommandsWithOptions;
}
