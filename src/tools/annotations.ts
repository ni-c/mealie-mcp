/**
 * The annotation blocks this server's tools carry.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * `openWorldHint` is `true` wherever the call makes Mealie talk to somebody
 * outside itself, which is two different situations and both count:
 *
 *   - the caller names the address — `import_recipe_from_url` and
 *     `preview_recipe_url` hand Mealie a URL of the caller's choosing. That is
 *     the boundary the SSRF guard in `schema.ts` watches.
 *   - the operator named it — `import_recipe_from_image` sends the picture to
 *     whichever AI provider the instance is configured with.
 *
 * `import_recipe_from_html_or_json` takes the content directly and reaches
 * nothing, which is the distinction that used to be invisible: three tools
 * said `true` while the other forty-nine inherited `true`, so the marking
 * carried no information at all.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** A write that adds or amends without losing anything. */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * A write that replaces or removes something a person put there.
 *
 * The `update_*` tools are in here, which is worth saying out loud because
 * "update" sounds additive. Mealie keeps no version history: `update_recipe`
 * with a new instruction list replaces the old one and there is nowhere to
 * read it back from. Wiki.js has page history and its `update_page` really is
 * non-destructive — the difference is the backend, not the verb.
 */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  // Every destructive tool here names an absolute target — a recipe id, a
  // list of item ids, a merge pair — and carries the whole new value rather
  // than a delta. Repeating the call leaves the same world; a second delete
  // merely fails, which the specification does not count as an effect.
  idempotentHint: true,
  openWorldHint: false,
} as const;
