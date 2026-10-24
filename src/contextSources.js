/**
 * Roleplay context sources for Scratch Pad prompts: character cards (single
 * and group), the user's persona, World Info, the Summarize extension's
 * memory, and main-chat history formatting. Everything takes the SillyTavern
 * context (or plain data) as input so it can be unit-tested without a browser.
 */

/**
 * Format one character card for the prompt
 * @param {Object} char Character object
 * @returns {string} Formatted character context
 */
export function buildCharacterContext(char) {
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
 * Characters taking part in the current chat. In a group chat that is every
 * member that isn't muted; otherwise it is the selected character.
 * @param {Object} context SillyTavern context
 * @returns {Object[]} Character objects
 */
export function getChatCharacters(context) {
    const { characters, characterId, groupId, groups } = context || {};
    const characterList = Array.isArray(characters) ? characters : [];

    const hasGroup = groupId !== undefined && groupId !== null && groupId !== -1;
    if (hasGroup) {
        const group = Array.isArray(groups) ? groups.find(g => g?.id === groupId) : null;
        if (group && Array.isArray(group.members)) {
            const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
            return group.members
                .filter(avatar => !disabled.has(avatar))
                .map(avatar => characterList.find(c => c?.avatar === avatar))
                .filter(Boolean);
        }
    }

    if (characterId !== undefined && characterId !== null && characterList[characterId]) {
        return [characterList[characterId]];
    }

    return [];
}

/**
 * Character card text for every character in the chat
 * @param {Object} context SillyTavern context
 * @returns {string} Formatted cards, separated when there are several
 */
export function buildCharacterCardsContext(context) {
    return getChatCharacters(context)
        .map(buildCharacterContext)
        .filter(Boolean)
        .join('\n\n---\n\n');
}

/**
 * The name the user goes by in the current chat
 * @param {Object} context SillyTavern context
 * @returns {string} Persona name, or 'User'
 */
export function getUserName(context) {
    const name = typeof context?.name1 === 'string' ? context.name1.trim() : '';
    return name || 'User';
}

/**
 * The user's persona as prompt text
 * @param {Object} context SillyTavern context
 * @returns {string} Persona context, or empty string when there is no description
 */
export function buildPersonaContext(context) {
    const description = context?.powerUserSettings?.persona_description;
    if (typeof description !== 'string' || !description.trim()) return '';
    return `Name: ${getUserName(context)}\n\nDescription: ${description.trim()}`;
}

/**
 * Drop messages hidden from the AI (SillyTavern marks these is_system)
 * @param {Array} chat Chat messages
 * @returns {Array} Messages the main prompt would see
 */
export function filterHiddenMessages(chat) {
    return (chat || []).filter(message => message && !message.is_system);
}

/**
 * Format main-chat messages for the prompt, labelling each with the speaker
 * @param {Array} chat Chat messages
 * @param {string} [userName] Fallback name for user messages without one
 * @returns {string} Formatted chat history
 */
export function formatChatHistory(chat, userName = 'User') {
    if (!chat || chat.length === 0) return '';

    return chat.map((msg, index) => {
        const role = msg.is_user ? (msg.name || userName) : (msg.name || 'Character');
        return `[Message #${msg.scratchPadMessageNumber ?? index} | ${role}]\n${msg.mes}`;
    }).join('\n\n');
}

/**
 * Latest summary written by SillyTavern's Summarize extension. It stores the
 * running summary on the newest message it covered, as extra.memory.
 * @param {Array} chat Chat messages
 * @returns {string} Summary text, or empty string
 */
export function getLatestSummary(chat) {
    for (let i = (chat?.length || 0) - 1; i >= 0; i--) {
        const memory = chat[i]?.extra?.memory;
        if (typeof memory === 'string' && memory.trim()) {
            return memory.trim();
        }
    }
    return '';
}

/**
 * World Info entries the current context would activate. Runs SillyTavern's
 * scan as a dry run, so sticky/cooldown timers and activation events are not
 * touched. The user's question is scanned as the newest message, so asking
 * about something can pull in its lorebook entry.
 * @param {Object} context SillyTavern context
 * @param {Array} chatMessages Main-chat messages included in the prompt
 * @param {string} userQuestion Current question
 * @param {number|null} maxContext Context size for the World Info budget
 * @returns {Promise<string>} Activated entries, or empty string
 */
export async function buildWorldInfoContext(context, chatMessages, userQuestion, maxContext = null) {
    if (typeof context?.getWorldInfoPrompt !== 'function') return '';

    const userName = getUserName(context);
    const scanChat = (chatMessages || [])
        .map(msg => `${msg.is_user ? (msg.name || userName) : (msg.name || 'Character')}: ${msg.mes}`)
        .reverse();
    if (userQuestion) {
        scanChat.unshift(`${userName}: ${userQuestion}`);
    }

    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() || {};
    } catch {
        // Older builds or no character selected
    }

    const globalScanData = {
        personaDescription: fields.persona || '',
        characterDescription: fields.description || '',
        characterPersonality: fields.personality || '',
        characterDepthPrompt: fields.charDepthPrompt || '',
        scenario: fields.scenario || '',
        creatorNotes: fields.creatorNotes || '',
        trigger: 'normal',
    };

    const budget = Number(maxContext) > 0 ? Number(maxContext) : Number(context.maxContext) || 4096;
    const result = await context.getWorldInfoPrompt(scanChat, budget, true, globalScanData);
    if (!result) return '';

    const depthEntries = Array.isArray(result.worldInfoDepth)
        ? result.worldInfoDepth.flatMap(group => Array.isArray(group?.entries) ? group.entries : [])
        : [];
    const anEntries = [
        ...(Array.isArray(result.anBefore) ? result.anBefore : []),
        ...(Array.isArray(result.anAfter) ? result.anAfter : []),
    ];
    const exampleEntries = Array.isArray(result.worldInfoExamples)
        ? result.worldInfoExamples.map(entry => entry?.content)
        : [];

    return [result.worldInfoBefore, result.worldInfoAfter, ...depthEntries, ...anEntries, ...exampleEntries]
        .map(text => typeof text === 'string' ? text.trim() : '')
        .filter(Boolean)
        .join('\n\n');
}
