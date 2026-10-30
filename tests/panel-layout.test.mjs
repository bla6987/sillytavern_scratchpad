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

function harness({ width = 1440, preferred = 400, mode = 'pinned', moving = false, toolbarRects = [] } = {}) {
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
    let toolbarObserver;
    const toolbars = toolbarRects.map(rect => ({ getBoundingClientRect: () => rect }));
    const context = vm.createContext({
        window, document: { body, createElement: () => new Element(), querySelectorAll: () => toolbars },
        getSettings: () => settings,
        getDisplayMode: () => settings.displayMode,
        updateSettings: update => { writes.push(update); Object.assign(settings, update); },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; observer = this; }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; toolbarObserver = this; this.targets = []; }
            observe(target) { this.targets.push(target); }
            disconnect() { this.disconnected = true; }
        },
    });
    vm.runInContext(source, context);
    const layout = context.createPanelLayout(drawer, pinned => modes.push(pinned));
    layout.update();
    return {
        context, drawer, handle: drawer.child, layout, settings, writes, body, window, modes,
        resize(width) { window.innerWidth = width; layout.update(); },
        moving(enabled) { if (enabled) body.classes.add('movingUI'); else body.classes.delete('movingUI'); observer.callback(); },
        observer: () => observer,
        toolbarObserver: () => toolbarObserver,
        top: () => Number(drawer.properties.get('--sp-panel-top').replace('px', '')),
        width: () => Number(drawer.properties.get('--sp-drawer-width').replace('px', '')),
    };
}

test('pinned overlay fits the viewport without reserving space in the host layout', () => {
    const h = harness({ preferred: 2000 });
    assert.equal(h.width(), 1392);
    assert.equal(h.body.properties.size, 0);
    h.resize(1001);
    assert.equal(h.width(), 953);
    assert.equal(h.modes.at(-1), true);
    h.resize(1000);
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.size, 0);
});

test('pinned panel starts at the top when the centered toolbar leaves the side clear', () => {
    const h = harness({ width: 1920, toolbarRects: [{ left: 480, right: 1440, width: 960, height: 35, bottom: 35 }] });
    assert.equal(h.top(), 0);
    h.handle.fire('keydown', { key: 'End' });
    assert.equal(h.top(), 35, 'widening the panel into the toolbar reserves its height');
    h.handle.fire('dblclick');
    assert.equal(h.top(), 0, 'shrinking back into the side gutter removes the gap');
});

test('toolbar overlap follows viewport and theme changes without changing the host layout', () => {
    const bar = { left: 360, right: 1080, width: 720, height: 35, bottom: 35 };
    const h = harness({ toolbarRects: [bar] });
    assert.equal(h.top(), 35);
    assert.equal(h.toolbarObserver().targets.length, 1);
    h.resize(1920);
    assert.equal(h.top(), 0);
    Object.assign(bar, { right: 1700, width: 1340, height: 52.5, bottom: 52.5 });
    h.toolbarObserver().callback();
    assert.equal(h.top(), 53);
    assert.equal(h.body.properties.size, 0);
    h.settings.displayMode = 'drawer';
    h.layout.update();
    assert.equal(h.top(), 0, 'modal overlay does not reserve toolbar space');
    h.settings.displayMode = 'pinned';
    h.moving(true);
    assert.equal(h.top(), 0, 'Moving UI uses the modal overlay');
    h.moving(false);
    assert.equal(h.top(), 53);
    h.layout.dispose();
    assert.equal(h.toolbarObserver().disconnected, true);
});

test('hidden, offscreen, and exactly adjacent toolbars leave no empty strip', () => {
    const getTop = toolbarRects => harness({ width: 1920, toolbarRects }).top();
    assert.equal(getTop([{ left: 0, right: 0, width: 0, height: 0, bottom: 0 }]), 0);
    assert.equal(getTop([{ left: 1920, right: 2200, width: 280, height: 40, bottom: 40 }]), 0);
    assert.equal(getTop([{ left: 480, right: 1520, width: 1040, height: 40, bottom: 40 }]), 0);
    assert.equal(getTop([
        { left: 480, right: 1530, width: 1050, height: 35, bottom: 35 },
        { left: 480, right: 1530, width: 1050, height: 42, bottom: 42 },
    ]), 42);
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
    assert.equal(h.width(), 1392);
    assert.equal(h.handle.attributes.get('aria-valuenow'), '1392');
    assert.equal(h.handle.attributes.get('aria-valuemax'), '1392');
    h.handle.fire('dblclick');
    assert.equal(h.width(), 400);
    assert.equal(h.settings.panelWidth, 400);
});

test('Moving UI and drawer fallback preserve body styles and restore pinning', () => {
    const h = harness();
    h.moving(true);
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.size, 0);
    h.moving(false);
    assert.equal(h.modes.at(-1), true);
    h.settings.displayMode = 'drawer';
    h.layout.update();
    assert.equal(h.modes.at(-1), false);
    assert.equal(h.body.properties.size, 0);
    assert.equal(h.writes.length, 0);
    h.layout.dispose();
    assert.equal(h.observer().disconnected, true);
    assert.equal(h.window.listeners.has('blur'), false);
    assert.equal(h.handle.removed, true);
});

test('resizing and closing change only Scratch Pad dimensions', () => {
    for (const mode of ['pinned', 'drawer']) {
        const h = harness({ mode });
        h.body.style.setProperty('margin-right', '17px');
        h.body.style.setProperty('--sheldWidth', '70vw');
        const original = new Map(h.body.properties);
        h.handle.fire('pointerdown', { clientX: 1040 });
        h.handle.fire('pointermove', { clientX: 840 });
        h.handle.fire('pointerup');
        h.handle.fire('keydown', { key: 'End' });
        h.handle.fire('dblclick');
        h.resize(600);
        h.resize(390);
        h.resize(1440);
        h.layout.dispose();
        assert.deepEqual(h.body.properties, original);
    }
});

test('extension CSS never overrides the main chat or toolbar layout', () => {
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /#(?:sheld|top-bar|top-settings-holder)\b|--sheldWidth\s*:|--sp-panel-reserved\b/);
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
