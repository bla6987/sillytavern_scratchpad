import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/conversation.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');

function createHarness() {
    const timers = new Map();
    let timerId = 0;
    let browserFocused = true;
    const document = {
        hasFocus: () => browserFocused,
        createElement: tag => new Element(tag),
    };

    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.parentNode = null;
            this.style = {};
            this.value = '';
            this.selectionStart = 0;
            this.selectionEnd = 0;
            this.classList = { add() {}, remove() {}, toggle() {} };
        }

        get isConnected() {
            return this === document.body || !!this.parentNode?.isConnected;
        }

        contains(element) {
            return this === element || this.children.some(child => child.contains(element));
        }

        set innerHTML(value) {
            if (this !== document.activeElement && this.contains(document.activeElement)) {
                document.activeElement = document.body;
            }
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
        }

        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        querySelector(selector) {
            for (const child of this.children) {
                if (selector.startsWith('#') && child.id === selector.slice(1)) return child;
                const match = child.querySelector(selector);
                if (match) return match;
            }
            return null;
        }

        addEventListener() {}
        focus() { document.activeElement = this; }
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }
    }

    document.body = new Element('body');
    document.activeElement = document.body;
    const container = document.body.appendChild(new Element('div'));
    const otherInput = document.body.appendChild(new Element('textarea'));
    const thread = { id: 'thread-1', name: 'Test', messages: [] };
    const context = vm.createContext({
        document,
        setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        getConversationContainer: () => container,
        getThreadForCurrentBranch: () => thread,
        getDraft: () => 'draft text',
        NEW_THREAD_DRAFT_KEY: 'new-thread',
        createButton: () => new Element('button'),
        Icons: {},
        isPinnedMode: () => false,
        debounce: callback => callback,
    });
    vm.runInContext(`${source}
        renderContextOptions = () => {};
        renderMessageQueue = () => {};
        updateSendButtonMode = () => {};
        scrollToBottom = () => {};
        setupViewportHandlers = () => {};
        renderBranchedMessages = () => {};
        createMessageElement = () => document.createElement('div');
    `, context);

    return {
        context, document, container, otherInput, thread,
        get input() { return container.querySelector('#sp-message-input'); },
        set browserFocused(value) { browserFocused = value; },
        open() { context.openThread(thread.id); },
        flushTimers() {
            const callbacks = [...timers.values()];
            timers.clear();
            callbacks.forEach(callback => callback());
        },
        finish() {
            thread.messages.push({ id: 'reply', role: 'assistant', status: 'complete' });
            context.refreshConversation();
        },
    };
}

test('finishing a reply preserves focus in the main chat or another editor', () => {
    const h = createHarness();
    h.open();
    h.flushTimers();
    h.otherInput.focus();
    h.finish();
    h.flushTimers();
    assert.equal(h.document.activeElement, h.otherInput);
});

test('finishing a transferred popup reply preserves focus elsewhere', () => {
    const h = createHarness();
    h.open();
    h.flushTimers();
    h.otherInput.focus();
    h.context.finishTransferredGeneration(h.thread.id);
    h.flushTimers();
    assert.equal(h.document.activeElement, h.otherInput);
});

test('refresh keeps the Scratch Pad draft and selection when already typing there', () => {
    const h = createHarness();
    h.open();
    h.flushTimers();
    const oldInput = h.input;
    oldInput.setSelectionRange(2, 5);
    h.finish();
    h.flushTimers();
    assert.notEqual(h.input, oldInput);
    assert.equal(h.document.activeElement, h.input);
    assert.equal(h.input.value, 'draft text');
    assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [2, 5]);
});

test('explicitly opening a thread or a new thread still focuses the input', () => {
    const h = createHarness();
    h.open();
    h.flushTimers();
    assert.equal(h.document.activeElement, h.input);
    h.context.startNewThread();
    h.flushTimers();
    assert.equal(h.document.activeElement, h.input);
});

test('opening delay does not override a move to another field', () => {
    const h = createHarness();
    h.open();
    h.otherInput.focus();
    h.flushTimers();
    assert.equal(h.document.activeElement, h.otherInput);
});

test('refresh cancels an older opening focus timer', () => {
    const h = createHarness();
    h.open();
    h.finish();
    h.otherInput.focus();
    h.flushTimers();
    assert.equal(h.document.activeElement, h.otherInput);
});

test('opening delay does not focus a closed view or an inactive browser', () => {
    const h = createHarness();
    h.open();
    h.container.parentNode = null;
    h.flushTimers();
    assert.equal(h.document.activeElement, h.document.body);

    const inactive = createHarness();
    inactive.open();
    inactive.browserFocused = false;
    inactive.flushTimers();
    assert.equal(inactive.document.activeElement, inactive.document.body);
});
