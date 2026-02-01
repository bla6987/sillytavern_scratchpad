/**
 * Shared UI components for Scratch Pad extension
 */

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

/**
 * Sanitize and render markdown to HTML
 * @param {string} text Markdown text
 * @returns {string} Sanitized HTML
 */
export function renderMarkdown(text) {
    if (!text) return '';
    const html = getConverter().makeHtml(text);
    return getDOMPurify().sanitize(html);
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
    swipe: '👈'
};
