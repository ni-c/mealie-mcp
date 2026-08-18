import { describe, expect, it } from 'vitest';

import {
  confirmationPrompt,
  ConfirmationStore,
  setResourceKey,
} from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('issues an unguessable token', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete_recipe:1');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(store.issue('delete_recipe:1')).not.toBe(token);
  });

  it('accepts the matching token exactly once', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete_recipe:1');
    expect(store.consume('delete_recipe:1', token)).toBe(true);
    expect(store.consume('delete_recipe:1', token)).toBe(false);
  });

  it('rejects a missing, wrong or foreign token', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete_recipe:1');
    expect(store.consume('delete_recipe:1', undefined)).toBe(false);
    expect(store.consume('delete_recipe:1', 'deadbeef')).toBe(false);
    // A confirmation for one recipe must never delete another.
    expect(store.consume('delete_recipe:2', token)).toBe(false);
    expect(store.consume('delete_recipe:1', token)).toBe(true);
  });

  it('rejects a token that never existed', () => {
    expect(new ConfirmationStore().consume('nothing', 'x')).toBe(false);
  });

  it('expires a token', async () => {
    const store = new ConfirmationStore(5);
    const token = store.issue('k');
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.consume('k', token)).toBe(false);
  });

  it('replaces the pending token when one is re-issued', () => {
    // A rejected confirmation re-prompts, and the stale token must stop working.
    const store = new ConfirmationStore();
    const first = store.issue('k');
    const second = store.issue('k');
    expect(store.consume('k', first)).toBe(false);
    expect(store.consume('k', second)).toBe(true);
  });

  it('bounds the pending map so refused calls cannot grow it', () => {
    const store = new ConfirmationStore();
    const first = store.issue('key-0');
    for (let i = 1; i <= 100; i++) store.issue(`key-${i}`);
    expect(store.consume('key-0', first)).toBe(false);
    expect(store.consume('key-100', store.issue('key-100'))).toBe(true);
  });

  it('reports the TTL in whole minutes', () => {
    expect(new ConfirmationStore().ttlMinutes).toBe(5);
    expect(new ConfirmationStore(120_000).ttlMinutes).toBe(2);
  });
});

describe('setResourceKey', () => {
  it('is stable regardless of the order of the ids', () => {
    expect(setResourceKey('op', ['b', 'a'])).toBe(
      setResourceKey('op', ['a', 'b'])
    );
  });

  it('changes when an id is added, removed or swapped', () => {
    // Otherwise a confirmation for two items would also delete a third that the
    // model appended between the two calls.
    const base = setResourceKey('op', ['a', 'b']);
    expect(setResourceKey('op', ['a', 'b', 'c'])).not.toBe(base);
    expect(setResourceKey('op', ['a'])).not.toBe(base);
    expect(setResourceKey('op', ['a', 'x'])).not.toBe(base);
  });

  it('separates operations with the same targets', () => {
    expect(setResourceKey('delete', ['a'])).not.toBe(
      setResourceKey('merge', ['a'])
    );
  });
});

describe('confirmationPrompt', () => {
  it('names the token, the TTL and the single use', () => {
    const text = confirmationPrompt('delete the recipe with id 7', 'abc', 5);
    expect(text).toContain('confirm_token="abc"');
    expect(text).toContain('5 minutes');
    expect(text).toContain('once');
    expect(text).toContain('irreversible');
  });

  it('takes a different consequence sentence', () => {
    const text = confirmationPrompt(
      'share it',
      'abc',
      5,
      'This widens access.'
    );
    expect(text).toContain('This widens access.');
    expect(text).not.toContain('irreversible');
  });
});
