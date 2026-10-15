/**
 * Shared UI components for Scratch Pad extension
 */

import { getSettings } from '../settings.js';

// Lazy-initialized to avoid errors if SillyTavern isn't ready at module load time
let _converter = null;
let _DOMPurify = null;

function getConverter() {
    if (!_converter) {
        const { showdown } = SillyTavern.libs;
        _converter = new showdown.Converter({
            tables: true,
            strikethrough: true,
            simpleLineBreaks: true,
            openLinksInNewWindow: true
        });
    }
    return _converter;
}

function getDOMPurify() {
    if (!_DOMPurify) {
        _DOMPurify = SillyTavern.libs.DOMPurify;
    }
    return _DOMPurify;
}

// Replies are model output: drop page-wide styles, form controls and IDs that
// could restyle or clobber SillyTavern's UI. MESSAGE_SANITIZE enables
// SillyTavern's own hooks, which prefix classes with "custom-" and block
// external media unless the user allows it.
const MARKDOWN_SANITIZE_CONFIG = Object.freeze({
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'id'],
    MESSAGE_SANITIZE: true,
});

/**
 * Sanitize and render markdown to HTML
 * @param {string} text Markdown text
 * @returns {string} Sanitized HTML
 */
export function renderMarkdown(text) {
    if (!text) return '';
    const html = getConverter().makeHtml(text);
    return getDOMPurify().sanitize(html, { ...MARKDOWN_SANITIZE_CONFIG });
}

/**
 * Copy text to the system clipboard.
 * Falls back to document.execCommand when the Clipboard API is unavailable or denied.
 * @param {string} text Text to copy
 * @returns {Promise<void>}
 */
export async function copyTextToClipboard(text) {
    const value = String(text ?? '');
    let clipboardError = null;

    if (globalThis.isSecureContext && globalThis.navigator?.clipboard?.writeText) {
        try {
            await globalThis.navigator.clipboard.writeText(value);
            return;
        } catch (error) {
            clipboardError = error;
        }
    }

    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
        throw clipboardError || new Error('Clipboard copy is not available');
    }

    const parent = document.querySelector('dialog[open]:last-of-type') ?? document.body;
    if (!parent) {
        throw clipboardError || new Error('Clipboard copy target is not available');
    }

    const activeElement = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.top = '-1000px';
    textArea.style.left = '-1000px';
    textArea.style.opacity = '0';

    try {
        parent.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, value.length);

        if (!document.execCommand('copy')) {
            throw clipboardError || new Error('Clipboard copy command failed');
        }
    } finally {
        textArea.remove();
        try {
            activeElement?.focus?.({ preventScroll: true });
        } catch {
            // Best effort only; focus restoration should not fail the copy.
        }
    }
}

/**
 * Create a throttled streaming renderer for live AI responses.
 *
 * During streaming the response is written as plain text — no markdown parsing
 * and no sanitization — appending only the newly-arrived delta whenever the
 * text grows as a pure extension. Updates are coalesced with
 * requestAnimationFrame so the main thread never blocks re-parsing the whole
 * buffer on every chunk (the previous approach was O(n²) over the response and
 * froze the tab on long replies). Call schedule() on each streamed chunk, then
 * render the final markdown once, separately, when the response completes.
 *
 * @param {() => (HTMLElement|null)} getElement Returns the live target element;
 *        it may be re-created or detached between chunks.
 * @param {() => string} getText Returns the current cleaned text to display.
 *        Invoked at most once per frame, so any per-call work (e.g. stripping
 *        reasoning tags) stays off the per-chunk hot path.
 * @param {(el: HTMLElement) => void} [onAfterRender] Optional callback run after
 *        each plain-text update (e.g. to scroll).
 * @returns {{ schedule: () => void, cancel: () => void }}
 */
export function createStreamingRenderer(getElement, getText, onAfterRender) {
    let rafId = null;
    let lastText = '';
    let textNode = null;

    const flush = () => {
        rafId = null;
        const el = getElement();
        if (!el || !el.isConnected) return;
        const text = getText();
        if (textNode && textNode.parentNode === el && text.startsWith(lastText)) {
            if (text.length > lastText.length) {
                textNode.appendData(text.slice(lastText.length));
            }
        } else {
            el.textContent = text;
            textNode = el.firstChild;
        }
        lastText = text;
        if (onAfterRender) onAfterRender(el);
    };

    return {
        schedule() {
            if (rafId === null) rafId = requestAnimationFrame(flush);
        },
        cancel() {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        },
    };
}

/**
 * Format a timestamp for display
 * @param {string} isoTimestamp ISO timestamp string
 * @returns {string} Formatted time string
 */
export function formatTimestamp(isoTimestamp) {
    const { moment } = SillyTavern.libs;
    if (moment) {
        return moment(isoTimestamp).fromNow();
    }

    const date = new Date(isoTimestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
}

/**
 * Truncate text to a maximum length
 * @param {string} text Text to truncate
 * @param {number} maxLength Maximum length
 * @returns {string} Truncated text
 */
export function truncateText(text, maxLength = 50) {
    if (!text || text.length <= maxLength) return text || '';
    return text.substring(0, maxLength) + '...';
}

/**
 * Create a button element
 * @param {Object} options Button options
 * @returns {HTMLButtonElement} Button element
 */
export function createButton({ text, icon, className, onClick, ariaLabel, disabled = false }) {
    const button = document.createElement('button');
    button.type = 'button'; // Prevent default submit behavior
    button.className = `sp-button ${className || ''}`.trim();
    button.disabled = disabled;

    if (ariaLabel) {
        button.setAttribute('aria-label', ariaLabel);
    }

    if (icon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'sp-button-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.innerHTML = icon;
        button.appendChild(iconSpan);
    }

    if (text) {
        const textSpan = document.createElement('span');
        textSpan.className = 'sp-button-text';
        textSpan.textContent = text;
        button.appendChild(textSpan);
    }

    if (onClick) {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                const result = onClick(e);
                // Handle async functions - log errors instead of swallowing them
                if (result instanceof Promise) {
                    result.catch(err => {
                        console.error('[ScratchPad] Button click error:', err);
                        if (typeof toastr !== 'undefined') {
                            toastr.error(`Error: ${err.message}`);
                        }
                    });
                }
            } catch (err) {
                console.error('[ScratchPad] Button click error:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error(`Error: ${err.message}`);
                }
            }
        });
    }

    return button;
}

/**
 * Create a text input element
 * @param {Object} options Input options
 * @returns {HTMLInputElement|HTMLTextAreaElement} Input element
 */
export function createInput({ type = 'text', placeholder, value, className, onInput, onKeyDown, multiline = false }) {
    const input = document.createElement(multiline ? 'textarea' : 'input');

    if (!multiline) {
        input.type = type;
    }

    input.className = `sp-input ${className || ''}`.trim();
    input.placeholder = placeholder || '';
    input.value = value || '';

    if (onInput) {
        input.addEventListener('input', onInput);
    }

    if (onKeyDown) {
        input.addEventListener('keydown', onKeyDown);
    }

    return input;
}

/**
 * Create a confirmation dialog
 * @param {string} message Confirmation message
 * @param {Object} options Dialog options
 * @returns {Promise<boolean>} User's choice
 */
export async function showConfirmDialog(message, options = {}) {
    const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();

    if (callGenericPopup && POPUP_TYPE) {
        return await callGenericPopup(
            message,
            POPUP_TYPE.CONFIRM,
            null,
            {
                okButton: options.confirmText || 'Yes',
                cancelButton: options.cancelText || 'Cancel'
            }
        );
    }

    // Fallback to native confirm
    return confirm(message);
}

/**
 * Create a prompt dialog for text input
 * @param {string} message Prompt message
 * @param {string} defaultValue Default input value
 * @returns {Promise<string|null>} User input or null
 */
export async function showPromptDialog(message, defaultValue = '') {
    const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();

    if (callGenericPopup && POPUP_TYPE) {
        return await callGenericPopup(
            message,
            POPUP_TYPE.INPUT,
            defaultValue
        );
    }

    // Fallback to native prompt
    return prompt(message, defaultValue);
}

/**
 * Show a toast notification
 * @param {string} message Message to display
 * @param {string} type 'success', 'error', 'warning', 'info'
 */
export function showToast(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type](message);
    } else {
        console.log(`[ScratchPad] ${type}: ${message}`);
    }
}

/**
 * Debounce a function
 * @param {Function} fn Function to debounce
 * @param {number} delay Delay in ms
 * @returns {Function} Debounced function
 */
export function debounce(fn, delay = 300) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * Create the loading spinner element
 * @returns {HTMLElement} Spinner element
 */
export function createSpinner() {
    const spinner = document.createElement('div');
    spinner.className = 'sp-spinner';
    spinner.innerHTML = `
        <div class="sp-spinner-dot"></div>
        <div class="sp-spinner-dot"></div>
        <div class="sp-spinner-dot"></div>
    `;
    return spinner;
}

/**
 * Play a notification sound when generation completes (if enabled)
 */
export function playCompletionSound() {
    if (!getSettings().soundOnComplete) return;
    const audio = document.getElementById('audio_message_sound');
    if (audio instanceof HTMLAudioElement) {
        audio.volume = 0.8;
        audio.pause();
        audio.currentTime = 0;
        audio.play();
    }
}

/**
 * Format a token count compactly: 950, 12.3k, 128k
 * @param {number} value Token count
 * @returns {string} Formatted count
 */
export function formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n < 1000) return String(Math.round(n));
    const thousands = n / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Describe how much context a prompt used and what was trimmed to fit
 * @param {Object|null} stats Prompt stats from generation
 * @returns {{summary: string, detail: string, trimmed: number}|null} Display text, or null without stats
 */
export function formatPromptStats(stats) {
    if (!stats || !Number.isFinite(Number(stats.promptTokens))) return null;

    const tokens = Number(stats.promptTokens);
    const budget = Number(stats.tokenBudget) > 0 ? Number(stats.tokenBudget) : null;
    const chatTrimmed = Math.max(0, Number(stats.chatMessagesTrimmed) || 0);
    const threadTrimmed = Math.max(0, Number(stats.threadMessagesTrimmed) || 0);
    const trimmed = chatTrimmed + threadTrimmed;

    let summary = `Context: ${formatTokenCount(tokens)}${budget ? ` / ${formatTokenCount(budget)}` : ''} tokens`;
    if (trimmed > 0) {
        summary += ` · trimmed ${trimmed} older message${trimmed === 1 ? '' : 's'}`;
    }

    const detail = [
        `Prompt: ${tokens.toLocaleString()}${budget ? ` of ${budget.toLocaleString()}` : ''} tokens`,
        `Main chat messages sent: ${Number(stats.chatMessages) || 0}`,
    ];
    if (trimmed > 0) {
        const trimmedParts = [];
        if (chatTrimmed) trimmedParts.push(`${chatTrimmed} main chat`);
        if (threadTrimmed) trimmedParts.push(`${threadTrimmed} Scratch Pad`);
        detail.push(`Dropped to fit the context window: ${trimmedParts.join(', ')} message${trimmed === 1 ? '' : 's'} (oldest first)`);
    }

    return { summary, detail: detail.join('\n'), trimmed };
}

/**
 * Escape text for use in HTML
 * @param {string} value Text
 * @returns {string} Escaped text
 */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

/**
 * Show a toast that undoes an action when clicked
 * @param {string} message Toast text
 * @param {() => void} onUndo Called at most once, when the toast is clicked
 * @param {number} [timeOut] How long the toast stays up, in ms
 */
export function showUndoToast(message, onUndo, timeOut = 8000) {
    if (typeof toastr === 'undefined') {
        console.log(`[ScratchPad] ${message}`);
        return;
    }

    let used = false;
    toastr.info(`${escapeHtml(message)} <b class="sp-undo-link">Undo</b>`, '', {
        timeOut,
        extendedTimeOut: 4000,
        escapeHtml: false,
        tapToDismiss: true,
        onclick: () => {
            if (used) return;
            used = true;
            onUndo();
        },
    });
}

/**
 * Save text as a file download
 * @param {string} filename File name
 * @param {string} text File contents
 * @param {string} [mimeType] MIME type
 */
export function downloadTextFile(filename, text, mimeType = 'text/plain') {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let openMenu = null;

/**
 * Close the open dropdown menu, if any
 */
export function closeMenu() {
    openMenu?.close();
}

/**
 * Create a button that opens a dropdown menu. The menu is attached to the
 * page body so scrolling containers can't clip it.
 * @param {Object} options Menu options
 * @param {string} options.ariaLabel Button label
 * @param {string} [options.className] Extra button classes
 * @param {() => Array<{label: string, icon?: string, onClick: Function, danger?: boolean}>} options.getItems Items, read when the menu opens
 * @returns {HTMLButtonElement} Menu button
 */
export function createMenuButton({ ariaLabel, className = '', getItems }) {
    const button = createButton({
        icon: Icons.more,
        className: `sp-menu-btn ${className}`.trim(),
        ariaLabel,
        onClick: () => {
            const wasOpen = openMenu?.button === button;
            closeMenu();
            if (!wasOpen) {
                showMenu(button, getItems());
            }
        }
    });
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    return button;
}

function showMenu(button, items) {
    if (!items.length) return;

    const menu = document.createElement('div');
    menu.className = 'sp-dropdown-menu';
    menu.setAttribute('role', 'menu');

    for (const item of items) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = `sp-dropdown-item${item.danger ? ' sp-dropdown-item-danger' : ''}`;
        entry.setAttribute('role', 'menuitem');
        if (item.icon) {
            const iconSpan = document.createElement('span');
            iconSpan.className = 'sp-dropdown-icon';
            iconSpan.setAttribute('aria-hidden', 'true');
            iconSpan.textContent = item.icon;
            entry.appendChild(iconSpan);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        entry.appendChild(label);
        entry.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            close();
            Promise.resolve()
                .then(() => item.onClick())
                .catch(err => {
                    console.error('[ScratchPad] Menu action error:', err);
                    showToast(`Error: ${err.message}`, 'error');
                });
        });
        menu.appendChild(entry);
    }

    document.body.appendChild(menu);

    // Open below the button, flipping up or left when it would leave the screen
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const top = rect.bottom + 4 + menuRect.height > window.innerHeight
        ? Math.max(4, rect.top - 4 - menuRect.height)
        : rect.bottom + 4;
    const left = Math.min(Math.max(4, rect.right - menuRect.width), window.innerWidth - menuRect.width - 4);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    const onPointerDown = (e) => {
        if (!menu.contains(e.target) && !button.contains(e.target)) close();
    };
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            // Handled here so the drawer's own Escape handler leaves it open
            e.preventDefault();
            e.stopPropagation();
            close();
            button.focus();
        }
    };
    const onScroll = (e) => {
        if (!menu.contains(e.target)) close();
    };

    function close() {
        if (openMenu?.menu !== menu) return;
        openMenu = null;
        menu.remove();
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', close);
    }

    openMenu = { menu, button, close };
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    menu.querySelector('.sp-dropdown-item')?.focus();
}

/**
 * Icons used in the extension
 */
export const Icons = {
    close: '✕',
    back: '←',
    send: '➤',
    add: '+',
    delete: '🗑',
    edit: '✎',
    retry: '↻',
    expand: '⤢',
    collapse: '⤡',
    thread: '💬',
    error: '⚠',
    aiRename: '✨',
    speak: '🔊',
    stopSpeak: '⏹',
    cancel: '⏹',
    pin: '📌',
    swipe: '👈',
    chevronLeft: '\u2039',
    chevronRight: '\u203A',
    copy: '📋',
    more: '⋯',
    branch: '⑂',
    insert: '↧',
    note: '📝',
    download: '⤓',
    upload: '⤒',
    star: '★',
    starOutline: '☆'
};
