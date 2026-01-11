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
let backdropElement = null;

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

    // Apply critical inline styles as fallback in case CSS doesn't load
    // Use viewport units (vh) instead of % because SillyTavern's transform on html breaks % for fixed elements
    Object.assign(drawerElement.style, {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: 'auto', // Ensure right positioning works
        height: '100vh', // Use vh, not % - SillyTavern has transform on html which breaks %
        minHeight: '100vh',
        width: '100%',
        zIndex: '99999', // Very high to overlay SillyTavern UI
        background: '#1a1a2e',
        transform: 'translateX(100%)',
        transition: 'transform 0.3s ease',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.5)',
        overflow: 'hidden'
    });

    console.log('[ScratchPad UI] Drawer element created');

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
 * Create the backdrop element for mobile overlay
 */
function createBackdrop() {
    // Remove existing backdrop if any
    const existingBackdrop = document.getElementById('scratch-pad-backdrop');
    if (existingBackdrop) {
        existingBackdrop.remove();
    }

    backdropElement = document.createElement('div');
    backdropElement.id = 'scratch-pad-backdrop';
    backdropElement.className = 'sp-drawer-backdrop';

    // Apply inline styles as fallback - use viewport units
    Object.assign(backdropElement.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        minHeight: '100vh',
        background: 'rgba(0, 0, 0, 0.6)',
        zIndex: '99998',
        opacity: '0',
        transition: 'opacity 0.3s ease',
        pointerEvents: 'none'
    });

    // Click backdrop to close drawer
    backdropElement.addEventListener('click', () => {
        closeScratchPad();
    });

    document.body.appendChild(backdropElement);
    return backdropElement;
}

/**
 * Show the backdrop
 */
function showBackdrop() {
    if (!backdropElement || !backdropElement.isConnected) {
        createBackdrop();
    }
    requestAnimationFrame(() => {
        backdropElement.classList.add('visible');
        // Also set inline styles as fallback
        backdropElement.style.opacity = '1';
        backdropElement.style.pointerEvents = 'auto';
    });
}

/**
 * Hide the backdrop
 */
function hideBackdrop() {
    if (backdropElement) {
        backdropElement.classList.remove('visible');
        // Also set inline styles as fallback
        backdropElement.style.opacity = '0';
        backdropElement.style.pointerEvents = 'none';
        // Remove after transition
        setTimeout(() => {
            if (backdropElement && !backdropElement.classList.contains('visible')) {
                backdropElement.remove();
                backdropElement = null;
            }
        }, 350);
    }
}

/**
 * Open the scratch pad drawer
 * @param {string} [threadId] Optional thread ID to open directly
 */
export function openScratchPad(threadId = null) {
    console.log('[ScratchPad UI] openScratchPad called with threadId:', threadId);
    console.log('[ScratchPad UI] Current drawerElement state:', drawerElement ? 'exists' : 'null');

    // Check if drawer exists AND is still in the DOM
    if (!drawerElement || !drawerElement.isConnected) {
        if (drawerElement && !drawerElement.isConnected) {
            console.log('[ScratchPad UI] Drawer exists but not in DOM, creating new one');
            drawerElement = null; // Clear the stale reference
        } else {
            console.log('[ScratchPad UI] No existing drawer, creating new one');
        }
        drawerElement = createDrawer();
    } else {
        console.log('[ScratchPad UI] Reusing existing drawer element');
    }

    const content = drawerElement.querySelector('.sp-drawer-content');

    if (!content) {
        console.error('[ScratchPad UI] ERROR: No content element found in drawer!');
        console.error('[ScratchPad UI] Drawer element:', drawerElement);
        console.error('[ScratchPad UI] Drawer is connected:', drawerElement.isConnected);
        return;
    }

    console.log('[ScratchPad UI] Adding sp-drawer-open class to body');
    // Prevent body scroll
    document.body.classList.add('sp-drawer-open');

    // Show backdrop for overlay effect
    showBackdrop();

    // Add open class to trigger CSS animation
    console.log('[ScratchPad UI] Adding open class to drawer');
    // Use a small delay to ensure the element is fully rendered
    requestAnimationFrame(() => {
        drawerElement.classList.add('open');
        // Force transform to ensure visibility (fallback if CSS isn't loaded)
        drawerElement.style.transform = 'translateX(0)';
        console.log('[ScratchPad UI] Drawer classes:', drawerElement.className);
        const computedStyle = window.getComputedStyle(drawerElement);
        console.log('[ScratchPad UI] Computed transform:', computedStyle.transform);
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
    // Reset inline transform to allow CSS default (translateX(100%)) for close animation
    drawerElement.style.transform = '';
    document.body.classList.remove('sp-drawer-open');

    // Hide backdrop
    hideBackdrop();

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
    const existingBackdrop = document.getElementById('scratch-pad-backdrop');
    if (existingBackdrop) {
        existingBackdrop.remove();
    }
    drawerElement = null;
    backdropElement = null;
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
