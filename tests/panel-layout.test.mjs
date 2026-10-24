import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/panelLayout.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

class Element {
    constructor() {
        this.listeners = new Map();
        this.attributes = new Map();
        this.classes = new Set();
        this.properties = new Map();
        this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
        this.style = { setProperty: (name, value) => this.properties.set(name, value), removeProperty: name => this.properties.delete(name) };
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    appendChild(child) { this.child = child; }
    remove() { this.removed = true; }
    focus() {}
    setPointerCapture(id) { this.pointer = id; }
    hasPointerCapture(id) { return this.pointer === id; }
    releasePointerCapture() { this.pointer = null; }
    fire(name, data = {}) {
        const event = { button: 0, isPrimary: true, pointerId: 1, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...data };
        this.listeners.get(name)?.(event);
        return event;
    }
}

function harness({ width = 1440, preferred = 400, mode = 'pinned', moving = false } = {}) {
    const settings = { panelWidth: preferred, displayMode: mode };
    const body = new Element();
    const drawer = new Element();
    drawer.id = 'scratch-pad-drawer';
    if (moving) body.classes.add('movingUI');
    const window = new Element();
    window.innerWidth = width;
    window.matchMedia = () => ({ matches: window.innerWidth <= 480 });
    const writes = [];
    const modes = [];
    let observer;
    const context = vm.createContext({
        window, document: { body, createElement: () => new Element() },
        getSettings: () => settings,
        getDisplayMode: () => settings.displayMode,
        updateSettings: update => { writes.push(update); Object.assign(settings, update); },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; observer = this; }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
    });
    vm.runInContext(source, context);
    const layout = context.createPanelLayout(drawer, docked => modes.push(docked));
    layout.update();
    return {
        context, drawer, handle: drawer.child, layout, settings, writes, body, window, modes,
        resize(width) { window.innerWidth = width; layout.update(); },
        moving(enabled) { if (enabled) body.classes.add('movingUI'); else body.classes.delete('movingUI'); observer.callback(); },
        observer: () => observer,
        width: () => Number(drawer.properties.get('--sp-drawer-width').replace('px', '')),
    };
}

test('pinned dimensions preserve a usable chat and gap, including at the breakpoint', () => {
    const h = harness({ preferred: 2000 });
    assert.equal(h.width(), 948);
    assert.equal(h.body.properties.get('--sp-panel-reserved'), '960px');
    assert.equal(1440 - 960, 480);
    h.resize(1001);
    assert.equal(h.width(), 509);
    assert.equal(h.modes.at(-1), true);
    h.resize(1000);
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.has('--sp-panel-reserved'), false);
});

test('viewport clamping and phone fallback never overwrite the preferred desktop width', () => {
    const h = harness({ preferred: 800 });
    h.resize(600);
    assert.equal(h.width(), 552);
    h.resize(390);
    assert.equal(h.width(), 390);
    assert.equal(h.handle.hidden, true);
    h.resize(1440);
    assert.equal(h.width(), 800);
    assert.equal(h.handle.hidden, false);
    assert.equal(h.settings.panelWidth, 800);
    assert.equal(h.writes.length, 0);
});

test('invalid saved widths are bounded and recover to the default without writes', () => {
    for (const preferred of [NaN, Infinity, 'huge', null, undefined]) {
        assert.equal(harness({ preferred }).width(), 400);
    }
    assert.equal(harness({ preferred: -100 }).width(), 300);
});

test('dragging stays on the handle and saves once on release, then survives reopening', () => {
    const h = harness();
    const down = h.handle.fire('pointerdown', { clientX: 1040 });
    assert.equal(down.prevented, true);
    assert.equal(down.stopped, true);
    assert.equal(h.handle.hasPointerCapture(1), true);
    h.handle.fire('pointermove', { clientX: 940 });
    h.handle.fire('pointermove', { clientX: 840 });
    assert.equal(h.width(), 600);
    assert.equal(h.writes.length, 0);
    h.handle.fire('pointerup');
    assert.equal(h.writes.length, 1);
    assert.equal(h.settings.panelWidth, 600);
    assert.equal(h.body.classes.has('sp-panel-resizing'), false);
    assert.equal(h.handle.hasPointerCapture(1), false);
    h.layout.dispose();
    assert.equal(harness({ preferred: h.settings.panelWidth }).width(), 600);
});

test('only the primary pointer may resize; unrelated pointers and phone drags do nothing', () => {
    const h = harness();
    h.handle.fire('pointerdown', { button: 2, clientX: 1040 });
    h.handle.fire('pointermove', { clientX: 500 });
    assert.equal(h.width(), 400);
    h.handle.fire('pointerdown', { isPrimary: false, clientX: 1040 });
    assert.equal(h.body.classes.has('sp-panel-resizing'), false);
    h.handle.fire('pointerdown', { clientX: 1040 });
    h.handle.fire('pointermove', { pointerId: 2, clientX: 500 });
    assert.equal(h.width(), 400);
    h.handle.fire('pointercancel');
    h.resize(390);
    h.handle.fire('pointerdown', { clientX: 0 });
    assert.equal(h.body.classes.has('sp-panel-resizing'), false);
});

for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'dispose', 'phone']) {
    test(`${cancellation} releases dragging without saving an unfinished width`, () => {
        const h = harness();
        h.handle.fire('pointerdown', { clientX: 1040 });
        h.handle.fire('pointermove', { clientX: 840 });
        if (cancellation === 'Escape') {
            const event = h.handle.fire('keydown', { key: 'Escape' });
            assert.equal(event.prevented, true, 'Escape must not close the drawer');
        } else if (cancellation === 'blur') h.window.fire('blur');
        else if (cancellation === 'dispose') h.layout.dispose();
        else if (cancellation === 'phone') h.resize(390);
        else h.handle.fire(cancellation);
        assert.equal(h.writes.length, 0);
        assert.equal(h.body.classes.has('sp-panel-resizing'), false);
        assert.equal(h.handle.hasPointerCapture(1), false);
        if (cancellation !== 'dispose') {
            h.resize(1440);
            assert.equal(h.width(), 400);
        }
    });
}

test('keyboard resizing exposes limits and supports reset', () => {
    const h = harness();
    h.handle.fire('keydown', { key: 'ArrowLeft' });
    assert.equal(h.width(), 410);
    h.handle.fire('keydown', { key: 'ArrowRight', shiftKey: true });
    assert.equal(h.width(), 360);
    h.handle.fire('keydown', { key: 'Home' });
    assert.equal(h.width(), 300);
    h.handle.fire('keydown', { key: 'End' });
    assert.equal(h.width(), 948);
    assert.equal(h.handle.attributes.get('aria-valuenow'), '948');
    assert.equal(h.handle.attributes.get('aria-valuemax'), '948');
    h.handle.fire('dblclick');
    assert.equal(h.width(), 400);
    assert.equal(h.settings.panelWidth, 400);
});

test('Moving UI and overlay mode release the reserved strip and automatically restore docking', () => {
    const h = harness();
    h.moving(true);
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.has('--sp-panel-reserved'), false);
    h.moving(false);
    assert.equal(h.modes.at(-1), true);
    h.settings.displayMode = 'drawer';
    h.layout.update();
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.has('--sp-panel-reserved'), false);
    assert.equal(h.writes.length, 0);
    h.layout.dispose();
    assert.equal(h.observer().disconnected, true);
    assert.equal(h.window.listeners.has('blur'), false);
    assert.equal(h.handle.removed, true);
});

test('switching out of fullscreen renders into the drawer while the old overlay fades out', () => {
    const uiSource = fs.readFileSync(new URL('../src/ui/index.js', import.meta.url), 'utf8')
        .replace(/^import .*;$/gm, '')
        .replace(/^export \{[^}]*\}(?: from '[^']*')?;$/gm, '')
        .replace(/^export /gm, '');
    const fullscreen = { name: 'fullscreen conversation' };
    const drawer = { name: 'drawer conversation' };
    const context = vm.createContext({
        document: {
            querySelector: () => fullscreen,
            getElementById: () => ({ querySelector: () => drawer }),
        },
    });
    vm.runInContext(uiSource, context);
    vm.runInContext("currentDisplayMode = 'fullscreen'", context);
    assert.equal(context.getConversationContainer(), fullscreen);
    // Both DOM trees still exist during the old overlay's 350ms exit transition.
    vm.runInContext("currentDisplayMode = 'drawer'", context);
    assert.equal(context.getConversationContainer(), drawer);
    vm.runInContext("currentDisplayMode = 'pinned'", context);
    assert.equal(context.getConversationContainer(), drawer);
});
