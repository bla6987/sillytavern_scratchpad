/** Resolve the main chat's effective system instruction without changing it. */
export function resolveSystemPrompt(context, manager = null) {
    const power = context.powerUserSettings || {};
    const substitute = (text, original) => context.substituteParams?.(text, { original }) ?? text;
    const metadata = context.chatMetadata || context.chat_metadata || {};
    const character = context.characters?.[context.characterId];
    const override = typeof context.getCharacterCardFields === 'function'
        ? context.getCharacterCardFields().system || ''
        : power.prefer_character_prompt !== false
            ? metadata.system_prompt || character?.data?.system_prompt || '' : '';

    if (context.mainApi !== 'openai') {
        const system = power.sysprompt;
        if (system) return system.enabled ? substitute(override || system.content || '', system.content || '') : '';
        return ''; // A disabled/unconfigured text-completion system prompt stays absent.
    }

    const settings = context.chatCompletionSettings || {};
    let main;
    if (manager?.getPromptCollection) {
        main = manager.getPromptCollection('normal').get('main');
        if (!main || manager.isPromptDisabledForActiveCharacter('main')
            || (main.injection_trigger?.length && !main.injection_trigger.includes('normal'))) return '';
    } else {
        main = settings.prompts?.find(prompt => prompt.identifier === 'main');
        const orders = settings.prompt_order || [];
        const order = orders.find(item => String(item.character_id) === '100001')
            || orders.find(item => String(item.character_id) === String(context.groupId ?? context.characterId));
        const entry = order?.order?.find(item => item.identifier === 'main');
        if (main?.enabled === false || (order && !entry?.enabled)
            || (main?.injection_trigger?.length && !main.injection_trigger.includes('normal'))) return '';
        // Compatibility with old hosts exposing only a per-chat override.
        if (!main) return Array.isArray(settings.prompts) ? '' : substitute(override, '');
    }
    const original = main.content || '';
    if (override && main.forbid_overrides !== true) {
        return manager?.preparePrompt
            ? manager.preparePrompt({ ...main, content: override }, original).content
            : substitute(override, original);
    }
    return substitute(original, original);
}

let runtime;
export async function getStSystemPrompt(context = SillyTavern.getContext()) {
    let manager = context.promptManager;
    if (!manager && context.mainApi === 'openai' && Array.isArray(context.chatCompletionSettings?.prompts)) {
        runtime ||= import('../../../../openai.js').catch(() => null);
        manager = (await runtime)?.promptManager;
    }
    return resolveSystemPrompt(context, manager);
}
