import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

class FakeClassList {
    constructor() {
        this.values = new Set();
    }

    add(...names) {
        names.forEach(name => this.values.add(name));
    }

    remove(...names) {
        names.forEach(name => this.values.delete(name));
    }

    contains(name) {
        return this.values.has(name);
    }
}

class FakeElement {
    constructor(tagName, document) {
        this.tagName = tagName;
        this.ownerDocument = document;
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList();
        this.style = {
            setProperty: (name, value) => {
                this.style[name] = value;
            },
        };
        this.listeners = new Map();
        this.isConnected = false;
        this.textContent = '';
        this._innerHTML = '';
        this.id = '';
    }

    appendChild(child) {
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        return child;
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    async click() {
        return await this.listeners.get('click')?.({ target: this });
    }

    querySelector(selector) {
        return this.ownerDocument.find(this, element => {
            if (selector.startsWith('.')) {
                return element.className.split(/\s+/).includes(selector.slice(1));
            }
            return false;
        });
    }

    querySelectorAll() {
        return [];
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        }
        this.parentNode = null;
        this.isConnected = false;
    }

    set innerHTML(value) {
        this._innerHTML = value;
        this.children = [];
    }

    get innerHTML() {
        return this._innerHTML;
    }
}

function createDocument() {
    const document = {
        createElement: tagName => new FakeElement(tagName, document),
        find(root, predicate) {
            for (const child of root.children) {
                if (predicate(child)) return child;
                const nested = document.find(child, predicate);
                if (nested) return nested;
            }
            return null;
        },
        getElementById(id) {
            return document.find(document.documentElement, element => element.id === id);
        },
    };
    document.documentElement = new FakeElement('html', document);
    document.documentElement.isConnected = true;
    document.body = new FakeElement('body', document);
    document.body.isConnected = true;
    document.documentElement.appendChild(document.body);
    return document;
}

async function loadPopupModule(mocks) {
    const sourcePath = new URL('../src/ui/popup.js', import.meta.url);
    let code = fs.readFileSync(sourcePath, 'utf8');
    code = code.replace(/^import .*;$/gm, '');
    code = `
        const __popupTransferMocks = globalThis.__popupTransferMocks;
        const {
            createThread, saveMetadata, getThread,
            generateScratchPadResponse, generateRawPromptResponse, generateGeneralAskResponse,
            parseThinking, cancelGeneration, renderMarkdown, createStreamingRenderer,
            createButton, createSpinner, showToast, Icons, playCompletionSound,
            speakText, isTTSAvailable, getCurrentContextSettings,
            REASONING_STATE, normalizeReasoningMeta
        } = __popupTransferMocks;
        ${code}
    `;
    code = code.replaceAll("import('./index.js')", 'Promise.resolve(__popupTransferMocks)');
    code = code.replaceAll("import('./conversation.js')", 'Promise.resolve(__popupTransferMocks)');

    globalThis.__popupTransferMocks = mocks;
    try {
        return await import(`data:text/javascript,${encodeURIComponent(code)}`);
    } finally {
        delete globalThis.__popupTransferMocks;
    }
}

test('opening a generating popup in Scratch Pad transfers instead of cancelling', async () => {
    const document = createDocument();
    const originalDocument = globalThis.document;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.document = document;
    globalThis.requestAnimationFrame = callback => callback();

    let resolveGeneration;
    let cancelCalls = 0;
    const openedThreads = [];
    const finishedThreads = [];
    const mocks = {
        createThread: () => ({ id: 'thread-1' }),
        saveMetadata: async () => {},
        getThread: () => ({ name: 'Transferred thread' }),
        generateScratchPadResponse: () => new Promise(resolve => {
            resolveGeneration = resolve;
        }),
        generateRawPromptResponse: async () => ({ success: true, response: '' }),
        generateGeneralAskResponse: async () => ({ success: true, response: '' }),
        parseThinking: response => ({ cleanedResponse: response, thinking: '' }),
        cancelGeneration: () => {
            cancelCalls += 1;
        },
        renderMarkdown: value => value,
        createStreamingRenderer: () => ({ schedule() {}, cancel() {} }),
        createButton: ({ onClick }) => {
            const button = document.createElement('button');
            button.addEventListener('click', onClick);
            return button;
        },
        createSpinner: () => document.createElement('span'),
        showToast() {},
        Icons: { cancel: '', expand: '', speak: '', close: '', error: '' },
        playCompletionSound() {},
        speakText: async () => true,
        isTTSAvailable: () => false,
        getCurrentContextSettings: () => ({}),
        REASONING_STATE: { HIDDEN: 'hidden' },
        normalizeReasoningMeta: () => ({ state: '' }),
        openScratchPad: threadId => openedThreads.push(threadId),
        updateTransferredGeneration() {},
        finishTransferredGeneration: threadId => finishedThreads.push(threadId),
    };

    try {
        const popup = await loadPopupModule(mocks);
        const generationPromise = popup.showQuickPopup('Keep going');
        await Promise.resolve();

        const openButton = document.getElementById('sp-popup-open-btn');
        assert.ok(openButton, 'open button should exist during generation');
        assert.equal(openButton.style.display ?? '', '');

        await openButton.click();
        assert.equal(cancelCalls, 0, 'transferring must not cancel the active generation');
        assert.deepEqual(openedThreads, ['thread-1']);

        resolveGeneration({ success: true, response: 'Done', thinking: '', reasoningMeta: null });
        await generationPromise;
        await Promise.resolve();
        assert.deepEqual(finishedThreads, ['thread-1']);
    } finally {
        globalThis.document = originalDocument;
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
});
