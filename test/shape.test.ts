import { describe, expect, it } from 'vitest';

import {
  cap,
  commentSummary,
  cookbookSummary,
  foodSummary,
  imageUrl,
  listFrom,
  mealplanEntry,
  organizerSummary,
  paginationOf,
  recipeDetail,
  recipeSummary,
  shareToken,
  shareUrl,
  shoppingListItem,
  shoppingListSummary,
  suggestion,
  timelineEvent,
  unitSummary,
} from '../src/shape.js';

/** A recipe as Mealie v3.22.0 actually returns it, trimmed to the shape. */
const RECIPE = {
  id: '592cf12b-700c-4e4b-ba98-4ea114ee1e5a',
  userId: '420ace57-31ec-4cc0-a43d-eb612af362d8',
  householdId: 'be0942fe-522e-43b1-8117-28f35408261d',
  groupId: 'aac4714a-c188-4d9d-85c4-29cd867d815a',
  name: 'Quark Bowl',
  slug: 'quark-bowl',
  image: '107',
  recipeServings: 1,
  recipeYieldQuantity: 0,
  recipeYield: '',
  totalTime: '10',
  prepTime: '10',
  cookTime: null,
  performTime: '',
  description: 'A high-protein evening bowl.',
  recipeCategory: [{ id: 'cat-1', groupId: 'g', name: 'Meals', slug: 'meals' }],
  tags: [{ id: 'tag-1', groupId: 'g', name: 'keto', slug: 'keto' }],
  tools: [],
  rating: null,
  orgURL: '',
  dateAdded: '2026-07-23',
  dateUpdated: '2026-07-23T21:08:38.086373Z',
  createdAt: '2026-07-23T21:07:02.699277Z',
  update_at: null,
  lastMade: null,
  recipeIngredient: [
    {
      quantity: 0,
      unit: null,
      food: null,
      note: '500 g low-fat quark',
      display: '500 g low-fat quark',
      title: null,
      originalText: null,
      referenceId: 'f8ed8158-1561-444a-851e-750b6d15bd4e',
    },
  ],
  recipeInstructions: [
    {
      id: 'step-1',
      title: '',
      summary: '',
      text: 'Add the quark to a bowl.',
      ingredientReferences: [],
    },
  ],
  nutrition: {
    calories: '1085',
    carbohydrateContent: '69.8',
    cholesterolContent: null,
    fatContent: null,
  },
  settings: { public: true, showNutrition: true, locked: false },
  assets: [],
  notes: [{ title: 'Tip', text: 'Chill it first.' }],
  extras: {},
  comments: [],
};

describe('cap', () => {
  it('leaves a short value alone', () => {
    expect(cap('abc', 10)).toBe('abc');
  });

  it('says so when it truncates', () => {
    expect(cap('abcdef', 3)).toBe('abc… (truncated at 3 characters)');
  });

  it('maps empty and non-strings to undefined', () => {
    expect(cap('', 10)).toBeUndefined();
    expect(cap(null, 10)).toBeUndefined();
    expect(cap(42, 10)).toBeUndefined();
  });
});

describe('listFrom', () => {
  it('unwraps the pagination envelope', () => {
    expect(listFrom({ items: [1, 2], total: 2 })).toEqual([1, 2]);
  });

  it('accepts a bare array, as /mealplans/today and /shared/recipes return', () => {
    expect(listFrom([1, 2])).toEqual([1, 2]);
  });

  it('returns an empty list for anything else', () => {
    expect(listFrom(null)).toEqual([]);
    expect(listFrom('x')).toEqual([]);
    expect(listFrom({ items: 'not an array' })).toEqual([]);
  });
});

describe('paginationOf', () => {
  it('renames the snake_case fields', () => {
    expect(
      paginationOf({
        page: 1,
        per_page: 50,
        total: 3,
        total_pages: 1,
        items: [],
      })
    ).toEqual({ page: 1, perPage: 50, total: 3, totalPages: 1 });
  });

  it('is empty for a bare-array response', () => {
    expect(paginationOf([1, 2])).toEqual({});
  });
});

describe('imageUrl', () => {
  it('builds the media URL from the id and the cache-busting counter', () => {
    // The `image` field is a version number ("107"), not a path.
    expect(imageUrl('https://mealie.example.com', RECIPE)).toBe(
      'https://mealie.example.com/api/media/recipes/592cf12b-700c-4e4b-ba98-4ea114ee1e5a/images/original.webp?version=107'
    );
  });

  it('is undefined without an image, an id or a base URL', () => {
    expect(imageUrl('https://x', { ...RECIPE, image: null })).toBeUndefined();
    expect(imageUrl('https://x', { image: '1' })).toBeUndefined();
    expect(imageUrl(undefined, RECIPE)).toBeUndefined();
  });
});

describe('recipeSummary', () => {
  const summary = recipeSummary(RECIPE);

  it('keeps what is needed to choose a recipe', () => {
    expect(summary).toMatchObject({
      id: RECIPE.id,
      slug: 'quark-bowl',
      name: 'Quark Bowl',
      totalTime: '10',
      recipeServings: 1,
      tags: ['keto'],
      categories: ['Meals'],
    });
  });

  it('omits ingredients and steps', () => {
    expect(summary.recipeIngredient).toBeUndefined();
    expect(summary.recipeInstructions).toBeUndefined();
  });

  it('drops empty and null fields rather than emitting them', () => {
    expect('rating' in summary).toBe(false);
    expect('lastMade' in summary).toBe(false);
  });

  it('truncates a long description', () => {
    const long = recipeSummary({ ...RECIPE, description: 'x'.repeat(5000) });
    expect(String(long.description)).toContain('truncated at 400');
  });
});

describe('recipeDetail', () => {
  const detail = recipeDetail(RECIPE, 'https://mealie.example.com');

  it('carries everything needed to cook it', () => {
    expect(detail.recipeIngredient).toEqual([
      {
        display: '500 g low-fat quark',
        note: '500 g low-fat quark',
        // 0 for an unparsed line; a parsed one carries the real amount here.
        quantity: 0,
        referenceId: 'f8ed8158-1561-444a-851e-750b6d15bd4e',
      },
    ]);
    expect(detail.recipeInstructions).toEqual([
      { id: 'step-1', text: 'Add the quark to a bowl.' },
    ]);
    expect(detail.notes).toEqual([{ title: 'Tip', text: 'Chill it first.' }]);
    expect(detail.prepTime).toBe('10');
  });

  it('drops the null-valued nutrition keys', () => {
    expect(detail.nutrition).toEqual({
      calories: '1085',
      carbohydrateContent: '69.8',
    });
  });

  it('omits nutrition entirely when every value is empty', () => {
    const bare = recipeDetail({ ...RECIPE, nutrition: { calories: null } });
    expect('nutrition' in bare).toBe(false);
  });

  it('removes the bookkeeping a single-group token cannot use', () => {
    for (const key of [
      'userId',
      'householdId',
      'groupId',
      'extras',
      'assets',
      'settings',
      'comments',
      'update_at',
    ]) {
      expect(key in detail, key).toBe(false);
    }
  });

  it('surfaces the one setting with a visibility consequence', () => {
    expect(detail.isPublic).toBe(true);
  });

  it('keeps full tag and category objects, not just names', () => {
    expect(detail.tags).toEqual([{ id: 'tag-1', name: 'keto', slug: 'keto' }]);
  });

  it('survives a garbage payload', () => {
    expect(recipeDetail(null)).toEqual({
      recipeIngredient: [],
      recipeInstructions: [],
      notes: [],
      categories: [],
      tags: [],
      tools: [],
    });
  });
});

describe('organizerSummary', () => {
  it('keeps id, name and slug', () => {
    expect(
      organizerSummary({ id: 't', name: 'keto', slug: 'keto', groupId: 'g' })
    ).toEqual({
      id: 't',
      name: 'keto',
      slug: 'keto',
    });
  });

  it('keeps onHand, which only tools carry', () => {
    expect(
      organizerSummary({ id: 't', name: 'Whisk', onHand: false }).onHand
    ).toBe(false);
  });
});

describe('foodSummary and unitSummary', () => {
  it('flattens the label and the aliases', () => {
    expect(
      foodSummary({
        id: 'f',
        name: 'Quark',
        label: { id: 'l', name: 'Dairy' },
        aliases: [{ name: 'Topfen' }],
      })
    ).toEqual({ id: 'f', name: 'Quark', label: 'Dairy', aliases: ['Topfen'] });
  });

  it('keeps the rendering flags of a unit', () => {
    expect(
      unitSummary({
        id: 'u',
        name: 'Tablespoon',
        abbreviation: 'tbsp',
        useAbbreviation: true,
        fraction: false,
      })
    ).toEqual({
      id: 'u',
      name: 'Tablespoon',
      abbreviation: 'tbsp',
      useAbbreviation: true,
      fraction: false,
    });
  });
});

describe('mealplanEntry', () => {
  it('lifts the recipe name and slug out of the nested record', () => {
    expect(
      mealplanEntry({
        id: 7,
        date: '2026-08-19',
        entryType: 'dinner',
        title: '',
        text: '',
        recipeId: 'r',
        recipe: { slug: 'quark-bowl', name: 'Quark Bowl' },
        groupId: 'g',
        userId: 'u',
      })
    ).toEqual({
      id: 7,
      date: '2026-08-19',
      entryType: 'dinner',
      recipeId: 'r',
      recipeSlug: 'quark-bowl',
      recipeName: 'Quark Bowl',
    });
  });

  it('keeps a free-text entry', () => {
    expect(
      mealplanEntry({
        id: 8,
        date: '2026-08-19',
        entryType: 'lunch',
        title: 'Leftovers',
      })
    ).toMatchObject({
      title: 'Leftovers',
    });
  });
});

describe('shoppingListSummary and shoppingListItem', () => {
  it('counts the items of a detail response', () => {
    expect(
      shoppingListSummary({
        id: 'l',
        name: 'Groceries',
        listItems: [{}, {}],
        recipeReferences: [],
      })
    ).toMatchObject({ id: 'l', name: 'Groceries', itemCount: 2 });
  });

  it('has no item count on a summary response', () => {
    expect('itemCount' in shoppingListSummary({ id: 'l', name: 'G' })).toBe(
      false
    );
  });

  it('flattens unit, food and label of an item', () => {
    expect(
      shoppingListItem({
        id: 'i',
        display: '2 tbsp olive oil',
        checked: false,
        quantity: 2,
        unit: { name: 'tablespoon' },
        food: { name: 'olive oil' },
        label: { name: 'Pantry' },
        position: 1,
      })
    ).toEqual({
      id: 'i',
      display: '2 tbsp olive oil',
      checked: false,
      quantity: 2,
      unit: 'tablespoon',
      food: 'olive oil',
      label: 'Pantry',
      position: 1,
    });
  });

  it('falls back to the note when there is no display value', () => {
    expect(shoppingListItem({ id: 'i', note: 'Milk' }).display).toBe('Milk');
  });
});

describe('cookbookSummary', () => {
  it('renames public to isPublic and keeps the filter', () => {
    expect(
      cookbookSummary({
        id: 'c',
        name: 'Desserts',
        slug: 'desserts',
        public: false,
        queryFilterString: 'tags.name IN ["Dessert"]',
      })
    ).toMatchObject({
      isPublic: false,
      queryFilterString: 'tags.name IN ["Dessert"]',
    });
  });
});

describe('commentSummary', () => {
  it('keeps the username and drops the rest of the user record', () => {
    const shaped = commentSummary({
      id: 'c',
      recipeId: 'r',
      text: 'Nice.',
      createdAt: '2026-08-18T00:00:00Z',
      user: {
        id: 'u',
        username: 'cook',
        email: 'cook@example.com',
        admin: true,
      },
    });
    expect(shaped).toEqual({
      id: 'c',
      recipeId: 'r',
      text: 'Nice.',
      author: 'cook',
      createdAt: '2026-08-18T00:00:00Z',
    });
    expect(JSON.stringify(shaped)).not.toContain('@example.com');
  });
});

describe('timelineEvent and shareToken', () => {
  it('keeps the readable timeline fields', () => {
    expect(
      timelineEvent({
        id: 'e',
        recipeId: 'r',
        subject: 'Cooked it',
        eventType: 'comment',
        eventMessage: 'Good',
        timestamp: 't',
        image: 'does not have image',
      })
    ).toEqual({
      id: 'e',
      recipeId: 'r',
      subject: 'Cooked it',
      eventType: 'comment',
      eventMessage: 'Good',
      timestamp: 't',
    });
  });

  it('keeps the expiry of a share token', () => {
    expect(
      shareToken({
        id: 's',
        recipeId: 'r',
        expiresAt: '2026-09-01',
        createdAt: 'c',
        groupId: 'g',
      })
    ).toEqual({
      id: 's',
      recipeId: 'r',
      expiresAt: '2026-09-01',
      createdAt: 'c',
    });
  });
});

describe('shareUrl', () => {
  it('builds the public address', () => {
    expect(shareUrl('https://mealie.example.com', 'abc')).toBe(
      'https://mealie.example.com/shared/recipes/abc'
    );
  });

  it('is undefined without a base URL or a token', () => {
    expect(shareUrl(undefined, 'abc')).toBeUndefined();
    expect(shareUrl('https://x', undefined)).toBeUndefined();
  });
});

describe('suggestion', () => {
  it('reduces the missing items to their names', () => {
    expect(
      suggestion({
        recipe: RECIPE,
        missingFoods: [{ id: 'f', name: 'Honey' }],
        missingTools: [],
      })
    ).toMatchObject({ missingFoods: ['Honey'], missingTools: [] });
  });
});
