/**
 * UI module index for Scratch Pad extension
 * Exports all UI components and manages the drawer
 */

import { renderThreadList, refreshThreadList } from './threadList.js';
import { openThread, startNewThread, getCurrentThreadId, renderConversation } from './conversation.js';
import { showQuickPopup, dismissPopup, isPopupVisible } from './popup.js';

export { renderThreadList, refreshThreadList } from './threadList.js';
export { openThread, startNewThread, getCurrentThreadId } from './conversation.js';
export { showQuickPopup, dismissPopup, isPopupVisible } from './popup.js';

let drawerElement = null;

/**
 * Create the scratch pad drawer element
 */
function createDrawer() {
    console.log('[ScratchPad UI] Creating drawer element');

    // Check if drawer exists in DOM (stale from previous load)
    const existingDrawer = document.getElementById('scratch-pad-drawer');
    if (existingDrawer) {
        console.log('[ScratchPad UI] Removing existing drawer element');
        existingDrawer.remove();
    }

    drawerElement = document.createElement('div');
    drawerElement.id = 'scratch-pad-drawer';
    drawerElement.className = 'sp-drawer';

    // Force a consistent initial hidden state even if CSS loads late
    drawerElement.style.transition = 'none';
    drawerElement.style.transform = 'translateX(100%)';

    console.log('[ScratchPad UI] Drawer element created with transform:', drawerElement.style.transform);

    const content = document.createElement('div');
    content.className = 'sp-drawer-content';
    drawerElement.appendChild(content);

    // Prevent body scroll when drawer is open
    drawerElement.addEventListener('touchmove', (e) => {
        const target = e.target;
        const scrollableEl = target.closest('.sp-messages, .sp-thread-list, .sp-popup-content');
        if (!scrollableEl) {
            // Allow scrolling only in scrollable containers
        }
    }, { passive: true });

    document.body.appendChild(drawerElement);
    console.log('[ScratchPad UI] Drawer appended to body');

    return drawerElement;
}

/**
 * Open the scratch pad drawer
 * @param {string} [threadId] Optional thread ID to open directly
 */
export function openScratchPad(threadId = null) {
    console.log('[ScratchPad UI] openScratchPad called with threadId:', threadId);
    console.log('[ScratchPad UI] Current drawerElement state:', drawerElement ? 'exists' : 'null');

    // Reuse existing drawer if it exists, otherwise create new
    if (!drawerElement) {
        console.log('[ScratchPad UI] No existing drawer, creating new one');
        drawerElement = createDrawer();
    } else {
        console.log('[ScratchPad UI] Reusing existing drawer element');
    }

    const content = drawerElement.querySelector('.sp-drawer-content');

    if (!content) {
        console.error('[ScratchPad UI] ERROR: No content element found in drawer!');
        return;
    }

    console.log('[ScratchPad UI] Adding sp-drawer-open class to body');
    // Prevent body scroll
    document.body.classList.add('sp-drawer-open');

    // Ensure a consistent initial state before opening
    console.log('[ScratchPad UI] Removing open class before animation');
    drawerElement.classList.remove('open');

    // Show drawer on next frame to avoid style-load timing issues
    requestAnimationFrame(() => {
        console.log('[ScratchPad UI] Animating drawer open');
        // Re-enable CSS transitions after the initial hidden state is applied
        drawerElement.style.transition = '';
        drawerElement.style.transform = '';
        drawerElement.classList.add('open');
        console.log('[ScratchPad UI] Drawer classes:', drawerElement.className);
        console.log('[ScratchPad UI] Drawer transform:', drawerElement.style.transform);
    });

    // Render appropriate view
    try {
        if (threadId) {
            console.log('[ScratchPad UI] Opening specific thread:', threadId);
            openThread(threadId);
        } else {
            console.log('[ScratchPad UI] Rendering thread list');
            renderThreadList(content);
        }
    } catch (err) {
        console.error('[ScratchPad UI] Failed to render drawer content:', err);
    }
}

/**
 * Close the scratch pad drawer
 */
export function closeScratchPad() {
    console.log('[ScratchPad UI] closeScratchPad called');

    if (!drawerElement) {
        console.log('[ScratchPad UI] No drawer to close');
        return;
    }

    console.log('[ScratchPad UI] Removing open class and body lock');
    drawerElement.classList.remove('open');
    document.body.classList.remove('sp-drawer-open');

    // Remove drawer element after transition completes (300ms as per CSS)
    setTimeout(() => {
        if (drawerElement && !drawerElement.classList.contains('open')) {
            console.log('[ScratchPad UI] Removing drawer from DOM');
            drawerElement.remove();
            drawerElement = null;
        }
    }, 350);
}

/**
 * Toggle the scratch pad drawer
 */
export function toggleScratchPad() {
    if (drawerElement && drawerElement.classList.contains('open')) {
        closeScratchPad();
    } else {
        openScratchPad();
    }
}

/**
 * Check if scratch pad is currently open
 * @returns {boolean} True if drawer is open
 */
export function isScratchPadOpen() {
    return drawerElement && drawerElement.classList.contains('open');
}

/**
 * Refresh the scratch pad UI if open
 */
export function refreshScratchPadUI() {
    if (!isScratchPadOpen()) return;

    const content = drawerElement.querySelector('.sp-drawer-content');
    if (!content) return;

    const currentThread = getCurrentThreadId();

    if (currentThread) {
        // Refresh conversation view
        renderConversation(content);
    } else {
        // Refresh thread list
        renderThreadList(content);
    }
}

/**
 * Initialize the UI
 */
export function initUI() {
    // Clean up any stale drawer from previous loads
    const existingDrawer = document.getElementById('scratch-pad-drawer');
    if (existingDrawer) {
        existingDrawer.remove();
    }
    drawerElement = null;
    document.body.classList.remove('sp-drawer-open');

    // Handle escape key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (isPopupVisible()) {
                dismissPopup();
            } else if (isScratchPadOpen()) {
                closeScratchPad();
            }
        }
    });

    // Handle back button on mobile
    window.addEventListener('popstate', () => {
        if (isPopupVisible()) {
            dismissPopup();
        } else if (isScratchPadOpen()) {
            closeScratchPad();
        }
    });
}
