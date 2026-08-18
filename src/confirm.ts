import { createHash, randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Issues short-lived confirmation tokens for irreversible operations.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in a scraped recipe —
 * whereas a random token that only ever appears in a *previous* tool result
 * cannot be guessed. The token is bound to a resource key, so a confirmation for
 * one target cannot be replayed for another.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /**
   * Returns true and consumes the token when it matches the pending one for
   * `resource` and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    if (token !== entry.token || Date.now() >= entry.expiresAt) return false;
    this.pending.delete(resource);
    return true;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

/**
 * Resource key for an operation on a *set* of targets.
 *
 * Without the fingerprint a confirmation for ["item-a"] would also execute
 * ["item-a", "item-b"] — the model chooses the second list, and only the first
 * id would ever have been checked. Sorting makes the key independent of the
 * order the ids happen to arrive in.
 */
export function setResourceKey(operation: string, targets: string[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...targets].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * Builds the text returned by the first call of a guarded tool.
 *
 * Note what is NOT in here: no recipe name, tag label or comment text coming
 * from the API. Those are upstream-controlled and this string is read by a
 * model, so it carries ids, counts and flags only.
 */
export function confirmationPrompt(
  what: string,
  token: string,
  ttlMinutes: number,
  consequence = 'The operation is irreversible.'
): string {
  return (
    `This will ${what}. ${consequence}\n\n` +
    `To proceed, call this tool again with confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}
