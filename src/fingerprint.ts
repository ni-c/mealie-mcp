import { createHash } from 'node:crypto';

/**
 * A short digest of the values a call is about to write over something with.
 *
 * It goes into the resource key of a guarded write, and it is there for the
 * case the resource key alone does not cover: `update_recipe` on one id is one
 * operation on one target, so a confirmation issued for
 * `{instructions: ["Rest overnight"]}` would also execute
 * `{instructions: []}` — same tool, same recipe, different content. The model
 * picks the second body, and only the target would ever have been checked.
 *
 * Keys are sorted so that two calls carrying the same fields in a different
 * order are the same operation, which is what a person confirming it would
 * assume. Truncated to 16 hex characters: this is a binding check between two
 * halves of one flow, not a signature — the value never leaves the process, and
 * a collision would have to be found against a key nobody can read.
 */
export function contentFingerprint(values: Record<string, unknown>): string {
  const canonical = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]] as const);
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The subset of `fields` that is actually present, in the order `names` gives.
 *
 * `undefined` is what "the caller did not mention this field" looks like after
 * Zod, and it is the difference between a write that replaces content and one
 * that leaves it alone — so the check has to be `!== undefined` rather than a
 * truthiness test. An empty array is the most destructive value there is here:
 * it clears the list.
 */
export function presentFields<T extends object>(
  fields: T,
  names: readonly (keyof T & string)[]
): Record<string, unknown> {
  const present: Record<string, unknown> = {};
  for (const name of names) {
    if (fields[name] !== undefined) present[name] = fields[name];
  }
  return present;
}
