/**
 * Popup/Bottom Sheet component for Scratch Pad extension
 * Shows quick responses when using /sp <message>
 */

import { createThread, saveMetadata } from '../storage.js';
import { generateScratchPadResponse } from '../generation.js';
import { renderMarkdown, createButton, createSpinner, showToast, Icons } from './components.js';

let popupElement = null;
let currentPopupThreadId = null;

/**
 * Show the quick popup with a new thread and generate response
 * @param {string} message User's question
 */
export async function showQuickPopup(message) {
    console.log('[ScratchPad Popup] showQuickPopup called with message:', message);

    // Create new thread
    console.log('[ScratchPad Popup] Creating new thread');
    const thread = createThread('New Thread');
    if (!thread) {
        console.error('[ScratchPad Popup] Failed to create thread');
        showToast('Failed to create thread', 'error');
        return;
    }

    console.log('[ScratchPad Popup] Thread created with ID:', thread.id);
    currentPopupThreadId = thread.id;
    await saveMetadata();

    // Create and show popup
    console.log('[ScratchPad Popup] Creating popup element');
    createPopupElement();

    // Generate response
    console.log('[ScratchPad Popup] Starting response generation');
    await generatePopupResponse(message);
}

/**
 * Create the popup element
 */
function createPopupElement() {
    console.log('[ScratchPad Popup] createPopupElement called');

    // Remove existing popup
    if (popupElement) {
        console.log('[ScratchPad Popup] Removing existing popup');
        popupElement.remove();
    }

    popupElement = document.createElement('div');
    popupElement.id = 'scratch-pad-popup';
    popupElement.className = 'sp-popup';

    console.log('[ScratchPad Popup] Popup element created');

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

    const openBtn = createButton({
        icon: Icons.expand,
        text: 'Open in Scratch Pad',
        className: 'sp-popup-open-btn',
        onClick: () => handleOpenInScratchPad()
    });

    const dismissBtn = createButton({
        icon: Icons.close,
        text: 'Dismiss',
        className: 'sp-popup-dismiss-btn',
        onClick: () => dismissPopup()
    });

    actions.appendChild(openBtn);
    actions.appendChild(dismissBtn);
    sheet.appendChild(actions);

    popupElement.appendChild(sheet);
    document.body.appendChild(popupElement);

    console.log('[ScratchPad Popup] Popup appended to body, animating in');

    // Animate in
    requestAnimationFrame(() => {
        popupElement.classList.add('sp-popup-visible');
        console.log('[ScratchPad Popup] Popup visible');
    });
}

/**
 * Generate response for popup
 * @param {string} message User's message
 */
async function generatePopupResponse(message) {
    const contentEl = document.getElementById('sp-popup-content');
    const titleEl = document.getElementById('sp-popup-title');

    if (!contentEl || !currentPopupThreadId) return;

    try {
        const result = await generateScratchPadResponse(message, currentPopupThreadId, (partialResponse, isComplete) => {
            // Update content with streaming response
            contentEl.innerHTML = `
                <div class="sp-popup-response">
                    ${renderMarkdown(partialResponse)}
                </div>
            `;

            // Scroll to follow streaming
            contentEl.scrollTop = contentEl.scrollHeight;
        });

        if (!result.success) {
            contentEl.innerHTML = `
                <div class="sp-popup-error">
                    <span class="sp-error-icon">${Icons.error}</span>
                    <span>Error: ${result.error}</span>
                </div>
            `;
        }

        // Update title with thread name
        const { getThread } = await import('../storage.js');
        const thread = getThread(currentPopupThreadId);
        if (thread && titleEl) {
            titleEl.textContent = thread.name;
        }

    } catch (error) {
        console.error('[ScratchPad] Popup generation error:', error);
        contentEl.innerHTML = `
            <div class="sp-popup-error">
                <span class="sp-error-icon">${Icons.error}</span>
                <span>Error: ${error.message}</span>
            </div>
        `;
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
    console.log('[ScratchPad Popup] dismissPopup called');

    if (!popupElement) {
        console.log('[ScratchPad Popup] No popup to dismiss');
        return;
    }

    console.log('[ScratchPad Popup] Hiding popup');
    popupElement.classList.remove('sp-popup-visible');
    popupElement.classList.add('sp-popup-hiding');

    setTimeout(() => {
        if (popupElement) {
            console.log('[ScratchPad Popup] Removing popup from DOM');
            popupElement.remove();
            popupElement = null;
        }
        currentPopupThreadId = null;
    }, 300);
}

/**
 * Check if popup is currently visible
 * @returns {boolean} True if popup is visible
 */
export function isPopupVisible() {
    return popupElement !== null && popupElement.classList.contains('sp-popup-visible');
}
