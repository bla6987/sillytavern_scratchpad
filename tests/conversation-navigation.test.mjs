import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/conversation.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');

function createHarness(mode) {
    const thread = {
        id: 'thread-a', name: 'Test', messages: [
            { id: 'user', role: 'user', content: 'Question', status: 'complete' },
            { id: 'reply', role: 'assistant', content: 'Old answer', status: mode === 'retry' ? 'failed' : 'complete' },
        ],
    };
    let viewedThread = thread.id;
    let content = { isConnected: true, textContent: 'Old answer' };
    const pendingId = mode === 'swipe' ? 'reply' : 'new-reply';
    let onStream;
    let finish;
    let redraws = 0;
    const container = {
        isConnected: true,
        classList: { contains: name => name === 'sp-conversation-view' && !!viewedThread },
        querySelector(selector) {
            if (selector === '.sp-message-assistant:last-child .sp-message-content') return viewedThread ? content : null;
            if (viewedThread !== thread.id || !selector.includes(`data-message-id="${pendingId}"`)) return null;
            if (selector.endsWith('.sp-message-content')) return content;
            return { querySelector: () => content, querySelectorAll: () => [] };
        },
    };
    const generate = (threadId, callback) => {
        assert.equal(threadId, thread.id, 'generation stays with its originating thread');
        onStream = callback;
        if (mode !== 'swipe') {
            thread.messages.splice(1);
            thread.messages.push({ id: pendingId, role: 'assistant', status: 'pending' });
        } else {
            thread.messages[1].status = 'pending';
        }
        return new Promise(resolve => { finish = resolve; });
    };
    const context = vm.createContext({
        document: { querySelector: selector => container.querySelector(selector) },
        getThread: id => id === thread.id ? thread : null,
        getMessage: (id, messageId) => id === thread.id ? thread.messages.find(message => message.id === messageId) : null,
        isGenerationActive: () => false,
        isPopupGenerationActive: () => false,
        generateScratchPadResponse: (message, threadId, callback) => generate(threadId, callback),
        generateSwipe: (threadId, messageId, callback) => generate(threadId, callback),
        retryMessage: (threadId, messageId, callback) => generate(threadId, callback),
        editUserMessageAndRegenerate: (threadId, messageId, text, callback) => generate(threadId, callback),
        parseThinking: text => ({ cleanedResponse: text }),
        renderMarkdown: text => `<p>${text}</p>`,
        createStreamingRenderer: (getElement, getText) => ({
            schedule() {
                const element = getElement();
                if (element?.isConnected) element.textContent = getText();
            },
            cancel() {},
        }),
        playCompletionSound() {},
        warmEmbeddings() {},
        showToast() {},
        countRedraw: () => redraws++,
        container,
    });
    vm.runInContext(`${source}
        currentThreadId = 'thread-a';
        conversationContainer = container;
        refreshConversation = () => countRedraw();
        updateSwipeDisplay = () => countRedraw();
        showGeneratingIndicator = () => {};
        scrollToBottom = () => {};
        updateSendButtonMode = () => {};
        advanceMessageQueue = () => {};
    `, context);

    return {
        context,
        get content() { return content; },
        get redraws() { return redraws; },
        start() {
            if (mode === 'send') return context.sendMessageToThread(thread.id, 'Question');
            if (mode === 'swipe') return context.handleGenerateSwipe('reply');
            if (mode === 'retry') return context.handleRetry('reply');
            return context.submitEditedUserMessage('user', 'Edited question');
        },
        stream(text, complete = false) { onStream(text, complete); },
        navigate(threadId) {
            content.isConnected = false;
            content = { isConnected: true, textContent: threadId === thread.id ? 'loading dots' : 'Other thread' };
            viewedThread = threadId;
            context.destinationThread = threadId;
            vm.runInContext('currentThreadId = destinationThread;', context);
        },
        finish() {
            thread.messages.at(-1).status = 'complete';
            finish({ success: true, response: 'Finished response' });
        },
    };
}

for (const mode of ['send', 'retry', 'edit', 'swipe']) {
    test(`${mode} reconnects its stream after going back and reopening the thread`, async () => {
        const h = createHarness(mode);
        const generating = h.start();
        h.stream('First tokens');
        const oldContent = h.content;
        assert.equal(oldContent.textContent, 'First tokens');

        h.navigate(null);
        h.stream('Tokens while on the thread list');
        assert.equal(oldContent.textContent, 'First tokens');
        h.navigate('thread-b');
        const otherContent = h.content;
        h.stream('Tokens while in another thread');
        assert.equal(otherContent.textContent, 'Other thread');

        h.navigate('thread-a');
        const reopenedContent = h.content;
        h.stream('Resumed response');
        assert.equal(reopenedContent.textContent, 'Resumed response', 'replace loading dots in the new DOM');
        assert.equal(oldContent.textContent, 'First tokens', 'do not write to the removed element');
        h.stream('Finished response', true);
        assert.equal(reopenedContent.innerHTML, '<p>Finished response</p>');
        h.finish();
        await generating;
        assert.equal(h.context.isScratchPadGenerating(), false);
    });

    test(`${mode} finishing off screen does not redraw another thread`, async () => {
        const h = createHarness(mode);
        const generating = h.start();
        h.stream('First tokens');
        h.navigate('thread-b');
        const before = h.redraws;
        h.stream('Finished response', true);
        h.finish();
        await generating;
        assert.equal(h.redraws, before);
        assert.equal(h.content.textContent, 'Other thread');
        assert.equal(h.context.isScratchPadGenerating(), false);
    });
}
