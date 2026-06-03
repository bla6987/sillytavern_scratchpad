import test from 'node:test';
import assert from 'node:assert/strict';

import { copyTextToClipboard } from '../src/ui/components.js';

function setGlobal(name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
    });
    return () => {
        if (descriptor) {
            Object.defineProperty(globalThis, name, descriptor);
        } else {
            delete globalThis[name];
        }
    };
}

function createDocumentHarness() {
    let appended = null;
    let copiedText = null;

    class FakeHTMLElement {
        focus() {}
    }

    const activeElement = new FakeHTMLElement();
    let restoredFocus = false;
    activeElement.focus = () => {
        restoredFocus = true;
    };

    const body = {
        appendChild(element) {
            appended = element;
            element.parentNode = body;
        },
    };

    const document = {
        activeElement,
        body,
        querySelector: () => null,
        createElement(tagName) {
            assert.equal(tagName, 'textarea');
            return {
                value: '',
                style: {},
                setAttribute() {},
                focus() {},
                select() {
                    this.selected = true;
                },
                setSelectionRange(start, end) {
                    this.selectionRange = [start, end];
                },
                remove() {
                    if (appended === this) appended = null;
                },
            };
        },
        execCommand(command) {
            assert.equal(command, 'copy');
            assert.equal(appended.selected, true);
            copiedText = appended.value;
            return true;
        },
    };

    return {
        document,
        FakeHTMLElement,
        get copiedText() {
            return copiedText;
        },
        get appended() {
            return appended;
        },
        get restoredFocus() {
            return restoredFocus;
        },
    };
}

test('copyTextToClipboard falls back when Clipboard API rejects', async () => {
    const harness = createDocumentHarness();
    let clipboardCalls = 0;

    const restoreDocument = setGlobal('document', harness.document);
    const restoreHTMLElement = setGlobal('HTMLElement', harness.FakeHTMLElement);
    const restoreNavigator = setGlobal('navigator', {
        clipboard: {
            writeText: async () => {
                clipboardCalls += 1;
                throw new Error('denied');
            },
        },
    });
    const restoreSecureContext = setGlobal('isSecureContext', true);

    try {
        await copyTextToClipboard('fallback text');
    } finally {
        restoreSecureContext();
        restoreNavigator();
        restoreHTMLElement();
        restoreDocument();
    }

    assert.equal(clipboardCalls, 1);
    assert.equal(harness.copiedText, 'fallback text');
    assert.equal(harness.appended, null);
    assert.equal(harness.restoredFocus, true);
});

test('copyTextToClipboard skips Clipboard API outside secure contexts', async () => {
    const harness = createDocumentHarness();
    let clipboardCalls = 0;

    const restoreDocument = setGlobal('document', harness.document);
    const restoreHTMLElement = setGlobal('HTMLElement', harness.FakeHTMLElement);
    const restoreNavigator = setGlobal('navigator', {
        clipboard: {
            writeText: async () => {
                clipboardCalls += 1;
            },
        },
    });
    const restoreSecureContext = setGlobal('isSecureContext', false);

    try {
        await copyTextToClipboard('insecure text');
    } finally {
        restoreSecureContext();
        restoreNavigator();
        restoreHTMLElement();
        restoreDocument();
    }

    assert.equal(clipboardCalls, 0);
    assert.equal(harness.copiedText, 'insecure text');
});
