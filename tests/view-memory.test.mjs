import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { subscribeToViewport } from '../src/ui/viewportSubscription.js';

function source(path) {
    return fs.readFileSync(new URL(path, import.meta.url), 'utf8')
        .replace(/^import .*;$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '');
}

function environment() {
    class Element extends EventTarget {
        constructor(className = '') {
            super(); this.className = className; this.children = []; this.parent = null; this.style = { removeProperty() {}, setProperty() {} };
            this.classList = {
                contains: value => this.className.split(' ').includes(value),
                add: (...values) => { this.className += ` ${values.join(' ')}`; },
                remove: (...values) => { this.className = this.className.split(' ').filter(value => !values.includes(value)).join(' '); },
            };
        }
        appendChild(child) { child.parent = this; this.children.push(child); return child; }
        replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; children.forEach(child => this.appendChild(child)); }
        set innerHTML(_) { this.replaceChildren(); }
        get isConnected() { return this.root === true || !!this.parent?.isConnected; }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
        querySelector(selector) {
            for (const child of this.children) {
                if ((selector[0] === '#' && child.id === selector.slice(1)) || (selector[0] === '.' && child.classList.contains(selector.slice(1)))) return child;
                const found = child.querySelector(selector); if (found) return found;
            }
            return null;
        }
    }
    const body = new Element(); body.root = true;
    const host = new EventTarget(); host.visualViewport = new EventTarget(); host.visualViewport.height = 700;
    const document = { body, createElement: () => new Element(), querySelector: selector => body.querySelector(selector), getElementById: id => body.querySelector(`#${id}`) };
    const frames = new Map(), timers = new Map(); let next = 0;
    const globals = {
        console, Event, AbortController, document, window: host, subscribeToViewport,
        requestAnimationFrame: callback => { frames.set(++next, callback); return next; }, cancelAnimationFrame: id => frames.delete(id),
        setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
        clearDrafts() {}, clearMessageQueue() {}, prependToDraft() {}, closeMenu() {}, resetQueryCache() {},
        createButton: ({ text, onClick }) => { const button = new Element('button'); button.textContent = text; button.click = onClick; return button; },
    };
    return { Element, body, host, document, globals, frames, timers, flush() { for (const callback of [...timers.values()]) callback(); timers.clear(); } };
}

test('all drawer/fullscreen close paths release conversation and thread-list DOM across repeated use', () => {
    const env = environment();
    const conversation = vm.createContext({ ...env.globals });
    vm.runInContext(source('../src/ui/conversation.js'), conversation);
    const list = vm.createContext({ ...env.globals });
    vm.runInContext(source('../src/ui/threadList.js'), list);
    const ui = vm.createContext({ ...env.globals, disposeConversationView: conversation.disposeConversationView, resetThreadListState: list.resetThreadListState });
    vm.runInContext(source('../src/ui/index.js'), ui);
    for (const mode of ['drawer', 'fullscreen', 'drawer', 'fullscreen']) {
        const wrapper = new env.Element(mode === 'drawer' ? 'sp-drawer open' : 'sp-overlay visible');
        const content = new env.Element('sp-conversation-view');
        wrapper.appendChild(content); env.body.appendChild(wrapper);
        content.appendChild(new env.Element('sp-messages'));
        conversation.content = content;
        vm.runInContext('conversationContainer = content; _scrollContainer = content.children[0]; currentThreadId = "thread";', conversation);
        list.content = content;
        vm.runInContext('threadListContainer = content;', list);
        ui.wrapper = wrapper;
        vm.runInContext(mode === 'drawer' ? 'drawerElement = wrapper; currentDisplayMode = "drawer";' : 'overlayElement = wrapper; fullscreenElement = wrapper; currentDisplayMode = "fullscreen";', ui);
        ui.closeScratchPad(); env.flush();
        assert.equal(vm.runInContext('conversationContainer', conversation), null);
        assert.equal(vm.runInContext('_scrollContainer', conversation), null);
        assert.equal(vm.runInContext('cleanupFunctions.length', conversation), 0);
        assert.equal(vm.runInContext('threadListContainer', list), null);
        assert.equal(content.children.length, 0);
        assert.equal(env.body.children.length, 0);
    }
});

test('fixed history windows keep every message accessible without growing DOM', () => {
    const env = environment();
    const thread = { id: 'thread', messages: Array.from({ length: 123 }, (_, id) => ({ id })), branchedMessages: [] };
    const content = new env.Element();
    const messages = new env.Element(); messages.id = 'sp-messages'; content.appendChild(messages); env.body.appendChild(content);
    const context = vm.createContext({ ...env.globals, thread, content, messages, getThreadForCurrentBranch: () => thread,
        createMessage: message => { const element = new env.Element('sp-message'); element.messageId = message.id; return element; },
    });
    vm.runInContext(source('../src/ui/conversation.js'), context);
    vm.runInContext('createMessageElement = createMessage; conversationContainer = content; currentThreadId = thread.id; renderMessageWindow(thread, messages);', context);
    const visited = new Set();
    for (;;) {
        const shown = messages.children.filter(child => child.classList.contains('sp-message'));
        assert.ok(shown.length <= 50);
        shown.forEach(element => visited.add(element.messageId));
        const earlier = messages.children.find(child => child.textContent?.startsWith('Earlier'));
        if (!earlier) break;
        earlier.click();
    }
    assert.equal(visited.size, 123);
    while (messages.children.some(child => child.textContent?.startsWith('Newer'))) messages.children.find(child => child.textContent?.startsWith('Newer')).click();
    assert.equal(messages.children.filter(child => child.classList.contains('sp-message')).at(-1).messageId, 122);
});

test('collapsed off-branch history mounts no message DOM and expanded history is paged', () => {
    const env = environment();
    const thread = { id: 'thread', branchedMessages: Array.from({ length: 130 }, (_, id) => ({ id })) };
    const container = new env.Element();
    const context = vm.createContext({ ...env.globals, thread, container, getThreadForCurrentBranch: () => thread,
        createMessage: message => { const element = new env.Element('sp-message'); element.messageId = message.id; return element; },
    });
    vm.runInContext(source('../src/ui/conversation.js'), context);
    vm.runInContext('createMessageElement = createMessage; renderBranchedMessages(thread, container);', context);
    const details = container.children[0], content = details.children[1];
    assert.equal(content.children.length, 0);
    details.open = true; details.dispatchEvent(new Event('toggle'));
    const visited = new Set();
    for (;;) {
        const shown = content.children.filter(child => child.classList.contains('sp-message'));
        assert.ok(shown.length <= 50); shown.forEach(element => visited.add(element.messageId));
        const earlier = content.children.find(child => child.textContent?.startsWith('Earlier'));
        if (!earlier) break;
        earlier.click();
    }
    assert.equal(visited.size, 130);
    details.open = false; details.dispatchEvent(new Event('toggle'));
    assert.equal(content.children.length, 0);
});

test('viewport subscriptions work standalone, with an old partial bus, and with a valid bus', () => {
    for (const mode of ['none', 'partial', 'throws', 'invalid-return', 'valid']) {
        const host = new EventTarget(); host.visualViewport = new EventTarget();
        let forwarded, disposed = 0, calls = 0;
        if (mode !== 'none') host.STRuntimeBus = { viewport: {} };
        if (mode === 'partial') host.STRuntimeBus.viewport.subscribe = true;
        if (['throws', 'invalid-return', 'valid'].includes(mode)) host.STRuntimeBus.viewport.subscribe = (_mode, handler) => {
            forwarded = handler;
            if (mode === 'throws') throw new Error('Old bus');
            if (mode === 'valid') return () => { disposed++; };
        };
        const unsubscribe = subscribeToViewport('keyboard', () => calls++, host);
        host.visualViewport.dispatchEvent(new Event('resize'));
        forwarded?.();
        assert.equal(calls, 1, mode);
        unsubscribe();
        host.visualViewport.dispatchEvent(new Event('resize')); forwarded?.();
        assert.equal(calls, 1, mode);
        assert.equal(disposed, mode === 'valid' ? 1 : 0);
    }
});
