/**
 * UI module index for Scratch Pad extension
 * Exports all UI components and manages the drawer
 */

import { renderThreadList, refreshThreadList } from './threadList.js';
import { openThread, startNewThread, getCurrentThreadId, renderConversation } from './conversation.js';
import { showQuickPopup, showQuickPopupRaw, dismissPopup, isPopupVisible } from './popup.js';
import { getSettings, updateSettings, getDisplayMode, setDisplayMode } from '../settings.js';
import { Icons, createButton } from './components.js';

export { renderThreadList, refreshThreadList } from './threadList.js';
export { openThread, startNewThread, getCurrentThreadId } from './conversation.js';
export { showQuickPopup, showQuickPopupRaw, dismissPopup, isPopupVisible } from './popup.js';
export { isFullscreenMode, getConversationContainer };

let drawerElement = null;
let backdropElement = null;
let isPinned = false;
let keydownHandler = null;
let popstateHandler = null;
let resizeHandler = null;
let overlayElement = null;
let fullscreenElement = null;
let currentDisplayMode = null; // tracks active mode: 'drawer' | 'pinned' | 'fullscreen'

/**
 * Check if viewport is mobile width
 * @returns {boolean} True if mobile viewport
 */
function isMobileViewport() {
    return window.matchMedia('(max-width: 30rem)').matches;
}

/**
 * Check if currently in fullscreen mode
 * @returns {boolean} True if fullscreen mode is active
 */
function isFullscreenMode() {
    return currentDisplayMode === 'fullscreen';
}

/**
 * Get the conversation container for the current display mode
 * @returns {HTMLElement|null} The conversation content container
 */
function getConversationContainer() {
    const fullscreenMain = document.querySelector('.sp-fullscreen-main .sp-drawer-content');
    if (fullscreenMain) return fullscreenMain;
    const drawer = document.getElementById('scratch-pad-drawer');
    return drawer?.querySelector('.sp-drawer-content') || null;
}

/**
 * Create the scratch pad drawer element
 */
function createDrawer() {
    // Check if drawer exists in DOM (stale from previous load)
    const existingDrawer = document.getElementById('scratch-pad-drawer');
    if (existingDrawer) {
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

    const content = document.createElement('div');
    content.className = 'sp-drawer-content';
    drawerElement.appendChild(content);

    // Prevent body scroll when drawer is open (non-passive for iOS Safari)
    drawerElement.addEventListener('touchmove', (e) => {
        const target = e.target;
        const scrollableEl = target.closest('.sp-messages, .sp-thread-list, .sp-popup-content');
        if (!scrollableEl) {
            e.preventDefault();
        }
    }, { passive: false });

    document.body.appendChild(drawerElement);

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
 * Open the scratch pad in the configured display mode
 * @param {string} [threadId] Optional thread ID to open directly
 */
export function openScratchPad(threadId = null) {
    const mode = getDisplayMode();

    // Fullscreen mode (desktop only, falls back to drawer on mobile)
    if (mode === 'fullscreen' && !isMobileViewport()) {
        openFullscreen(threadId);
        return;
    }

    // Pinned mode (desktop only, falls back to drawer on mobile)
    const usePinned = mode === 'pinned' && !isMobileViewport();

    // Check if drawer exists AND is still in the DOM
    if (!drawerElement || !drawerElement.isConnected) {
        if (drawerElement && !drawerElement.isConnected) {
            drawerElement = null;
        }
        drawerElement = createDrawer();
    }

    const content = drawerElement.querySelector('.sp-drawer-content');

    if (!content) {
        console.error('[ScratchPad UI] No content element found in drawer');
        return;
    }

    // Prevent body scroll (unless pinned)
    document.body.classList.add('sp-drawer-open');

    isPinned = usePinned;
    currentDisplayMode = usePinned ? 'pinned' : 'drawer';

    if (isPinned) {
        document.body.classList.add('sp-drawer-pinned');
        drawerElement.classList.add('sp-pinned');
        hideBackdrop();
    } else {
        document.body.classList.remove('sp-drawer-pinned');
        drawerElement.classList.remove('sp-pinned');
        showBackdrop();
    }

    // Add open class to trigger CSS animation
    requestAnimationFrame(() => {
        drawerElement.classList.add('open');
        drawerElement.style.transform = 'translateX(0)';
    });

    // Render appropriate view
    try {
        if (threadId) {
            openThread(threadId);
        } else {
            renderThreadList(content);
        }
    } catch (err) {
        console.error('[ScratchPad UI] Failed to render drawer content:', err);
    }
}

/**
 * Create the fullscreen overlay and modal DOM
 */
function createFullscreen() {
    // Clean up any existing fullscreen elements
    document.getElementById('scratch-pad-overlay')?.remove();

    // Overlay (backdrop with blur)
    overlayElement = document.createElement('div');
    overlayElement.id = 'scratch-pad-overlay';
    overlayElement.className = 'sp-overlay';
    overlayElement.addEventListener('click', (e) => {
        if (e.target === overlayElement) {
            closeFullscreen();
        }
    });

    // Modal container
    fullscreenElement = document.createElement('div');
    fullscreenElement.id = 'scratch-pad-fullscreen';
    fullscreenElement.className = 'sp-fullscreen';

    // Header
    const header = document.createElement('div');
    header.className = 'sp-fullscreen-header';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'sp-title-container';

    const titleEl = document.createElement('h2');
    titleEl.className = 'sp-title';
    titleEl.textContent = 'Scratch Pad';
    titleContainer.appendChild(titleEl);

    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'sp-subtitle';
    subtitleEl.textContent = 'Out of Character';
    titleContainer.appendChild(subtitleEl);

    header.appendChild(titleContainer);

    const closeBtn = createButton({
        icon: Icons.close,
        className: 'sp-close-btn',
        ariaLabel: 'Close scratch pad',
        onClick: () => closeFullscreen()
    });
    header.appendChild(closeBtn);

    fullscreenElement.appendChild(header);

    // Body (split layout)
    const body = document.createElement('div');
    body.className = 'sp-fullscreen-body';

    // Sidebar (thread list)
    const sidebar = document.createElement('div');
    sidebar.className = 'sp-fullscreen-sidebar';
    const sidebarContent = document.createElement('div');
    sidebarContent.className = 'sp-drawer-content';
    sidebar.appendChild(sidebarContent);
    body.appendChild(sidebar);

    // Main (conversation)
    const main = document.createElement('div');
    main.className = 'sp-fullscreen-main';
    const mainContent = document.createElement('div');
    mainContent.className = 'sp-drawer-content';
    main.appendChild(mainContent);
    body.appendChild(main);

    fullscreenElement.appendChild(body);
    overlayElement.appendChild(fullscreenElement);
    document.body.appendChild(overlayElement);
}

/**
 * Open the fullscreen display mode
 * @param {string} [threadId] Optional thread ID to open directly
 */
function openFullscreen(threadId = null) {
    if (!overlayElement || !overlayElement.isConnected) {
        createFullscreen();
    }

    currentDisplayMode = 'fullscreen';
    document.body.classList.add('sp-fullscreen-open');

    // Show with animation
    overlayElement.style.display = 'block';
    // Force reflow before adding visible class for transition
    void overlayElement.offsetHeight;
    overlayElement.classList.add('visible');

    // Render thread list in sidebar
    const sidebarContent = overlayElement.querySelector('.sp-fullscreen-sidebar .sp-drawer-content');
    if (sidebarContent) {
        renderThreadList(sidebarContent);
    }

    // Render conversation or empty state in main
    const mainContent = overlayElement.querySelector('.sp-fullscreen-main .sp-drawer-content');
    if (mainContent) {
        if (threadId) {
            openThread(threadId);
        } else {
            showFullscreenEmptyState(mainContent);
        }
    }
}

/**
 * Show empty state in fullscreen main panel
 * @param {HTMLElement} container Main content container
 */
function showFullscreenEmptyState(container) {
    container.innerHTML = '';
    container.className = 'sp-drawer-content';
    const empty = document.createElement('div');
    empty.className = 'sp-fullscreen-empty';
    empty.innerHTML = `
        <div class="sp-empty-icon">${Icons.thread}</div>
        <p>Select a thread or start a new conversation</p>
    `;
    container.appendChild(empty);
}

/**
 * Close the fullscreen display
 */
function closeFullscreen() {
    if (!overlayElement) return;

    overlayElement.classList.remove('visible');
    document.body.classList.remove('sp-fullscreen-open');
    currentDisplayMode = null;

    // Remove after transition
    setTimeout(() => {
        if (overlayElement && !overlayElement.classList.contains('visible')) {
            overlayElement.remove();
            overlayElement = null;
            fullscreenElement = null;
        }
    }, 350);
}

/**
 * Close the scratch pad (any mode)
 */
export function closeScratchPad() {
    if (currentDisplayMode === 'fullscreen') {
        closeFullscreen();
        return;
    }

    if (!drawerElement) {
        return;
    }

    drawerElement.classList.remove('open');
    drawerElement.classList.remove('sp-pinned');
    drawerElement.style.transform = '';
    document.body.classList.remove('sp-drawer-open');
    document.body.classList.remove('sp-drawer-pinned');
    isPinned = false;
    currentDisplayMode = null;

    hideBackdrop();

    setTimeout(() => {
        if (drawerElement && !drawerElement.classList.contains('open')) {
            drawerElement.remove();
            drawerElement = null;
        }
    }, 350);
}

/**
 * Toggle the scratch pad drawer
 */
export function toggleScratchPad() {
    if (isScratchPadOpen()) {
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
    if (currentDisplayMode === 'fullscreen') {
        return overlayElement && overlayElement.classList.contains('visible');
    }
    return drawerElement && drawerElement.classList.contains('open');
}

/**
 * Refresh the scratch pad UI if open
 */
export function refreshScratchPadUI() {
    if (!isScratchPadOpen()) return;

    if (currentDisplayMode === 'fullscreen') {
        // Refresh sidebar thread list
        const sidebarContent = document.querySelector('.sp-fullscreen-sidebar .sp-drawer-content');
        if (sidebarContent) {
            renderThreadList(sidebarContent);
        }
        // Refresh main conversation if a thread is open
        const mainContent = document.querySelector('.sp-fullscreen-main .sp-drawer-content');
        const currentThread = getCurrentThreadId();
        if (mainContent && currentThread) {
            renderConversation(mainContent);
        }
        return;
    }

    const content = drawerElement?.querySelector('.sp-drawer-content');
    if (!content) return;

    const currentThread = getCurrentThreadId();

    if (currentThread) {
        renderConversation(content);
    } else {
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
    isPinned = false;
    document.body.classList.remove('sp-drawer-open');
    document.body.classList.remove('sp-drawer-pinned');
    document.body.classList.remove('sp-fullscreen-open');

    // Handle escape key to close (remove old listener first to prevent duplicates)
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
    keydownHandler = (e) => {
        if (e.key === 'Escape') {
            if (isPopupVisible()) {
                dismissPopup();
            } else if (isScratchPadOpen()) {
                closeScratchPad();
            }
        }
    };
    document.addEventListener('keydown', keydownHandler);

    // Handle back button on mobile
    if (popstateHandler) window.removeEventListener('popstate', popstateHandler);
    popstateHandler = () => {
        if (isPopupVisible()) {
            dismissPopup();
        } else if (isScratchPadOpen()) {
            closeScratchPad();
        }
    };
    window.addEventListener('popstate', popstateHandler);

    // Handle resize - force overlay mode on mobile even if pinned/fullscreen
    // Debounced with rAF to avoid layout thrashing on rapid resize events
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    let resizeRafId = null;
    let cachedIsMobile = isMobileViewport();
    resizeHandler = () => {
        if (resizeRafId !== null) return;
        resizeRafId = requestAnimationFrame(() => {
            resizeRafId = null;
            if (!isScratchPadOpen()) return;

            const nowMobile = isMobileViewport();
            // Only proceed if viewport mobile-ness actually changed or we need to check mode
            if (currentDisplayMode === 'fullscreen') {
                if (nowMobile) {
                    cachedIsMobile = nowMobile;
                    closeFullscreen();
                    // Reopen as drawer
                    currentDisplayMode = 'drawer';
                    openScratchPad();
                }
                return;
            }

            if (isPinned && nowMobile) {
                cachedIsMobile = nowMobile;
                isPinned = false;
                currentDisplayMode = 'drawer';
                document.body.classList.remove('sp-drawer-pinned');
                if (drawerElement) {
                    drawerElement.classList.remove('sp-pinned');
                }
                showBackdrop();
            } else if (!isPinned && !nowMobile) {
                const mode = getDisplayMode();
                if (mode === 'pinned') {
                    cachedIsMobile = nowMobile;
                    isPinned = true;
                    currentDisplayMode = 'pinned';
                    document.body.classList.add('sp-drawer-pinned');
                    if (drawerElement) {
                        drawerElement.classList.add('sp-pinned');
                    }
                    hideBackdrop();
                }
            }
        });
    };
    window.addEventListener('resize', resizeHandler);
}

/**
 * Dispose all UI resources (listeners, DOM elements, state)
 * Call on extension unload or hot-reload to prevent leaks.
 */
export function disposeUI() {
    // Close drawer if open
    if (drawerElement) {
        drawerElement.remove();
        drawerElement = null;
    }
    if (backdropElement) {
        backdropElement.remove();
        backdropElement = null;
    }
    if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
    }
    fullscreenElement = null;

    // Remove global event listeners
    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }
    if (popstateHandler) {
        window.removeEventListener('popstate', popstateHandler);
        popstateHandler = null;
    }
    if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
    }

    // Clean up body classes
    document.body.classList.remove('sp-drawer-open');
    document.body.classList.remove('sp-drawer-pinned');
    document.body.classList.remove('sp-fullscreen-open');
    isPinned = false;
    currentDisplayMode = null;
}

/**
 * Toggle pinned mode
 * @returns {boolean} New pinned state
 */
export function togglePinnedMode() {
    const currentMode = getDisplayMode();
    const newMode = currentMode === 'pinned' ? 'drawer' : 'pinned';
    setDisplayMode(newMode);

    if (isScratchPadOpen() && currentDisplayMode !== 'fullscreen') {
        isPinned = newMode === 'pinned' && !isMobileViewport();
        currentDisplayMode = isPinned ? 'pinned' : 'drawer';
        if (isPinned) {
            document.body.classList.add('sp-drawer-pinned');
            if (drawerElement) {
                drawerElement.classList.add('sp-pinned');
            }
            hideBackdrop();
        } else {
            document.body.classList.remove('sp-drawer-pinned');
            if (drawerElement) {
                drawerElement.classList.remove('sp-pinned');
            }
            showBackdrop();
        }
    }
    return isPinned;
}

/**
 * Check if drawer is currently in pinned mode
 * @returns {boolean} True if pinned
 */
export function isPinnedMode() {
    return isPinned;
}
