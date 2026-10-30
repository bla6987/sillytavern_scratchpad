/** Scratch Pad resizes only its own overlay and leaves SillyTavern's layout alone. */
import { getSettings, updateSettings, getDisplayMode } from '../settings.js';

export const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 300;
// SillyTavern switches its native drawers and chat to a mobile layout at 1000px.
const PIN_BREAKPOINT = 1000;

export function getPanelGeometry(viewportWidth, preferredWidth, { mobile = false, pinned = false, movingUI = false, toolbarRects = [] } = {}) {
    const isPinned = pinned && !movingUI && !mobile && viewportWidth > PIN_BREAKPOINT;
    const maxWidth = mobile ? viewportWidth : Math.max(0, Math.floor(viewportWidth - 48));
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    const requested = Number.isFinite(preferredWidth) ? preferredWidth : DEFAULT_PANEL_WIDTH;
    const width = mobile ? viewportWidth : Math.round(Math.min(maxWidth, Math.max(minWidth, requested)));
    // The centered toolbar often ends before the panel begins. Reserve vertical
    // space only when it actually covers part of the panel's horizontal span.
    const top = isPinned ? toolbarRects.reduce((offset, rect) => {
        const overlaps = rect.width > 0 && rect.height > 0 && rect.right > viewportWidth - width && rect.left < viewportWidth;
        return overlaps ? Math.max(offset, Math.ceil(rect.bottom)) : offset;
    }, 0) : 0;
    return { width, minWidth, maxWidth, top, pinned: isPinned };
}

/**
 * Attach an accessible left-edge splitter. Dispose before removing the drawer.
 * @param {HTMLElement} drawer
 * @param {(pinned: boolean) => void} onModeChange
 */
export function createPanelLayout(drawer, onModeChange) {
    let preferredWidth = getSettings().panelWidth;
    let geometry;
    let drag = null;
    let disposed = false;
    let movingUI = document.body.classList.contains('movingUI');
    const toolbars = [...document.querySelectorAll('#top-bar, #top-settings-holder')];
    const handle = document.createElement('div');
    handle.className = 'sp-panel-resize-handle';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', 'Resize Scratch Pad');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-controls', drawer.id);
    handle.title = 'Drag to resize. Use arrow keys to adjust; double-click to reset.';
    drawer.appendChild(handle);

    function update() {
        if (disposed) return;
        const mobile = window.matchMedia('(max-width: 30rem)').matches;
        geometry = getPanelGeometry(window.innerWidth, preferredWidth, {
            mobile,
            pinned: getDisplayMode() === 'pinned',
            movingUI: document.body.classList.contains('movingUI'),
            toolbarRects: toolbars.map(toolbar => toolbar.getBoundingClientRect()),
        });
        if (mobile && drag) cancelDrag();
        drawer.style.setProperty('--sp-drawer-width', `${geometry.width}px`);
        drawer.style.setProperty('--sp-panel-top', `${geometry.top}px`);
        handle.hidden = mobile;
        handle.setAttribute('aria-valuemin', String(geometry.minWidth));
        handle.setAttribute('aria-valuemax', String(geometry.maxWidth));
        handle.setAttribute('aria-valuenow', String(geometry.width));
        handle.setAttribute('aria-valuetext', `${geometry.width} pixels wide`);
        onModeChange(geometry.pinned);
    }

    function saveWidth() {
        // Save only on completion, never on each pointer movement or viewport resize.
        if (getSettings().panelWidth !== preferredWidth) updateSettings({ panelWidth: preferredWidth });
    }

    function setWidth(width) {
        preferredWidth = Math.min(geometry.maxWidth, Math.max(geometry.minWidth, Math.round(width)));
        update();
    }

    function finishDrag(commit) {
        if (!drag) return;
        const { pointerId, previousWidth } = drag;
        drag = null;
        drawer.classList.remove('sp-resizing');
        document.body.classList.remove('sp-panel-resizing');
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (commit) saveWidth();
        else {
            preferredWidth = previousWidth;
            update();
        }
    }

    function cancelDrag() { finishDrag(false); }

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.isPrimary || handle.hidden || drag) return;
        event.preventDefault();
        event.stopPropagation();
        handle.focus({ preventScroll: true });
        drag = { pointerId: event.pointerId, x: event.clientX, width: geometry.width, previousWidth: preferredWidth };
        handle.setPointerCapture(event.pointerId);
        drawer.classList.add('sp-resizing');
        document.body.classList.add('sp-panel-resizing');
    });
    handle.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        setWidth(drag.width + drag.x - event.clientX);
    });
    handle.addEventListener('pointerup', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        finishDrag(true);
    });
    handle.addEventListener('pointercancel', cancelDrag);
    handle.addEventListener('lostpointercapture', cancelDrag);
    handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setWidth(DEFAULT_PANEL_WIDTH);
        saveWidth();
    });
    handle.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && drag) {
            event.preventDefault();
            event.stopPropagation();
            cancelDrag();
            return;
        }
        const step = event.shiftKey ? 50 : 10;
        const width = {
            ArrowLeft: geometry.width + step,
            ArrowRight: geometry.width - step,
            Home: geometry.minWidth,
            End: geometry.maxWidth,
        }[event.key];
        if (width === undefined || drag) return;
        event.preventDefault();
        event.stopPropagation();
        setWidth(width);
        saveWidth();
    });
    window.addEventListener('blur', cancelDrag);

    // Moving UI can be toggled while Scratch Pad is open. Do not observe our own
    // classes as layout changes, which would cause a feedback loop while dragging.
    const observer = new MutationObserver(() => {
        const nextMovingUI = document.body.classList.contains('movingUI');
        if (nextMovingUI === movingUI) return;
        movingUI = nextMovingUI;
        cancelDrag();
        update();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // Theme font/chat-width changes can resize the toolbar without a window resize.
    const toolbarObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    toolbars.forEach(toolbar => toolbarObserver?.observe(toolbar));

    return {
        update,
        dispose() {
            cancelDrag();
            disposed = true;
            observer.disconnect();
            toolbarObserver?.disconnect();
            window.removeEventListener('blur', cancelDrag);
            handle.remove();
            document.body.classList.remove('sp-panel-resizing');
        },
    };
}
