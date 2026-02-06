/**
 * Popup/Bottom Sheet component for Scratch Pad extension
 * Shows quick responses when using /sp <message>
 */

import { createThread, saveMetadata, getThread } from '../storage.js';
import { generateScratchPadResponse, generateRawPromptResponse, parseThinking, cancelGeneration } from '../generation.js';
import { renderMarkdown, createButton, createSpinner, showToast, Icons, playCompletionSound } from './components.js';
import { speakText, isTTSAvailable } from '../tts.js';
import { getCurrentContextSettings } from '../settings.js';
import { REASONING_STATE, normalizeReasoningMeta } from '../reasoning.js';

let isPopupGenerating = false;

let popupElement = null;
let currentPopupThreadId = null;
let currentPopupResponse = null;

/**
 * Show the quick popup with a new thread and generate response
 * @param {string} message User's question
 */
export async function showQuickPopup(message) {
    // Create new thread with current context settings
    const thread = createThread('New Thread', getCurrentContextSettings());
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    currentPopupThreadId = thread.id;
    await saveMetadata();

    createPopupElement();
    await generatePopupResponse(message);
}

export async function showQuickPopupRaw(message) {
    const thread = createThread('New Thread', getCurrentContextSettings());
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    currentPopupThreadId = thread.id;
    await saveMetadata();

    createPopupElement();
    await generatePopupRawResponse(message);
}

/**
 * Create the popup element
 */
function createPopupElement() {
    // Remove existing popup
    if (popupElement) {
        popupElement.remove();
    }

    popupElement = document.createElement('div');
    popupElement.id = 'scratch-pad-popup';
    popupElement.className = 'sp-popup';

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'sp-popup-backdrop';
    backdrop.addEventListener('click', () => dismissPopup());
    popupElement.appendChild(backdrop);

    // Bottom sheet
    const sheet = document.createElement('div');
    sheet.className = 'sp-popup-sheet';

    // Handle swipe to dismiss
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    sheet.addEventListener('touchstart', (e) => {
        const target = e.target;
        // Only allow drag from header or if not scrollable content
        if (target.closest('.sp-popup-header') || target.closest('.sp-popup-drag-handle')) {
            startY = e.touches[0].clientY;
            isDragging = true;
        }
    });

    sheet.addEventListener('touchmove', (e) => {
        if (!isDragging) return;

        currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;

        if (deltaY > 0) {
            sheet.style.transform = `translateY(${deltaY}px)`;
        }
    });

    sheet.addEventListener('touchend', () => {
        if (!isDragging) return;

        const deltaY = currentY - startY;

        if (deltaY > 100) {
            dismissPopup();
        } else {
            sheet.style.transform = '';
        }

        isDragging = false;
        startY = 0;
        currentY = 0;
    });

    // Drag handle
    const dragHandle = document.createElement('div');
    dragHandle.className = 'sp-popup-drag-handle';
    dragHandle.innerHTML = '<div class="sp-drag-indicator"></div>';
    sheet.appendChild(dragHandle);

    // Header
    const header = document.createElement('div');
    header.className = 'sp-popup-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'sp-popup-title';
    titleEl.id = 'sp-popup-title';
    titleEl.textContent = 'Scratch Pad';
    header.appendChild(titleEl);

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'sp-popup-subtitle';
    subtitleEl.textContent = 'Out of Character';
    header.appendChild(subtitleEl);

    sheet.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'sp-popup-content';
    content.id = 'sp-popup-content';

    const spinner = createSpinner();
    content.appendChild(spinner);

    sheet.appendChild(content);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'sp-popup-actions';
    actions.id = 'sp-popup-actions';

    const cancelBtn = createButton({
        icon: Icons.cancel,
        text: 'Cancel',
        className: 'sp-popup-cancel-btn',
        onClick: () => {
            cancelGeneration();
            showToast('Generation cancelled', 'info');
        }
    });
    cancelBtn.id = 'sp-popup-cancel-btn';

    const openBtn = createButton({
        icon: Icons.expand,
        text: 'Open in Scratch Pad',
        className: 'sp-popup-open-btn',
        onClick: () => handleOpenInScratchPad()
    });
    openBtn.id = 'sp-popup-open-btn';

    const speakBtn = createButton({
        icon: Icons.speak,
        className: 'sp-speak-btn sp-popup-speak-btn',
        ariaLabel: 'Speak response',
        onClick: async () => {
            speakBtn.disabled = true;
            speakBtn.classList.add('sp-speaking');
            try {
                const success = await speakText(currentPopupResponse);
                if (!success) {
                    showToast('TTS failed. Check your TTS settings.', 'warning');
                }
            } finally {
                speakBtn.disabled = false;
                speakBtn.classList.remove('sp-speaking');
            }
        }
    });
    speakBtn.id = 'sp-popup-speak-btn';
    speakBtn.style.display = 'none';

    const dismissBtn = createButton({
        icon: Icons.close,
        text: 'Dismiss',
        className: 'sp-popup-dismiss-btn',
        onClick: () => dismissPopup()
    });
    dismissBtn.id = 'sp-popup-dismiss-btn';

    // Initially show cancel, hide open and speak (will swap when generation completes)
    actions.appendChild(cancelBtn);
    actions.appendChild(openBtn);
    actions.appendChild(speakBtn);
    actions.appendChild(dismissBtn);
    openBtn.style.display = 'none';
    sheet.appendChild(actions);

    popupElement.appendChild(sheet);
    document.body.appendChild(popupElement);

    // Animate in
    requestAnimationFrame(() => {
        popupElement.classList.add('sp-popup-visible');
    });
}

/**
 * Swap popup action buttons between generating and complete states
 * @param {boolean} isGenerating Whether currently generating
 * @param {boolean} hasResponse Whether a successful response is available for TTS
 */
function updatePopupActionButtons(isGenerating, hasResponse = false) {
    const cancelBtn = document.getElementById('sp-popup-cancel-btn');
    const openBtn = document.getElementById('sp-popup-open-btn');
    const speakBtn = document.getElementById('sp-popup-speak-btn');

    if (cancelBtn) cancelBtn.style.display = isGenerating ? '' : 'none';
    if (openBtn) openBtn.style.display = isGenerating ? 'none' : '';
    if (speakBtn) {
        speakBtn.style.display = (!isGenerating && hasResponse && isTTSAvailable()) ? '' : 'none';
    }
}

function formatReasoningDuration(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return '';
    if (duration >= 10000) return `${Math.round(duration / 1000)}s`;
    return `${(duration / 1000).toFixed(1)}s`;
}

function renderReasoningHtml(thinking, reasoningMeta) {
    if (thinking) {
        return `
            <details class="sp-thinking">
                <summary>💭 Model Thinking</summary>
                <div class="sp-thinking-content">${renderMarkdown(thinking)}</div>
            </details>
        `;
    }

    const normalizedMeta = normalizeReasoningMeta(reasoningMeta, thinking);
    if (normalizedMeta.state === REASONING_STATE.HIDDEN) {
        const duration = formatReasoningDuration(normalizedMeta.durationMs);
        const hiddenText = duration
            ? `Model reasoning hidden by provider (${duration})`
            : 'Model reasoning hidden by provider';
        return `<div class="sp-thinking-hidden">${hiddenText}</div>`;
    }

    return '';
}

/**
 * Generate response for popup
 * @param {string} message User's message
 */
async function generatePopupResponse(message) {
    const contentEl = document.getElementById('sp-popup-content');
    const titleEl = document.getElementById('sp-popup-title');

    if (!contentEl || !currentPopupThreadId) return;

    isPopupGenerating = true;
    updatePopupActionButtons(true);

    try {
        const result = await generateScratchPadResponse(message, currentPopupThreadId, (partialResponse, isComplete) => {
            // Parse out thinking tags during streaming so they don't appear as raw markdown
            const { cleanedResponse } = parseThinking(partialResponse);

            // Update content with streaming response
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${renderMarkdown(cleanedResponse)}
                </div>
            `;

            // Scroll to follow streaming
            contentEl.scrollTop = contentEl.scrollHeight;
        });

        if (!result.success && !result.cancelled) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'sp-popup-error';
            const iconSpan = document.createElement('span');
            iconSpan.className = 'sp-error-icon';
            iconSpan.innerHTML = Icons.error;
            const textSpan = document.createElement('span');
            textSpan.textContent = `Error: ${result.error}`;
            errorDiv.appendChild(iconSpan);
            errorDiv.appendChild(textSpan);
            contentEl.innerHTML = '';
            contentEl.appendChild(errorDiv);
        } else if (result.cancelled) {
            contentEl.innerHTML = `
                <div class="sp-popup-response sp-popup-cancelled">
                    <span>Generation cancelled</span>
                </div>
            `;
        } else {
            // Render final response with thinking if present
            const thinkingHtml = renderReasoningHtml(result.thinking, result.reasoningMeta);
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${thinkingHtml}
                    ${renderMarkdown(result.response)}
                </div>
            `;
            // Store response for TTS
            currentPopupResponse = result.response;
            playCompletionSound();
        }

        // Update title with thread name
        const thread = getThread(currentPopupThreadId);
        if (thread && titleEl) {
            titleEl.textContent = thread.name;
        }

    } catch (error) {
        console.error('[ScratchPad] Popup generation error:', error);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'sp-popup-error';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'sp-error-icon';
        iconSpan.innerHTML = Icons.error;
        const textSpan = document.createElement('span');
        textSpan.textContent = `Error: ${error.message}`;
        errorDiv.appendChild(iconSpan);
        errorDiv.appendChild(textSpan);
        contentEl.innerHTML = '';
        contentEl.appendChild(errorDiv);
        currentPopupResponse = null;
    } finally {
        isPopupGenerating = false;
        updatePopupActionButtons(false, currentPopupResponse !== null);
    }
}

async function generatePopupRawResponse(message) {
    const contentEl = document.getElementById('sp-popup-content');
    const titleEl = document.getElementById('sp-popup-title');

    if (!contentEl || !currentPopupThreadId) return;

    isPopupGenerating = true;
    updatePopupActionButtons(true);

    try {
        const result = await generateRawPromptResponse(message, currentPopupThreadId, (partialResponse) => {
            const { cleanedResponse } = parseThinking(partialResponse);

            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${renderMarkdown(cleanedResponse)}
                </div>
            `;

            contentEl.scrollTop = contentEl.scrollHeight;
        });

        if (!result.success && !result.cancelled) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'sp-popup-error';
            const iconSpan = document.createElement('span');
            iconSpan.className = 'sp-error-icon';
            iconSpan.innerHTML = Icons.error;
            const textSpan = document.createElement('span');
            textSpan.textContent = `Error: ${result.error}`;
            errorDiv.appendChild(iconSpan);
            errorDiv.appendChild(textSpan);
            contentEl.innerHTML = '';
            contentEl.appendChild(errorDiv);
        } else if (result.cancelled) {
            contentEl.innerHTML = `
                <div class="sp-popup-response sp-popup-cancelled">
                    <span>Generation cancelled</span>
                </div>
            `;
        } else {
            const thinkingHtml = renderReasoningHtml(result.thinking, result.reasoningMeta);
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${thinkingHtml}
                    ${renderMarkdown(result.response)}
                </div>
            `;
            // Store response for TTS
            currentPopupResponse = result.response;
            playCompletionSound();
        }

        const thread = getThread(currentPopupThreadId);
        if (thread && titleEl) {
            titleEl.textContent = thread.name;
        }

    } catch (error) {
        console.error('[ScratchPad] Popup generation error:', error);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'sp-popup-error';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'sp-error-icon';
        iconSpan.innerHTML = Icons.error;
        const textSpan = document.createElement('span');
        textSpan.textContent = `Error: ${error.message}`;
        errorDiv.appendChild(iconSpan);
        errorDiv.appendChild(textSpan);
        contentEl.innerHTML = '';
        contentEl.appendChild(errorDiv);
        currentPopupResponse = null;
    } finally {
        isPopupGenerating = false;
        updatePopupActionButtons(false, currentPopupResponse !== null);
    }
}

/**
 * Handle opening the thread in full scratch pad
 */
async function handleOpenInScratchPad() {
    const threadId = currentPopupThreadId;
    dismissPopup();

    if (threadId) {
        // Dynamic imports to avoid circular dependency
        const { openScratchPad } = await import('./index.js');
        const { openThread } = await import('./conversation.js');
        openScratchPad();
        setTimeout(() => openThread(threadId), 100);
    }
}

/**
 * Dismiss the popup
 */
export function dismissPopup() {
    if (!popupElement) {
        return;
    }

    // Cancel any active generation when dismissing
    if (isPopupGenerating) {
        cancelGeneration();
    }

    popupElement.classList.remove('sp-popup-visible');
    popupElement.classList.add('sp-popup-hiding');

    setTimeout(() => {
        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }
        currentPopupThreadId = null;
        currentPopupResponse = null;
    }, 300);
}

/**
 * Check if popup is currently visible
 * @returns {boolean} True if popup is visible
 */
export function isPopupVisible() {
    return popupElement !== null && popupElement.classList.contains('sp-popup-visible');
}
