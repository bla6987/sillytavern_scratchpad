/** Optional ST-owned modules. Read their current state on every diagnostic request. */
export async function readDebugRuntime() {
    const results = await Promise.allSettled([
        import('../../../../world-info.js').then(module => ({
            worldInfo: module.getWorldInfoSettings?.(),
            selectedWorldInfoCount: module.selected_world_info?.length,
        })),
        import('../../../../extensions.js').then(module => ({
            extensions: module.extensionNames?.map(id => ({ id, version: module.getExtensionManifest?.(id)?.version })),
        })),
        import('../../../regex/engine.js').then(module => ({ regexScripts: module.getRegexScripts?.() })),
    ]);
    // A missing module or a getter that fails on an older build only makes
    // that source unavailable; never prevent diagnostics of the other sources.
    return Object.assign({}, ...results.filter(result => result.status === 'fulfilled').map(result => result.value));
}
