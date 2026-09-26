import assert from 'node:assert/strict';

// messageQueue.js has no imports and no SillyTavern/DOM access, so it loads under plain node.
const {
    enqueueMessage,
    getQueuedMessages,
    getQueueLength,
    dequeueNextMessage,
    removeQueuedMessage,
    takeQueuedMessages,
    clearMessageQueue,
} = await import(new URL('../src/messageQueue.js', import.meta.url));

/* ---- FIFO order across threads ---- */
{
    clearMessageQueue();
    enqueueMessage('a', 'first');
    enqueueMessage('b', 'second');
    enqueueMessage('a', 'third');
    assert.equal(getQueueLength(), 3);
    assert.equal(dequeueNextMessage().content, 'first');
    assert.equal(dequeueNextMessage().content, 'second');
    assert.equal(dequeueNextMessage().content, 'third');
    assert.equal(dequeueNextMessage(), null); // empty → null
    assert.equal(getQueueLength(), 0);
}

/* ---- enqueue returns the entry; ids are unique ---- */
{
    clearMessageQueue();
    const one = enqueueMessage('a', 'x');
    const two = enqueueMessage('a', 'x');
    assert.deepEqual({ threadId: one.threadId, content: one.content }, { threadId: 'a', content: 'x' });
    assert.equal(typeof one.id, 'string');
    assert.notEqual(one.id, two.id);
}

/* ---- getQueuedMessages filters by thread and returns a copy ---- */
{
    clearMessageQueue();
    enqueueMessage('a', 'a1');
    enqueueMessage('b', 'b1');
    enqueueMessage('a', 'a2');
    const forA = getQueuedMessages('a');
    assert.deepEqual(forA.map(e => e.content), ['a1', 'a2']);
    assert.deepEqual(getQueuedMessages('missing'), []);
    forA.pop();
    assert.equal(getQueuedMessages('a').length, 2); // mutating the result leaves the queue alone
    assert.equal(getQueueLength(), 3);
}

/* ---- takeQueuedMessages removes only that thread, others keep order ---- */
{
    clearMessageQueue();
    enqueueMessage('a', 'a1');
    enqueueMessage('b', 'b1');
    enqueueMessage('a', 'a2');
    enqueueMessage('c', 'c1');
    enqueueMessage('b', 'b2');
    const taken = takeQueuedMessages('a');
    assert.deepEqual(taken.map(e => e.content), ['a1', 'a2']);
    assert.deepEqual(getQueuedMessages('a'), []);
    const rest = [];
    let next;
    while ((next = dequeueNextMessage())) rest.push(next.content);
    assert.deepEqual(rest, ['b1', 'c1', 'b2']);
    assert.deepEqual(takeQueuedMessages('a'), []); // nothing left → empty
}

/* ---- removeQueuedMessage by id ---- */
{
    clearMessageQueue();
    const keep = enqueueMessage('a', 'keep');
    const drop = enqueueMessage('a', 'drop');
    enqueueMessage('b', 'other');
    assert.equal(removeQueuedMessage(drop.id), drop);
    assert.equal(removeQueuedMessage(drop.id), null); // already gone
    assert.equal(removeQueuedMessage('nope'), null);
    assert.deepEqual(getQueuedMessages('a'), [keep]);
    assert.equal(getQueueLength(), 2);
}

/* ---- clearMessageQueue ---- */
{
    enqueueMessage('a', 'x');
    clearMessageQueue();
    assert.equal(getQueueLength(), 0);
    assert.equal(dequeueNextMessage(), null);
}

console.log('message-queue tests passed');
