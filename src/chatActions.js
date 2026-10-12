/**
 * Send Scratch Pad text into the main chat: the chat input or the Author's Note.
 */

/**
 * Add text after existing text, separated by a blank line
 * @param {string} current Existing text
 * @param {string} addition Text to add
 * @returns {string} Combined text
 */
export function appendBlock(current, addition) {
    const base = String(current || '').replace(/\s+$/, '');
    return base ? `${base}\n\n${addition}` : String(addition);
}

/**
 * Put text in SillyTavern's chat input, after anything already typed there
 * @param {string} text Text to insert
 * @returns {boolean} Whether the chat input was found
 */
export function insertIntoChatInput(text) {
    const input = document.getElementById('send_textarea');
    if (!input) return false;

    input.value = appendBlock(input.value, text);
    // SillyTavern resizes the input and saves its draft on input events
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
}

/**
 * Append text to the current chat's Author's Note
 * @param {string} text Text to add
 * @returns {Promise<void>}
 */
export async function appendToAuthorsNote(text) {
    const context = SillyTavern.getContext();
    const next = appendBlock(context.chatMetadata?.note_prompt, text);

    // Going through the Author's Note field keeps its panel, token counter and
    // injected prompt in sync; it saves the chat metadata itself
    const field = document.getElementById('extension_floating_prompt');
    if (field) {
        field.value = next;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }

    context.chatMetadata.note_prompt = next;
    await context.saveMetadata();
}
