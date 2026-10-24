/**
 * TTS (Text-to-Speech) utilities for Scratch Pad extension
 * Uses SillyTavern's built-in /speak command
 */

import { getSettings } from './settings.js';
import { parseThinkingFromText } from './reasoning.js';

/**
 * Get the /speak command registered by SillyTavern's TTS extension
 * @returns {Object|null} Slash command object, or null if TTS isn't loaded
 */
function getSpeakCommand() {
    const command = SillyTavern.getContext().SlashCommandParser?.commands?.speak;
    return typeof command?.callback === 'function' ? command : null;
}

/**
 * Automatically speak a completed reply when opted in. Call without awaiting
 * so speech generation cannot delay the reply UI or the next queued question.
 * @param {string} text Completed assistant reply
 * @returns {Promise<boolean>} True if speech was requested successfully
 */
export async function autoSpeakText(text) {
    try {
        if (typeof text !== 'string' || !text.trim()) return false;
        const settings = getSettings();
        if (!settings.ttsAutoGenerate || !isTTSAvailable()) return false;
        return await speakText(text);
    } catch (error) {
        console.error('[ScratchPad TTS] Automatic speech failed:', error);
        return false;
    }
}

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
        const speakCommand = getSpeakCommand();
        if (!speakCommand) {
            console.error('[ScratchPad TTS] The /speak command is not available');
            return false;
        }

        // Clean the text for TTS - remove markdown and special characters
        const cleanedText = cleanTextForTTS(text);
        if (!cleanedText) {
            console.warn('[ScratchPad TTS] Text is empty after cleaning');
            return false;
        }

        // Call the /speak callback directly instead of running a command string:
        // the reply is model output, and the STscript parser would run any
        // pipes, closures or named arguments in it
        const voice = String(settings.ttsVoice ?? '').trim();
        await speakCommand.callback(voice ? { voice } : {}, cleanedText);

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

    let cleaned = parseThinkingFromText(text).cleanedResponse;

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

    // Remove macro braces: SillyTavern's TTS substitutes {{macros}} in the text
    cleaned = cleaned.replace(/\{\{|\}\}/g, '');

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

    return !!getSpeakCommand();
}
