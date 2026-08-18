# Tools

One section per tool: what it does, its parameters, and — for destructive tools —
the two-step confirmation flow.

52 tools in total. The 17 read tools are always registered; the 35 write and
import tools are omitted when `MEALIE_READ_ONLY=true`.

::: info Recipe references: slug or UUID
Wherever a parameter is described as a *recipe slug or UUID*, both work — Mealie
splits its identifier space (recipe CRUD uses the slug, meal plans, ratings and
timeline events use the UUID), and the tools resolve whichever they are given.
Both are returned by `search_recipes`.
:::

::: warning Confirmation tokens
Tools marked **Requires a confirmation token** run a two-step flow: call once to
receive a token together with a description of what is about to happen, then call
again with the same arguments plus `confirm_token` to perform it. Tokens are
single-use, expire after a few minutes and are bound to the specific target.
:::

## Recipes

### search_recipes

Searches the recipe collection. Returns summaries — name, slug, id, times,
rating, tags and categories — without ingredients or steps; use `get_recipe` for
those. All filters combine with AND; within one filter the entries are OR unless
the matching `require_all_*` flag is set.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `search` | string | no | Full-text search over names, descriptions and ingredients |
| `tags` | string[] | no | Restrict to recipes carrying these tags — names, slugs or UUIDs |
| `categories` | string[] | no | Restrict to recipes carrying these categories |
| `tools` | string[] | no | Restrict to recipes carrying these tools |
| `foods` | string[] | no | Restrict to recipes carrying these foods |
| `cookbook` | string | no | Restrict the result to a cookbook, by slug or UUID |
| `require_all_tags` | boolean | no | Require every listed tag instead of any of them |
| `require_all_categories` | boolean | no | Same, for categories |
| `require_all_tools` | boolean | no | Same, for tools |
| `require_all_foods` | boolean | no | Same, for foods |
| `order_by` | enum | no | `name` \| `rating` \| `created_at` \| `updated_at` \| `last_made` \| `random`; default `created_at` |
| `order_direction` | enum | no | `asc` \| `desc`, default `desc` |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 25, max 100 |

### get_recipe

Fetches one recipe with everything needed to cook it: ingredients, steps, times,
yield, notes and nutrition. Accepts the slug or the UUID.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `detail` | enum | no | `default` returns the cleaned-up recipe; `raw` returns Mealie's untouched object including settings, assets, extras and inline comments |

### suggest_recipes

Suggests recipes that can be cooked from the foods and tools marked as "on hand"
in Mealie, ranked by how little is missing. This only produces anything on an
instance that actually maintains structured foods, units and an on-hand pantry —
on a collection of plain-text ingredients it returns nothing; use
`search_recipes` there.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `foods` | string[] (UUIDs) | no | Food UUIDs to treat as available, from `list_foods` |
| `tools` | string[] (UUIDs) | no | Tool UUIDs to treat as available, from `list_organizers` |
| `max_missing_foods` | number | no | How many ingredients a suggestion may be missing, default 5 |
| `max_missing_tools` | number | no | Same, for tools |
| `limit` | number | no | Number of suggestions, default 10, max 50 |

### create_recipe

Creates a recipe from the given fields. To add one from a website use
`import_recipe_from_url` instead — it fills in far more.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Recipe name. Mealie derives the slug from it and rejects a duplicate |
| `description` | string | no | Recipe description |
| `ingredients` | string[] | no | Ingredient lines as free text, e.g. `"500 g quark"`. They replace the existing list; use `parse_ingredients` first if structured food and unit references are wanted |
| `instructions` | string[] | no | Preparation steps, in order. They replace the existing list |
| `tags` | string[] | no | Tag names. They replace the existing tags; unknown names are created |
| `categories` | string[] | no | Category names. They replace the existing categories |
| `prep_time` | string | no | Preparation time |
| `cook_time` | string | no | Cooking time |
| `total_time` | string | no | Total time |
| `servings` | number | no | Number of servings |
| `recipe_yield` | string | no | Yield as text |
| `notes` | { title, text }[] | no | Notes attached to the recipe |
| `source_url` | string | no | Original source of the recipe, stored as `orgURL` |

### update_recipe

Changes individual fields of a recipe. Only the fields given are touched;
everything else keeps its value. Passing an empty array for ingredients,
instructions, tags or categories clears that list. Uses `PATCH` — Mealie's
`PUT` route, which replaces the whole 33-field object, is deliberately not
exposed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `name` | string | no | New recipe name |
| …same optional fields as `create_recipe` | | | `description`, `ingredients`, `instructions`, `tags`, `categories`, `prep_time`, `cook_time`, `total_time`, `servings`, `recipe_yield`, `notes`, `source_url` |

### duplicate_recipe

Creates a copy of a recipe under a new name, leaving the original untouched.
Useful as a starting point for a variation.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `name` | string | no | Name of the copy; Mealie appends a counter when omitted |

### set_recipe_last_made

Records when a recipe was last cooked. Mealie shows this on the recipe and sorts
by it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `timestamp` | string | yes | ISO 8601 date or date-time, e.g. `2026-08-18` or `2026-08-18T19:30:00Z` |

### delete_recipe

Deletes a recipe permanently, together with its comments, timeline and images.
**Requires a confirmation token: call once to receive one, call again with it.**
The token is keyed to the resolved UUID, so a token issued for a slug cannot be
replayed against a different recipe that has since taken that slug.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

## Import

### preview_recipe_url

Fetches a URL and reports what Mealie would extract from it, **without saving
anything**. Use this to check a page before importing it, or to find out why an
import came out empty.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Address of the recipe page to test — public `http`/`https` only |

### import_recipe_from_url

Has Mealie fetch a recipe page and save it as a new recipe. The fetch happens on
the Mealie server, not here. Everything the page contains — name, description,
ingredients, steps — ends up in the collection as written by whoever controls
that site.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Address of the recipe to import — public `http`/`https` only |
| `include_tags` | boolean | no | Adopt the page's keywords as tags, default false |
| `include_categories` | boolean | no | Adopt the page's categories, default false |

### import_recipe_from_html_or_json

Creates a recipe from HTML or schema.org recipe JSON supplied directly, without
Mealie fetching anything. Useful for a page that needs a login, or one that
`import_recipe_from_url` could not parse.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | string | yes | The page HTML, or a schema.org Recipe JSON document (max 2 MB) |

### import_recipe_from_image

Creates a recipe from a photo of one — a cookbook page, a handwritten card — by
having Mealie run it through its configured AI provider. Requires an AI provider
set up in Mealie; without one the call fails, and the setting itself is only
visible to a group manager or admin.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `image_base64` | string | yes | The image, base64-encoded, without a `data:` URI prefix (max 8 MB) |
| `format` | enum | yes | `jpeg` \| `jpg` \| `png` \| `webp` — used for the upload filename and content type |
| `translate_language` | string | no | Translate the extracted recipe into this language, e.g. `"de"` or `"German"` |

## Organizing

Tags, categories and recipe tools share one CRUD shape in Mealie, so each of
these tools takes a `kind` parameter: `tag` (free-form labels), `category` (the
primary classification, one recipe usually has few) or `tool` (equipment a
recipe needs).

### list_organizers

Lists the tags, categories or tools defined in the group, with their ids and
slugs. These are the values `search_recipes` filters on.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | enum | yes | `tag` \| `category` \| `tool` |
| `search` | string | no | Filter by name |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 100, max 100 |
| `order_direction` | enum | no | `asc` \| `desc`, default `asc` |

### create_organizer

Creates a tag, category or recipe tool. Assigning one to a recipe with
`update_recipe` already creates it on the fly — this tool is for defining one up
front.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | enum | yes | `tag` \| `category` \| `tool` |
| `name` | string | yes | Name of the new organizer |

### update_organizer

Renames a tag, category or tool. Mealie regenerates the slug from the new name,
so anything referring to the old slug stops matching.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | enum | yes | `tag` \| `category` \| `tool` |
| `id` | string (UUID) | yes | UUID from `list_organizers` |
| `name` | string | yes | The new name |

### delete_organizer

Deletes a tag, category or tool. The recipes themselves are kept, but they lose
the assignment. **Requires a confirmation token: call once to receive one, call
again with it.**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | enum | yes | `tag` \| `category` \| `tool` |
| `id` | string (UUID) | yes | UUID from `list_organizers` |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

## Ingredients

### list_foods

Lists the structured foods of the group — the ingredient vocabulary Mealie
matches ingredient lines against. Many instances leave this empty and keep
ingredients as plain text; an empty result means exactly that, not a failure.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `search` | string | no | Filter by name |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 100, max 100 |
| `order_direction` | enum | no | `asc` \| `desc`, default `asc` |

### create_food

Adds a food to the group vocabulary so ingredient lines can be matched against
it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Name of the food |
| `plural_name` | string | no | Plural form |
| `description` | string | no | Description |
| `label_id` | string (UUID) | no | Shopping-list label to file this food under |

### merge_foods

Points every ingredient that uses one food at another one and deletes the source
food. **Requires a confirmation token: call once to receive one, call again with
it.** The token is bound to the ordered pair — swapping the two arguments would
destroy the wrong record, so a token for one direction cannot confirm the other.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from_id` | string (UUID) | yes | UUID of the food to merge away — this one is deleted |
| `to_id` | string (UUID) | yes | UUID of the food to keep — references end up here |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### list_units

Lists the measurement units of the group, with their abbreviations. Like foods,
this is empty on an instance that never seeded them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `search` | string | no | Filter by name |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 100, max 100 |
| `order_direction` | enum | no | `asc` \| `desc`, default `asc` |

### create_unit

Adds a measurement unit to the group vocabulary.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Name of the unit |
| `plural_name` | string | no | Plural form |
| `abbreviation` | string | no | Abbreviation, e.g. `tbsp` |
| `use_abbreviation` | boolean | no | Render the abbreviation instead of the name |
| `fraction` | boolean | no | Show quantities as fractions (½ cup) rather than decimals |
| `description` | string | no | Description |

### merge_units

Points every ingredient that uses one unit at another one and deletes the source
unit. **Requires a confirmation token: call once to receive one, call again with
it.** As with `merge_foods`, the token is bound to the merge direction.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from_id` | string (UUID) | yes | UUID of the unit to merge away — this one is deleted |
| `to_id` | string (UUID) | yes | UUID of the unit to keep — references end up here |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### parse_ingredients

Splits free-text ingredient lines into quantity, unit, food and note, and
reports how confident Mealie is about each part. Nothing is saved. Use it to
check how a line will be understood before writing it to a recipe or a shopping
list.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ingredients` | string[] | yes | Ingredient lines, e.g. `"2 tbsp olive oil"` (1–100 lines) |
| `parser` | enum | no | `nlp` (default) uses the trained model, `brute` a rule-based split. Mealie's `openai` parser is not exposed — it sends every line to an external provider |

## Meal plans

### list_mealplans

Lists the meal plan of the household in a date range. Each entry is either a
recipe reference or a free-text note.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `start_date` | string | no | First day to include, `YYYY-MM-DD` |
| `end_date` | string | no | Last day to include, `YYYY-MM-DD` |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 50, max 100 |

### get_todays_meals

Returns the recipes planned for today, as Mealie computes "today" for the
household. Answers with a bare list, not a paginated envelope. Takes no
parameters.

### create_mealplan_entry

Puts a recipe or a free-text note on the meal plan for one day. Give either a
recipe or a title, not both — Mealie stores a plan entry as one or the other.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `date` | string | yes | Day of the meal, `YYYY-MM-DD` |
| `entry_type` | enum | yes | `breakfast` \| `lunch` \| `dinner` \| `side` \| `snack` \| `drink` \| `dessert` |
| `recipe` | string | no* | Recipe slug or UUID to plan |
| `title` | string | no* | Free-text entry, for a meal that is not a stored recipe |
| `text` | string | no | Additional note shown under the title |

\* exactly one of `recipe` or `title` must be given.

### create_random_meal

Lets Mealie pick a recipe for a day and slot, honouring the meal plan rules
configured in the household.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `date` | string | yes | Day of the meal, `YYYY-MM-DD` |
| `entry_type` | enum | yes | `breakfast` \| `lunch` \| `dinner` \| `side` \| `snack` \| `drink` \| `dessert` |

### update_mealplan_entry

Moves an entry to another day or slot, or replaces the recipe behind it. The
current entry is read first and the changes merged onto it, because Mealie's
route is a full-object `PUT`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `entry_id` | number | yes | Plan entry id from `list_mealplans` — an integer, not a UUID |
| `date` | string | no | New day, `YYYY-MM-DD` |
| `entry_type` | enum | no | New slot |
| `recipe` | string | no | Recipe slug or UUID |
| `title` | string | no | New title |
| `text` | string | no | New note |

### delete_mealplan_entry

Removes one entry from the meal plan. The recipe itself is not touched.
**Requires a confirmation token: call once to receive one, call again with it.**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `entry_id` | number | yes | Plan entry id from `list_mealplans` — an integer, not a UUID |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

## Shopping

### list_shopping_lists

Lists the shopping lists of the household, without their items.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 50, max 100 |

### get_shopping_list

Fetches one shopping list with all of its items, checked and unchecked.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID, from `list_shopping_lists` |
| `include_checked` | boolean | no | Include items already ticked off, default true |

### create_shopping_list

Creates an empty shopping list in the household.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Name of the new list |

### delete_shopping_list

Deletes a shopping list and everything on it. **Requires a confirmation token:
call once to receive one, call again with it.**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID, from `list_shopping_lists` |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### add_shopping_list_items

Adds items to a shopping list as free text (`"2 tbsp olive oil"`). Mealie does
not split these into food and unit automatically — run `parse_ingredients` first
if that matters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID, from `list_shopping_lists` |
| `items` | string[] | yes | The lines to add, one item each (1–100) |

### update_shopping_list_items

Changes items on a shopping list — most often ticking them off. Only the given
fields are changed; the rest of each item is preserved (the server reads the
list first, because Mealie's bulk update replaces every field it does not
receive). At least one of `checked`, `quantity` or `note` must be given.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID |
| `item_ids` | string[] (UUIDs) | yes | Item UUIDs from `get_shopping_list` (1–100) |
| `checked` | boolean | no | Tick the items off (true) or put them back (false) |
| `quantity` | number | no | Set the quantity of every listed item |
| `note` | string | no | Replace the text of every listed item |

### delete_shopping_list_items

Removes items from a shopping list for good. To merely tick something off, use
`update_shopping_list_items` with `checked=true`. **Requires a confirmation
token: call once to receive one, call again with it.** The token is bound to a
fingerprint of the whole sorted id set, so a confirmation for three items cannot
delete a fourth appended between the two calls.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `item_ids` | string[] (UUIDs) | yes | Item UUIDs from `get_shopping_list` (1–100) |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### add_recipe_to_shopping_list

Adds a recipe's ingredients to a shopping list, merging them with what is
already there. Mealie remembers the recipe on the list, so
`remove_recipe_from_shopping_list` can take exactly these ingredients back off
again.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID |
| `recipe` | string | yes | Recipe slug or UUID |
| `servings_multiplier` | number | no | Scale the ingredient quantities, default 1 |

### remove_recipe_from_shopping_list

Takes a recipe's ingredients back off a shopping list. Items that were also
needed by another recipe on the list stay, with their quantity reduced.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `list_id` | string (UUID) | yes | Shopping list UUID |
| `recipe` | string | yes | Recipe slug or UUID |
| `servings_multiplier` | number | no | How much of the recipe to remove, default 1 |

## Cookbooks

### list_cookbooks

Lists the cookbooks of the household. A cookbook is a saved filter over the
recipe collection, not a fixed set of recipes.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 50, max 100 |

### get_cookbook

Fetches a cookbook and the recipes it currently matches. Accepts the slug or the
UUID.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cookbook` | string | yes | Cookbook slug or UUID, from `list_cookbooks` |
| `per_page` | number | no | Recipes to return, default 50, max 100 |

### create_cookbook

Creates a cookbook — a named, saved view of the recipe collection. Without a
filter it matches every recipe; the filter itself is written in Mealie's own
query language and is easiest to build in the web UI.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Name of the cookbook |
| `description` | string | no | Description |
| `query_filter` | string | no | Mealie query filter, e.g. `tags.name IN ["Dessert"]`. Passed through verbatim; an invalid expression is rejected by Mealie with a 422 |
| `is_public` | boolean | no | Make the cookbook readable without a login, default false |

### delete_cookbook

Deletes a cookbook. The recipes it matched are not touched — a cookbook is only
a saved filter. **Requires a confirmation token: call once to receive one, call
again with it.**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cookbook_id` | string (UUID) | yes | Cookbook UUID, from `list_cookbooks` |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

## Notes & sharing

### set_recipe_rating

Sets the personal rating of a recipe and/or marks it as a favourite. Ratings in
Mealie are per user, not per recipe. At least one of `rating` or `is_favorite`
must be given.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `rating` | number | no | Stars from 0 to 5; 0 clears the rating |
| `is_favorite` | boolean | no | Mark or unmark as a favourite |

### add_recipe_comment

Adds a comment to a recipe. Comments are visible to everyone in the group and
are attributed to the user the API token belongs to.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `text` | string | yes | The comment text |

### delete_recipe_comment

Deletes a comment. **Requires a confirmation token: call once to receive one,
call again with it.**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `comment_id` | string (UUID) | yes | Comment UUID, from `list_recipe_comments` |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### list_recipe_comments

Lists the comments other users of the instance left on a recipe.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |

### list_recipe_timeline

Lists the timeline of a recipe: when it was created, updated and each time it
was cooked, with the notes attached to those events.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `page` | number | no | 1-based page number, default 1 |
| `per_page` | number | no | Entries to return, default 50, max 100 |

### create_timeline_event

Adds an entry to a recipe's timeline — typically a note about having cooked it
and how it turned out. Pair it with `set_recipe_last_made`, which is what the
recipe view sorts on.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `subject` | string | yes | Short headline, e.g. `"Cooked it"` |
| `message` | string | no | The note itself |
| `timestamp` | string | no | ISO 8601 date or date-time; defaults to now |

### list_share_tokens

Lists the public share links that currently exist, with the recipe each one
exposes and when it expires. Anyone holding such a link can read the recipe
without an account.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | no | Restrict the result to one recipe (slug or UUID) |

### create_share_token

Creates a link that lets anyone read one recipe without logging in. **Requires a
confirmation token: call once to receive one, call again with it** — guarded like
a destructive operation even though it destroys nothing, because it is the one
tool that widens who can see the data.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Recipe slug or UUID |
| `expires_at` | string | no | ISO 8601 date or date-time when the link stops working. Omitted, it never expires — prefer setting a date |
| `confirm_token` | string | no | Confirmation token from the first call; omit on the first call |

### delete_share_token

Revokes a share link, so the recipe is no longer readable through it. Needs no
confirmation — this narrows access rather than widening it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token_id` | string (UUID) | yes | Share token UUID, from `list_share_tokens` |

## Instance

### get_about

Reports the Mealie version and the identity the API token acts as: user, group,
household and the permission flags that decide which write tools will actually
succeed. Start here when a call fails with a 403. Takes no parameters.
