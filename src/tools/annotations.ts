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
 * outside itself, which is three different situations and all of them count:
 *
 *   - the caller names the address — `import_recipe_from_url` and
 *     `preview_recipe_url` hand Mealie a URL of the caller's choosing. That is
 *     the boundary the SSRF guard in `schema.ts` watches.
 *   - the operator named it — `import_recipe_from_image` sends the picture to
 *     whichever AI provider the instance is configured with.
 *   - the caller's *content* names it — `import_recipe_from_html_or_json`
 *     hands over a document, and Mealie reads the image address out of it and
 *     fetches that. This one used to be marked `false`, on the reasoning that a
 *     document is not a URL. It is not, but it contains one: on v3.22.0 a
 *     pasted `{"image": "http://…/latest/meta-data/"}` puts `Image URL: …` in
 *     Mealie's log and goes through `recipe_data_service.scrape_image`. A
 *     policy layer that reads this hint was being told the opposite of what the
 *     tool does, which is worse than a hint that says nothing.
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
