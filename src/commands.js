/**
 * Commands module for Scratch Pad extension
 * Handles slash command registration
 */

import { clearAllThreads, findThreadByName, saveMetadata } from './storage.js';
import { openScratchPad, openThread, showQuickPopup, showQuickPopupRaw, closeScratchPad } from './ui/index.js';
import { isChatActive } from './generation.js';

/**
 * Register all slash commands for the extension
 */
export function registerCommands() {
    const context = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.error('[ScratchPad] SlashCommandParser not available');
        return;
    }

    // /scratchpad or /sp [message]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad',
        callback: async (namedArgs, unnamedArgs) => {
            console.log('[ScratchPad CMD] /scratchpad called');
            console.log('[ScratchPad CMD] Named args:', namedArgs);
            console.log('[ScratchPad CMD] Unnamed args:', unnamedArgs);

            if (!isChatActive()) {
                console.log('[ScratchPad CMD] No active chat');
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';
            console.log('[ScratchPad CMD] Parsed message:', message);

            if (message) {
                // Create new thread and show popup with response
                console.log('[ScratchPad CMD] Showing quick popup with message');
                await showQuickPopup(message);
            } else {
                // Open scratch pad UI
                console.log('[ScratchPad CMD] Opening scratch pad UI');
                openScratchPad();
            }

            console.log('[ScratchPad CMD] Command completed');
            return '';
        },
        aliases: ['sp', 'ooc'],
        returns: 'nothing',
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
                </ul>
            </div>
        `
    }));

    // /rawprompt or /rp [message]
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rawprompt',
        callback: async (namedArgs, unnamedArgs) => {
            console.log('[ScratchPad CMD] /rawprompt called');

            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            const message = unnamedArgs ? unnamedArgs.toString().trim() : '';
            if (!message) {
                toastr.warning('Please provide a prompt');
                return '';
            }

            await showQuickPopupRaw(message);
            return '';
        },
        aliases: ['rp'],
        returns: 'nothing',
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
                </ul>
            </div>
        `
    }));

    // /scratchpad-view or /sp-view
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scratchpad-view',
        callback: async () => {
            console.log('[ScratchPad CMD] /scratchpad-view called');

            if (!isChatActive()) {
                console.log('[ScratchPad CMD] No active chat');
                toastr.warning('Open a chat to use Scratch Pad');
                return '';
            }

            console.log('[ScratchPad CMD] Opening scratch pad UI');
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

                // Refresh UI if open
                const drawer = document.getElementById('scratch-pad-drawer');
                if (drawer && drawer.classList.contains('open')) {
                    closeScratchPad();
                    openScratchPad();
                }
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
            const { getThread } = await import('./storage.js');
            let thread = getThread(searchTerm);

            if (!thread) {
                thread = findThreadByName(searchTerm);
            }

            if (thread) {
                openScratchPad();
                setTimeout(() => openThread(thread.id), 100);
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
