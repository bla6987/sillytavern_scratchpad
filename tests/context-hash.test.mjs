import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Fallback, hashContextValue, newContextIdentity } from '../src/contextHash.js';

test('portable SHA-256 matches the native digest across padding boundaries and Unicode', () => {
    for (const text of ['', 'abc', 'Mira 🔑\n门', ...[55, 56, 63, 64, 65, 127, 10000].map(size => 'x'.repeat(size))]) {
        const bytes = new TextEncoder().encode(text);
        assert.equal(sha256Fallback(bytes), createHash('sha256').update(bytes).digest('hex'));
    }
});

test('HTTP/LAN fallback hashes identically and can create distinct identities without secure-context APIs', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const value = { text: 'Current story', entries: [0, 3] };
    const expected = await hashContextValue(value);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
        assert.equal(await hashContextValue(value), expected);
        assert.notEqual(newContextIdentity(), newContextIdentity());
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
    }
});
