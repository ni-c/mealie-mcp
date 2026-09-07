import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { contentFingerprint, presentFields } from '../src/fingerprint.js';
import { cap, imageUrl, listFrom, paginationOf } from '../src/shape.js';

/**
 * Properties of the shaping and write-guard helpers.
 *
 * Two of these decide what a write does rather than how it reads.
 * `presentFields` separates "the caller did not mention this field" from "the
 * caller asked for it to be empty", and the file already says an empty array is
 * the most destructive value there is here, because it clears the list.
 * `contentFingerprint` is what a confirmation is bound to.
 *
 * The rest read a Mealie response, which arrives in two different envelope
 * shapes depending on the endpoint — the kind of thing a property covers and an
 * example only samples.
 */

const RUNS = { numRuns: 500 };

describe('a write says exactly what the caller asked for', () => {
  /**
   * The distinction the whole guard rests on: `undefined` means unmentioned and
   * must not travel; an empty array means "clear this" and must.
   */
  it('drops undefined and keeps every other value, empty ones included', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            name: fc.oneof(fc.string(), fc.constant(undefined)),
            tags: fc.oneof(fc.array(fc.string()), fc.constant(undefined)),
            note: fc.oneof(
              fc.string(),
              fc.constant(null),
              fc.constant(undefined)
            ),
          },
          { requiredKeys: [] }
        ),
        (fields) => {
          const present = presentFields(fields, ['name', 'tags', 'note']);
          for (const name of ['name', 'tags', 'note'] as const) {
            if (fields[name] === undefined) {
              expect(name in present).toBe(false);
            } else {
              expect(present[name]).toEqual(fields[name]);
            }
          }
        }
      ),
      RUNS
    );
  });

  it('an empty array survives, because clearing a list is a real request', () => {
    fc.assert(
      fc.property(fc.constantFrom('tags', 'tools', 'categories'), (name) => {
        const present = presentFields({ [name]: [] }, [name]);
        expect(present[name]).toEqual([]);
      }),
      RUNS
    );
  });

  it('never returns a field the caller did not name', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), fc.string(), {
          maxKeys: 4,
        }),
        fc.subarray(['a', 'b', 'c', 'd'] as const),
        (fields, names) => {
          const present = presentFields(
            fields,
            names as ('a' | 'b' | 'c' | 'd')[]
          );
          for (const key of Object.keys(present)) {
            expect(names).toContain(key);
          }
        }
      ),
      RUNS
    );
  });
});

describe('a confirmation is bound to the content it was shown', () => {
  /**
   * Key order must not matter — the caller's object literal is written in
   * whatever order the model produced — while any change to a value must.
   */
  it('is independent of key order but not of any value', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (first, second) => {
          expect(contentFingerprint({ a: first, b: second })).toBe(
            contentFingerprint({ b: second, a: first })
          );
          fc.pre(first !== second);
          expect(contentFingerprint({ a: first, b: second })).not.toBe(
            contentFingerprint({ a: second, b: first })
          );
        }
      ),
      RUNS
    );
  });

  it('changing one value changes the fingerprint', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        fc.pre(before !== after);
        expect(contentFingerprint({ note: before })).not.toBe(
          contentFingerprint({ note: after })
        );
      }),
      RUNS
    );
  });

  it('is always sixteen hex characters', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }),
        (values) => {
          expect(contentFingerprint(values)).toMatch(/^[0-9a-f]{16}$/);
        }
      ),
      RUNS
    );
  });
});

describe('responses are read in either envelope', () => {
  /**
   * Most list endpoints answer with a pagination envelope and a handful answer
   * with a bare array. A reader that knew only one would report an empty result
   * whenever the server picked the other.
   */
  it('always returns an array, whatever the response was', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        expect(Array.isArray(listFrom(body))).toBe(true);
      }),
      RUNS
    );
  });

  it('finds the items in both shapes and never invents any', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 8 }), (items) => {
        expect(listFrom(items)).toEqual(items);
        expect(listFrom({ items, page: 1 })).toEqual(items);
        expect(listFrom({ page: 1 })).toEqual([]);
      }),
      RUNS
    );
  });

  it('reports pagination only where there is an envelope', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 5 }), (items) => {
        expect(paginationOf(items)).toEqual({});
        for (const value of Object.values(paginationOf({ items, page: 2 }))) {
          expect(typeof value).toBe('number');
        }
      }),
      RUNS
    );
  });
});

describe('text and image helpers stay honest', () => {
  /**
   * `cap` is longer than its limit by design — the marker is what tells the
   * reader the text was cut and what to call for the rest. What has to hold is
   * that the *content* is bounded and the marker is always there when it was.
   */
  it('bounds the content and says when it cut', () => {
    fc.assert(
      fc.property(
        // Printable ASCII: `cap` also strips control characters, which is a
        // property of its own (test/text.test.ts) and would break the prefix
        // check here.
        fc.string({ maxLength: 2000, unit: 'grapheme-ascii' }),
        fc.integer({ min: 1, max: 300 }),
        (text, max) => {
          const capped = cap(text, max);
          if (capped === undefined) return;
          if (text.length <= max) {
            expect(capped).toBe(text);
          } else {
            expect(capped.startsWith(text.slice(0, max))).toBe(true);
            expect(capped).toContain(`truncated at ${max} characters`);
          }
        }
      ),
      RUNS
    );
  });

  it('a non-string is not turned into one', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.object()
        ),
        (value) => {
          expect(cap(value, 50)).toBeUndefined();
        }
      ),
      RUNS
    );
  });

  /**
   * The `image` field of a recipe is a cache-busting counter, not a URL, and
   * `0` is a legitimate one — so the check has to be against null and undefined
   * rather than against falsiness.
   */
  it('builds an image URL whenever the version is present, zero included', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 0, max: 500 }),
        (id, version) => {
          const url = imageUrl('https://mealie.example.com', {
            id,
            image: version,
          });
          expect(url).toBe(
            `https://mealie.example.com/api/media/recipes/${id}/images/original.webp?version=${version}`
          );
        }
      ),
      RUNS
    );
  });

  it('builds nothing when a part is missing', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(imageUrl(undefined, { id, image: 1 })).toBeUndefined();
        expect(imageUrl('https://x.example', { image: 1 })).toBeUndefined();
        expect(
          imageUrl('https://x.example', { id, image: null })
        ).toBeUndefined();
        expect(imageUrl('https://x.example', { id })).toBeUndefined();
      }),
      RUNS
    );
  });

  /**
   * Both halves of the image URL are the instance's strings and both land in
   * an address the model may follow, so neither may be anything but what it
   * claims to be: a UUID and a short number.
   */
  it('builds nothing out of an id or a version that is not one', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .string({ maxLength: 40 })
            .filter((s) => !/^[0-9a-f-]{36}$/i.test(s)),
          fc.constant('../../admin'),
          fc.constant('x?token=1#')
        ),
        (id) => {
          expect(
            imageUrl('https://x.example', { id, image: 1 })
          ).toBeUndefined();
        }
      ),
      RUNS
    );
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.oneof(
          fc.string({ maxLength: 40 }).filter((s) => !/^[0-9]{1,12}$/.test(s)),
          fc.double({ noInteger: true }),
          fc.constant(-1),
          fc.constant({ toString: () => '1' })
        ),
        (id, version) => {
          expect(
            imageUrl('https://x.example', { id, image: version })
          ).toBeUndefined();
        }
      ),
      RUNS
    );
  });
});
