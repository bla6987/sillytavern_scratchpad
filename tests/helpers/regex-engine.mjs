import { registerHooks } from 'node:module';

// Replace only the browser-owned dependency. Production still imports ST's
// actual engine; tests can assert its placement/options and control its result.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '../../../regex/engine.js'
            && context.parentURL === new URL('../../src/promptRegex.js', import.meta.url).href) {
            return { url: import.meta.url, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

export const regex_placement = { USER_INPUT: 1, AI_OUTPUT: 2 };

export const regexMock = {
    calls: [],
    process: text => text,
    reset(process = text => text) {
        this.calls = [];
        this.process = process;
    },
};

export function getRegexedString(text, placement, options) {
    regexMock.calls.push({ text, placement, options });
    return regexMock.process(text, placement, options);
}
