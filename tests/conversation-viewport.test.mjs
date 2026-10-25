import { subscribeToViewport } from '../src/ui/viewportSubscription.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/conversation.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function harness(fullscreen = false) {
    const properties = new Map();
    const handlers = new Map();
    const frames = [];
    const container = {
        isConnected: true,
        classList: { contains: name => name === (fullscreen ? 'sp-fullscreen' : 'sp-drawer') },
        style: {
            setProperty: (key, value, priority) => properties.set(key, { value, priority }),
            removeProperty: key => properties.delete(key),
        },
    };
    const viewport = {
        height: 720,
        addEventListener: (name, callback) => handlers.set(name, callback),
        removeEventListener: name => handlers.delete(name),
    };
    const context = vm.createContext({
        subscribeToViewport,
        document: { querySelector: selector => selector === (fullscreen ? '.sp-fullscreen' : '.sp-drawer') ? container : null },
        window: { visualViewport: viewport },
        requestAnimationFrame: callback => frames.push(callback),
    });
    vm.runInContext(`${source}\nscrollToBottom = () => {};`, context);
    context.setupViewportHandlers();
    return {
        context, properties, handlers,
        resize(height) {
            viewport.height = height;
            handlers.get('resize')();
            frames.splice(0).forEach(callback => callback());
        },
    };
}

test('keyboard viewport updates leave drawer height under the pinned/overlay CSS rules', () => {
    const h = harness();
    h.resize(480);
    assert.equal(h.properties.has('height'), false, 'do not override the toolbar offset with inline height');
    assert.equal(h.properties.get('--sp-viewport-height').value, '480px');
    h.resize(720);
    assert.equal(h.properties.has('height'), false);
    assert.equal(h.properties.get('--sp-viewport-height').value, '720px');
});

test('leaving a conversation removes its keyboard constraint and viewport listener', () => {
    const h = harness();
    h.resize(480);
    h.context.removeViewportHandler();
    assert.equal(h.properties.size, 0);
    assert.equal(h.handlers.size, 0);
});

test('fullscreen retains its existing viewport handling and resets on exit', () => {
    const h = harness(true);
    h.resize(480);
    assert.equal(h.properties.get('height').value, '480px');
    h.context.removeViewportHandler();
    assert.equal(h.properties.size, 0);
});

