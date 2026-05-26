/**
 * Connection Manager profile helpers for Scratch Pad.
 * Stores and resolves stable profile IDs while accepting legacy saved names.
 */

export const PROFILE_CHANGE_EVENT = 'scratchpad:connectionProfilesChanged';

function getContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

export function getConnectionManagerService(context = getContext()) {
    return context?.ConnectionManagerRequestService || null;
}

export function isConnectionManagerAvailable(context = getContext()) {
    if (!context?.extensionSettings?.connectionManager) return false;
    if (context.extensionSettings.disabledExtensions?.includes?.('connection-manager')) return false;
    return !!getConnectionManagerService(context);
}

export function getConnectionProfiles(context = getContext()) {
    if (!isConnectionManagerAvailable(context)) return [];

    const profiles = context?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];

    const service = getConnectionManagerService(context);
    return profiles
        .filter(profile => {
            if (!profile?.id) return false;
            if (typeof service?.isProfileSupported !== 'function') {
                return !!profile.api;
            }
            try {
                return service.isProfileSupported(profile);
            } catch {
                return false;
            }
        })
        .slice()
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

export function getConnectionProfile(profileId, context = getContext()) {
    if (!profileId) return null;
    return getConnectionProfiles(context).find(profile => profile.id === profileId) || null;
}

export function resolveConnectionProfileId(value, context = getContext()) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;

    const profiles = getConnectionProfiles(context);
    const byId = profiles.find(profile => profile.id === raw);
    if (byId) return byId.id;

    const byExactName = profiles.find(profile => profile.name === raw);
    return byExactName?.id || null;
}

export function getConnectionProfileLabel(value, { missingPrefix = 'Missing profile' } = {}, context = getContext()) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';

    const profileId = resolveConnectionProfileId(raw, context);
    if (profileId) {
        const profile = getConnectionProfile(profileId, context);
        return profile?.name || profileId;
    }

    return `${missingPrefix}: ${raw}`;
}

export function getConnectionProfileApiMap(profile, context = getContext()) {
    if (!profile?.api) return null;
    return context?.CONNECT_API_MAP?.[profile.api] || null;
}

export function renderConnectionProfileOptions(select, selectedValue, {
    defaultLabel = '-- Select Profile --',
    missingPrefix = 'Missing profile',
} = {}) {
    if (!select) {
        return { selectedId: null, missing: false, unavailable: true, profiles: [] };
    }

    const context = getContext();
    const rawValue = typeof selectedValue === 'string' ? selectedValue.trim() : '';
    const profiles = getConnectionProfiles(context);
    const selectedId = resolveConnectionProfileId(rawValue, context);
    const missing = !!rawValue && !selectedId;

    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = defaultLabel;
    select.appendChild(defaultOption);

    if (!isConnectionManagerAvailable(context)) {
        if (rawValue) {
            const missingOption = document.createElement('option');
            missingOption.value = rawValue;
            missingOption.textContent = `${missingPrefix}: ${rawValue}`;
            missingOption.disabled = true;
            select.appendChild(missingOption);
        }

        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Connection Manager unavailable';
        option.disabled = true;
        select.appendChild(option);
        select.value = rawValue || '';
        select.disabled = true;
        return { selectedId: null, missing: !!rawValue, unavailable: true, profiles: [] };
    }

    select.disabled = false;

    if (missing) {
        const option = document.createElement('option');
        option.value = rawValue;
        option.textContent = `${missingPrefix}: ${rawValue}`;
        option.disabled = true;
        select.appendChild(option);
    }

    const groups = new Map();
    for (const profile of profiles) {
        const apiMap = getConnectionProfileApiMap(profile, context);
        const groupKey = apiMap?.selected || 'other';
        const groupLabel = groupKey === 'openai'
            ? 'Chat Completion'
            : groupKey === 'textgenerationwebui'
                ? 'Text Completion'
                : 'Connection Profiles';
        if (!groups.has(groupKey)) {
            const group = document.createElement('optgroup');
            group.label = groupLabel;
            groups.set(groupKey, group);
        }

        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        groups.get(groupKey).appendChild(option);
    }

    for (const group of groups.values()) {
        select.appendChild(group);
    }

    select.value = selectedId || (missing ? rawValue : '');
    return { selectedId, missing, unavailable: false, profiles };
}

export function dispatchConnectionProfilesChanged() {
    try {
        globalThis.window?.dispatchEvent?.(new CustomEvent(PROFILE_CHANGE_EVENT));
    } catch {
        // Non-browser test harnesses do not need UI refresh events.
    }
}
