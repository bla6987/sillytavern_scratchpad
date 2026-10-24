/**
 * Commands module for Scratch Pad extension
 * Handles slash command registration
 */

import { clearAllThreads, createThread, findThreadByName, getThread, saveMetadata } from './storage.js';
import { openScratchPad, showQuickPopup, showQuickPopupRaw, showQuickPopupAsk, showQuickPopupDebug, refreshScratchPadUI } from './ui/index.js';
import { askQuietly } from './ui/popup.js';
import { isChatActive } from './generation.js';
import { THREAD_MODE } from './threadModes.js';
import { getCurrentContextSettings } from './settings.js';

/**
 * Whether a slash command's quiet=true argument was given
 * @param {Object} namedArgs Named arguments
 * @returns {boolean} True for quiet mode
 */
function isQuiet(namedArgs) {
    return String(namedArgs?.quiet ?? '').trim().toLowerCase() === 'true';
}

/**
 * Register all slash commands for the extension
 */
export function registerCommands() {
    const context = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.error('[ScratchPad] SlashCommandParser not available');
        return;
    }

    const quietArgument = () => SlashCommandNamedArgument.fromProps({
        name: 'quiet',
        description: 'Skip the popup and only return the reply (it is still saved as a thread)',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue: 'false',
        enumList: ['true', 'false'],
    });

    // /scratchpad or /sp [message]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad',
        callback: async (namedArgs, unnamedArgs) => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';

            if (!message) {
                openScratchPad();
                return '';
            }

            // Create a new thread and return the reply, showing it in the popup unless quiet
            return isQuiet(namedArgs)
                ? await askQuietly(message, 'scratchpad')
                : await showQuickPopup(message);
        },
        aliases: ['sp', 'ooc'],
        returns: 'the reply, when a message is given',
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Optional message to start a new thread with',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false
            })
        ],
        helpString: `
            <div>
                Opens the Scratch Pad for out-of-character meta-conversations about your roleplay.
            </div>
            <div>
                <strong>Usage:</strong>
                <ul>
                    <li><code>/sp</code> - Open the scratch pad interface</li>
                    <li><code>/sp What is the character's motivation?</code> - Quick question with popup response</li>
                    <li><code>/sp quiet=true Summarize the scene | /setvar key=summary</code> - Get the reply without the popup, for scripts</li>
                </ul>
            </div>
            <div>
                Returns the reply text, so it can be piped into other commands.
            </div>
        `
    }));

    // Deliberate entry point: never a toggle on a story thread.
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-debug',
        callback: async (namedArgs, unnamedArgs) => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad troubleshooting');
                return '';
            }
            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';
            if (!message) {
                const thread = createThread('Troubleshooting', getCurrentContextSettings(), THREAD_MODE.DEBUG);
                if (!thread) return '';
                await saveMetadata();
                openScratchPad(thread.id);
                return '';
            }
            return isQuiet(namedArgs)
                ? await askQuietly(message, 'debug')
                : await showQuickPopupDebug(message);
        },
        returns: 'the troubleshooting reply, when a question is given',
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'Optional configuration/context troubleshooting question; opens a dedicated thread when omitted',
            typeList: [ARGUMENT_TYPE.STRING], isRequired: false,
        })],
        helpString: `<div>Starts a separate, permanently labeled Troubleshooting thread. Each question sends a fresh, filtered configuration snapshot and this diagnostic conversation. Main-chat history, character/persona text, prompt contents, credentials, and URLs are excluded. Settings are never changed automatically.</div>
            <ul><li><code>/sp-debug</code> — Open a new troubleshooting thread; preview its prompt before sending.</li>
            <li><code>/sp-debug Why are replies cut short?</code> — Ask with a popup.</li>
            <li><code>/sp-debug quiet=true Check my context limits</code> — Return the reply without a popup.</li></ul>`,
    }));

    // /sp-ask [message]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-ask',
        callback: async (namedArgs, unnamedArgs) => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';
            if (!message) {
                toastr.warning('Please provide a question');
                return '';
            }

            return isQuiet(namedArgs)
                ? await askQuietly(message, 'ask')
                : await showQuickPopupAsk(message);
        },
        aliases: [],
        returns: 'the reply',
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Question to ask the model without chat, character, or Scratch Pad context',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })
        ],
        helpString: `
            <div>
                Asks a general AI question with <strong>no chat history</strong>, character card, author note, or Scratch Pad thread context.
            </div>
            <div>
                <strong>Usage:</strong>
                <ul>
                    <li><code>/sp-ask Explain the P vs NP problem</code></li>
                    <li><code>/sp-ask Give me 10 creative writing prompts</code></li>
                    <li><code>/sp-ask quiet=true Name a random color | /echo</code> - No popup, for scripts</li>
                </ul>
            </div>
            <div>
                Returns the reply text, so it can be piped into other commands.
            </div>
        `
    }));

    // /rawprompt or /rp [message]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rawprompt',
        callback: async (namedArgs, unnamedArgs) => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';
            if (!message) {
                toastr.warning('Please provide a prompt');
                return '';
            }

            return isQuiet(namedArgs)
                ? await askQuietly(message, 'raw')
                : await showQuickPopupRaw(message);
        },
        aliases: ['rp'],
        returns: 'the reply',
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Prompt to send directly to the model (no system prompt, no chat context)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })
        ],
        helpString: `
            <div>
                Sends a raw prompt directly to the model with <strong>no system prompt</strong> and <strong>no injected chat/character/thread context</strong>.
            </div>
            <div>
                <strong>Usage:</strong>
                <ul>
                    <li><code>/rawprompt Explain the P vs NP problem</code></li>
                    <li><code>/rp Give me 10 creative writing prompts</code></li>
                    <li><code>/rp quiet=true Say hi | /echo</code> - No popup, for scripts</li>
                </ul>
            </div>
            <div>
                Returns the reply text, so it can be piped into other commands.
            </div>
        `
    }));

    // /scratchpad-view or /sp-view
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad-view',
        callback: async () => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            openScratchPad();
            return '';
        },
        aliases: ['sp-view'],
        returns: 'nothing',
        helpString: `
            <div>
                Opens the Scratch Pad interface showing all threads.
            </div>
        `
    }));

    // /scratchpad-clear or /sp-clear
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad-clear',
        callback: async () => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const confirmed = await callGenericPopup(
                'Are you sure you want to delete all scratch pad threads? This cannot be undone.',
                POPUP_TYPE.CONFIRM,
                null,
                { okButton: 'Yes, Delete All', cancelButton: 'Cancel' }
            );

            if (confirmed) {
                clearAllThreads();
                await saveMetadata();
                toastr.success('All scratch pad threads have been deleted');

                // Refresh UI if open, in any display mode
                refreshScratchPadUI();
            }

            return '';
        },
        aliases: ['sp-clear'],
        returns: 'nothing',
        helpString: `
            <div>
                Clears all Scratch Pad threads for the current chat (with confirmation).
            </div>
        `
    }));

    // /scratchpad-thread or /sp-thread [thread_id or name]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad-thread',
        callback: async (namedArgs, unnamedArgs) => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const searchTerm = unnamedArgs ? unnamedArgs.toString().trim() : '';

            if (!searchTerm) {
                toastr.warning('Please provide a thread ID or name');
                return '';
            }

            // Try to find thread by ID first, then by name
            const thread = getThread(searchTerm) || findThreadByName(searchTerm);

            if (thread) {
                openScratchPad(thread.id);
            } else {
                toastr.warning(`Thread "${searchTerm}" not found`);
            }

            return '';
        },
        aliases: ['sp-thread'],
        returns: 'nothing',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Thread ID or name to open',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })
        ],
        helpString: `
            <div>
                Opens a specific Scratch Pad thread by ID or name (fuzzy match).
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li><code>/sp-thread Character Analysis</code></li>
                </ul>
            </div>
        `
    }));
}

// Make popup functions available
let callGenericPopup, POPUP_TYPE;

/**
 * Initialize popup functions from context
 */
export function initPopupFunctions() {
    const context = SillyTavern.getContext();
    callGenericPopup = context.callGenericPopup;
    POPUP_TYPE = context.POPUP_TYPE;
}
