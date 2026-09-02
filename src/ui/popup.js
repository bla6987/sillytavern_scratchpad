/**
 * Popup/Bottom Sheet component for Scratch Pad extension
 * Shows quick responses when using /sp <message>
 */

import { createThread, saveMetadata, getThread } from '../storage.js';
import { generateScratchPadResponse, generateRawPromptResponse, generateGeneralAskResponse, parseThinking, cancelGeneration } from '../generation.js';
import { renderMarkdown, createStreamingRenderer, createButton, createSpinner, showToast, Icons, playCompletionSound } from './components.js';
import { speakText, isTTSAvailable } from '../tts.js';
import { getCurrentContextSettings } from '../settings.js';
import { REASONING_STATE, normalizeReasoningMeta } from '../reasoning.js';

let isPopupGenerating = false;

let popupElement = null;
let currentPopupThreadId = null;
let currentPopupResponse = null;
let transferredPopupThreadId = null;

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

export async function showQuickPopupAsk(message) {
    const thread = createThread('New Thread', getCurrentContextSettings());
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    currentPopupThreadId = thread.id;
    await saveMetadata();

    createPopupElement();
    await generatePopupRawResponse(message, {
        generateResponse: generateGeneralAskResponse,
        errorLabel: 'General ask',
    });
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

    // Inline style fallbacks keep the popup visible even if stylesheet loading is delayed.
    Object.assign(popupElement.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        minHeight: '100vh',
        zIndex: '2147483647',
        boxSizing: 'border-box',
        overflow: 'hidden',
        isolation: 'isolate',
        opacity: '0',
        pointerEvents: 'none',
    });
    popupElement.style.setProperty('height', '100dvh');
    popupElement.style.setProperty('min-height', '100dvh');

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'sp-popup-backdrop';
    Object.assign(backdrop.style, {
        position: 'absolute',
        inset: '0',
        background: 'rgba(0, 0, 0, 0.6)',
    });
    backdrop.addEventListener('click', () => dismissPopup());
    popupElement.appendChild(backdrop);

    // Bottom sheet
    const sheet = document.createElement('div');
    sheet.className = 'sp-popup-sheet';
    Object.assign(sheet.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        bottom: '0',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxHeight: '70vh',
        transform: 'translateY(100%)',
        transition: 'transform 0.3s ease',
        boxSizing: 'border-box',
    });
    sheet.style.setProperty('max-height', '70dvh');
    sheet.style.setProperty('padding-bottom', 'env(safe-area-inset-bottom)');

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

    // Opening the response in the full panel is available while generation continues.
    actions.appendChild(cancelBtn);
    actions.appendChild(openBtn);
    actions.appendChild(speakBtn);
    actions.appendChild(dismissBtn);
    sheet.appendChild(actions);

    popupElement.appendChild(sheet);
    (document.body || document.documentElement).appendChild(popupElement);

    // Animate in
    requestAnimationFrame(() => {
        popupElement.classList.add('sp-popup-visible');
        popupElement.style.opacity = '1';
        popupElement.style.pointerEvents = 'auto';
        sheet.style.transform = 'translateY(0)';
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
    if (openBtn) openBtn.style.display = '';
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

function formatGenerationDuration(genStarted, genFinished) {
    const start = Date.parse(genStarted);
    const finish = Date.parse(genFinished);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return '';

    const seconds = (finish - start) / 1000;
    if (seconds >= 100) return `${Math.round(seconds)}s`;
    if (seconds >= 10) return `${seconds.toFixed(1)}s`;
    return `${seconds.toFixed(2)}s`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function trimGenerationMetaValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getGenerationExtra(result) {
    const extra = result?.generationInfo || result?.extra || {};
    const api = trimGenerationMetaValue(extra.api);
    const model = trimGenerationMetaValue(extra.model);
    return api || model ? { api, model } : null;
}

function formatGenerationModelTitle(extra) {
    if (!extra) return '';
    if (extra.api && extra.model) return `${extra.api} - ${extra.model}`;
    return extra.model || extra.api || '';
}

function renderGenerationModelHtml(result) {
    const extra = getGenerationExtra(result);
    if (!extra) return '';

    const title = formatGenerationModelTitle(extra);
    if (extra.api) {
        const iconName = extra.api.replace(/[^a-z0-9_-]/gi, '');
        if (iconName) {
            return `<img class="icon-svg timestamp-icon sp-message-model-icon" src="/img/${encodeURIComponent(iconName)}.svg" alt="${escapeHtml(title || extra.api)}" title="${escapeHtml(title)}">`;
        }
    }

    return extra.model
        ? `<span class="sp-message-generation-time" title="${escapeHtml(title)}">Model: ${escapeHtml(extra.model)}</span>`
        : '';
}

function renderGenerationTimingHtml(result) {
    const duration = formatGenerationDuration(result?.gen_started, result?.gen_finished);
    const modelHtml = renderGenerationModelHtml(result);
    const durationHtml = duration ? `<span class="sp-message-generation-time">Generated in ${escapeHtml(duration)}</span>` : '';
    return modelHtml || durationHtml
        ? `<div class="sp-message-generation-meta">${modelHtml}${durationHtml}</div>`
        : '';
}

function injectModelIcons(container) {
    container.querySelectorAll('img.sp-message-model-icon').forEach(image => {
        const inject = () => {
            try {
                globalThis.SVGInject?.(image);
            } catch {
                // SillyTavern may not expose SVGInject in tests or older builds.
            }
        };

        if (image.complete && image.naturalWidth > 0) {
            inject();
        } else {
            image.addEventListener('load', inject, { once: true });
        }
        image.addEventListener('error', () => image.remove(), { once: true });
    });
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
    const threadId = currentPopupThreadId;

    if (!contentEl || !threadId) return;

    isPopupGenerating = true;
    currentPopupResponse = null;
    updatePopupActionButtons(true);

    try {
        let _latestPopupResponse = '';
        const getPopupStreamEl = () => {
            let el = contentEl.querySelector('.sp-popup-response');
            if (!el) {
                contentEl.innerHTML = '<div class="sp-popup-response"></div>';
                el = contentEl.querySelector('.sp-popup-response');
            }
            return el;
        };
        const popupRenderer = createStreamingRenderer(
            getPopupStreamEl,
            () => parseThinking(_latestPopupResponse).cleanedResponse,
            () => { contentEl.scrollTop = contentEl.scrollHeight; }
        );
        const result = await generateScratchPadResponse(message, threadId, (partialResponse, isComplete) => {
            _latestPopupResponse = partialResponse;
            updateTransferredGeneration(threadId, partialResponse, isComplete);

            if (isComplete) {
                // Render the final markdown once, after streaming completes
                popupRenderer.cancel();
                const { cleanedResponse } = parseThinking(partialResponse);
                contentEl.innerHTML = `
                    <div class="sp-popup-response">
                        ${renderMarkdown(cleanedResponse)}
                    </div>
                `;
                contentEl.scrollTop = contentEl.scrollHeight;
            } else {
                // Stream cheap plain text; markdown is rendered once on completion
                popupRenderer.schedule();
            }
        });
        popupRenderer.cancel();

        if (!result.success && !result.cancelled) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'sp-popup-error';
            const iconSpan = document.createElement('span');
            iconSpan.className = 'sp-error-icon';
            iconSpan.innerHTML = Icons.error;
            const textSpan = document.createElement('span');
            textSpan.textContent = `Response generation failed: ${result.error}`;
            errorDiv.appendChild(iconSpan);
            errorDiv.appendChild(textSpan);
            contentEl.innerHTML = '';
            contentEl.appendChild(errorDiv);
            currentPopupResponse = null;
        } else if (result.cancelled) {
            contentEl.innerHTML = `
                <div class="sp-popup-response sp-popup-cancelled">
                    <span>Generation cancelled</span>
                </div>
            `;
            currentPopupResponse = null;
        } else {
            // Render final response with thinking if present
            const thinkingHtml = renderReasoningHtml(result.thinking, result.reasoningMeta);
            const timingHtml = renderGenerationTimingHtml(result);
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${thinkingHtml}
                    ${renderMarkdown(result.response)}
                    ${timingHtml}
                </div>
            `;
            injectModelIcons(contentEl);
            // Store response for TTS
            currentPopupResponse = result.response;
            playCompletionSound();
        }

        // Update title with thread name
        const thread = getThread(threadId);
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
        textSpan.textContent = `Response generation failed: ${error.message}`;
        errorDiv.appendChild(iconSpan);
        errorDiv.appendChild(textSpan);
        contentEl.innerHTML = '';
        contentEl.appendChild(errorDiv);
        currentPopupResponse = null;
    } finally {
        isPopupGenerating = false;
        updatePopupActionButtons(false, currentPopupResponse !== null);
        finishTransferredGeneration(threadId);
    }
}

async function generatePopupRawResponse(message, options = {}) {
    const contentEl = document.getElementById('sp-popup-content');
    const titleEl = document.getElementById('sp-popup-title');
    const threadId = currentPopupThreadId;
    const generateResponse = options.generateResponse || generateRawPromptResponse;
    const errorLabel = options.errorLabel || 'Raw prompt';

    if (!contentEl || !threadId) return;

    isPopupGenerating = true;
    currentPopupResponse = null;
    updatePopupActionButtons(true);

    try {
        let _latestRawResponse = '';
        const getRawStreamEl = () => {
            let el = contentEl.querySelector('.sp-popup-response');
            if (!el) {
                contentEl.innerHTML = '<div class="sp-popup-response"></div>';
                el = contentEl.querySelector('.sp-popup-response');
            }
            return el;
        };
        const rawRenderer = createStreamingRenderer(
            getRawStreamEl,
            () => parseThinking(_latestRawResponse).cleanedResponse,
            () => { contentEl.scrollTop = contentEl.scrollHeight; }
        );
        const result = await generateResponse(message, threadId, (partialResponse, isComplete) => {
            // Stream cheap plain text; final markdown is rendered below once the
            // response completes.
            _latestRawResponse = partialResponse;
            rawRenderer.schedule();
            updateTransferredGeneration(threadId, partialResponse, isComplete);
        });
        rawRenderer.cancel();

        if (!result.success && !result.cancelled) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'sp-popup-error';
            const iconSpan = document.createElement('span');
            iconSpan.className = 'sp-error-icon';
            iconSpan.innerHTML = Icons.error;
            const textSpan = document.createElement('span');
            textSpan.textContent = `${errorLabel} failed: ${result.error}`;
            errorDiv.appendChild(iconSpan);
            errorDiv.appendChild(textSpan);
            contentEl.innerHTML = '';
            contentEl.appendChild(errorDiv);
            currentPopupResponse = null;
        } else if (result.cancelled) {
            contentEl.innerHTML = `
                <div class="sp-popup-response sp-popup-cancelled">
                    <span>Generation cancelled</span>
                </div>
            `;
            currentPopupResponse = null;
        } else {
            const thinkingHtml = renderReasoningHtml(result.thinking, result.reasoningMeta);
            const timingHtml = renderGenerationTimingHtml(result);
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${thinkingHtml}
                    ${renderMarkdown(result.response)}
                    ${timingHtml}
                </div>
            `;
            injectModelIcons(contentEl);
            // Store response for TTS
            currentPopupResponse = result.response;
            playCompletionSound();
        }

        const thread = getThread(threadId);
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
        textSpan.textContent = `${errorLabel} failed: ${error.message}`;
        errorDiv.appendChild(iconSpan);
        errorDiv.appendChild(textSpan);
        contentEl.innerHTML = '';
        contentEl.appendChild(errorDiv);
        currentPopupResponse = null;
    } finally {
        isPopupGenerating = false;
        updatePopupActionButtons(false, currentPopupResponse !== null);
        finishTransferredGeneration(threadId);
    }
}

function updateTransferredGeneration(threadId, partialResponse, isComplete) {
    if (transferredPopupThreadId !== threadId) return;

    import('./conversation.js')
        .then(({ updateTransferredGeneration: updateConversation }) => {
            updateConversation(threadId, partialResponse, isComplete);
        })
        .catch(error => console.error('[ScratchPad] Failed to update transferred generation:', error));
}

function finishTransferredGeneration(threadId) {
    if (transferredPopupThreadId !== threadId) return;

    transferredPopupThreadId = null;
    import('./conversation.js')
        .then(({ finishTransferredGeneration: finishConversation }) => {
            finishConversation(threadId);
        })
        .catch(error => console.error('[ScratchPad] Failed to finish transferred generation:', error));
}

/**
 * Handle opening the thread in full scratch pad
 */
async function handleOpenInScratchPad() {
    const threadId = currentPopupThreadId;

    if (threadId) {
        if (isPopupGenerating) {
            transferredPopupThreadId = threadId;
        }

        dismissPopup({ cancelActiveGeneration: false });

        // Dynamic import to avoid circular dependency
        const { openScratchPad } = await import('./index.js');
        openScratchPad(threadId);
    }
}

/**
 * Dismiss the popup
 */
export function dismissPopup({ cancelActiveGeneration = true } = {}) {
    if (!popupElement) {
        return;
    }

    // Cancel any active generation when dismissing
    if (isPopupGenerating && cancelActiveGeneration) {
        cancelGeneration();
    }

    popupElement.classList.remove('sp-popup-visible');
    popupElement.classList.add('sp-popup-hiding');
    popupElement.style.opacity = '0';
    popupElement.style.pointerEvents = 'none';
    const sheetEl = popupElement.querySelector('.sp-popup-sheet');
    if (sheetEl) {
        sheetEl.style.transform = 'translateY(100%)';
    }

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
