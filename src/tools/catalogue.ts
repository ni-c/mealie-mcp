/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `MEALIE_ALLOW_TOOLS=add_recipe_comment` report
 * "unknown tool" under `MEALIE_READ_ONLY=true`, which is the one answer that
 * is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'get_about',
  'get_cookbook',
  'get_recipe',
  'get_shopping_list',
  'get_todays_meals',
  'list_cookbooks',
  'list_foods',
  'list_mealplans',
  'list_organizers',
  'list_recipe_comments',
  'list_recipe_timeline',
  'list_share_tokens',
  'list_shopping_lists',
  'list_units',
  'preview_recipe_url',
  'parse_ingredients',
  'search_recipes',
  'suggest_recipes',
] as const;

/** Registered unless `MEALIE_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'add_recipe_comment',
  'add_recipe_to_shopping_list',
  'add_shopping_list_items',
  'create_cookbook',
  'create_food',
  'create_mealplan_entry',
  'create_organizer',
  'create_random_meal',
  'create_recipe',
  'create_share_token',
  'create_shopping_list',
  'create_timeline_event',
  'create_unit',
  'delete_cookbook',
  'delete_mealplan_entry',
  'delete_organizer',
  'delete_recipe',
  'delete_recipe_comment',
  'delete_share_token',
  'delete_shopping_list',
  'delete_shopping_list_items',
  'duplicate_recipe',
  'import_recipe_from_html_or_json',
  'import_recipe_from_image',
  'import_recipe_from_url',
  'merge_foods',
  'merge_units',
  'remove_recipe_from_shopping_list',
  'set_recipe_last_made',
  'set_recipe_rating',
  'update_mealplan_entry',
  'update_organizer',
  'update_recipe',
  'update_shopping_list_items',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `MEALIE_ALLOW_TOOLS=essential` selects: find a recipe, get it in, plan and shop.
 *
 * 8 of 52. Left out on purpose: the sixteen-tool foods/units/organizers/cookbooks taxonomy, sharing
 * tokens, comments and ratings, and every delete.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'search_recipes',
  'get_recipe',
  'import_recipe_from_url',
  'create_recipe',
  'get_todays_meals',
  'create_mealplan_entry',
  'list_shopping_lists',
  'add_recipe_to_shopping_list',
];
