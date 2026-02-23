/**
 * Author's Note helpers for Scratch Pad context handling.
 */

export const AUTHORS_NOTE_PROMPT_KEY = '2_floating_prompt';

/**
 * Append Author's Note to structured message array when enabled.
 * @param {Array<{role: string, content: string}>} messages
 * @param {boolean} includeAuthorsNote
 * @param {string} authorsNote
 */
export function appendAuthorsNoteToMessages(messages, includeAuthorsNote, authorsNote) {
    if (!includeAuthorsNote || !authorsNote) return;
    messages.push({ role: 'system', content: `Author's Note: ${authorsNote}` });
}

/**
 * Append Author's Note section to concatenated prompt parts when enabled.
 * @param {string[]} parts
 * @param {boolean} includeAuthorsNote
 * @param {string} authorsNote
 */
export function appendAuthorsNoteToPromptParts(parts, includeAuthorsNote, authorsNote) {
    if (!includeAuthorsNote || !authorsNote) return;
    parts.push("--- AUTHOR'S NOTE ---");
    parts.push(authorsNote);
}

/**
 * Suppress ST Author's Note extension prompt for a single generation pass.
 * Returns a restore function that puts the original prompt back (if it existed).
 *
 * @param {Object} context SillyTavern context
 * @param {boolean} includeAuthorsNote Whether AN should remain enabled
 * @param {Object} logger Logger with warn()
 * @returns {() => void} Restore callback
 */
export function suppressAuthorsNoteForGeneration(context, includeAuthorsNote, logger = console) {
    if (includeAuthorsNote) {
        return () => {};
    }

    const currentPrompt = context.extensionPrompts?.[AUTHORS_NOTE_PROMPT_KEY];
    if (!currentPrompt) {
        logger?.warn?.('[ScratchPad] includeAuthorsNote=false but no Author\'s Note extension prompt was found.');
        return () => {};
    }

    const savedPrompt = { ...currentPrompt };
    context.setExtensionPrompt(
        AUTHORS_NOTE_PROMPT_KEY,
        '',
        savedPrompt.position ?? 1,
        savedPrompt.depth ?? 0,
        savedPrompt.scan ?? false,
        savedPrompt.role ?? 0,
    );

    return () => {
        context.setExtensionPrompt(
            AUTHORS_NOTE_PROMPT_KEY,
            savedPrompt.value ?? '',
            savedPrompt.position ?? 1,
            savedPrompt.depth ?? 0,
            savedPrompt.scan ?? false,
            savedPrompt.role ?? 0,
        );
    };
}
