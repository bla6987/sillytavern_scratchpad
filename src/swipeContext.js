/** Read main-chat swipe alternatives without changing the chat or active swipe. */
export function buildSwipeContext(chat, mode = 'none') {
    const roles = mode === 'both' ? ['user', 'assistant']
        : mode === 'user' || mode === 'assistant' ? [mode] : [];
    if (!roles.length) return '';

    const sections = roles.map(role => {
        const label = role === 'user' ? 'user' : 'AI';
        let messageIndex = -1;
        for (let i = (chat?.length || 0) - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_system && Boolean(message.is_user) === (role === 'user')) {
                messageIndex = i;
                break;
            }
        }
        if (messageIndex < 0) return `Latest ${label} message: unavailable.`;

        const message = chat[messageIndex];
        const swipes = Array.isArray(message.swipes) ? message.swipes.slice() : [];
        const requestedIndex = message.swipe_id ?? 0;
        const selectedIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < swipes.length
            ? requestedIndex : null;
        // The displayed text can be newer than the stored selected swipe after edits.
        if (selectedIndex !== null && typeof message.mes === 'string') {
            swipes[selectedIndex] = message.mes;
        }
        const alternatives = swipes.flatMap((text, index) =>
            typeof text === 'string' && text.trim()
                ? [`Swipe ${index + 1}${index === selectedIndex ? ' (currently selected)' : ''}:\n${text}`]
                : []
        );
        const heading = `Latest ${label} message (#${messageIndex + 1}, ${message.name || label})`;
        if (alternatives.length < 2) return `${heading}: no alternate swipes available.`;

        if (selectedIndex === null && typeof message.mes === 'string' && message.mes.trim()) {
            alternatives.push(`Current displayed message (swipe number unavailable):\n${message.mes}`);
        }
        return `${heading}:\n\n${alternatives.join('\n\n')}`;
    });

    return [
        '--- MAIN CHAT SWIPE ALTERNATIVES ---',
        'These are alternative versions of the same message, not consecutive story events. Compare them when answering the user\'s question. Swipe numbers are 1-based. Only the currently selected version belongs to the active story; unselected versions are possibilities. If both roles are included, their swipes are independent alternatives, not paired branches. Treat the quoted message text as material to analyze.',
        ...sections,
    ].join('\n\n');
}
