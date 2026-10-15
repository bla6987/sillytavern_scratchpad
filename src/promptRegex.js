/**
 * Use SillyTavern's prompt regex engine with depths from the full main chat,
 * before Scratch Pad applies history ranges, limits, or token trimming.
 * The returned processor never changes stored messages or swipes.
 * @param {Array} chat Main chat
 * @param {boolean} [canUseTools] Whether ST includes hidden tool messages
 * @returns {Promise<(text: string, message: Object) => string>}
 */
export async function createPromptRegexProcessor(chat, canUseTools = false) {
    if (!chat?.length) return text => text;

    // src/ lives under extensions/third-party/sillytavern_scratchpad/.
    // Let load/processing errors stop the request rather than send raw text.
    const { getRegexedString, regex_placement } = await import('../../../regex/engine.js');
    const depths = new Map();
    let depth = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message) continue;
        depths.set(message, depth);
        if (!message.is_system || (canUseTools && Array.isArray(message.extra?.tool_invocations))) {
            depth++;
        }
    }

    const cache = new Map();
    return (text, message) => {
        const rawText = typeof text === 'string' ? text : '';
        if (!cache.has(message)) cache.set(message, new Map());
        const variants = cache.get(message);
        if (!variants.has(rawText)) {
            const placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
            variants.set(rawText, getRegexedString(rawText, placement, {
                isPrompt: true,
                depth: depths.get(message),
            }));
        }
        return variants.get(rawText);
    };
}
