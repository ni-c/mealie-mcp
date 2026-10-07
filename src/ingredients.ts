import type { VocabularyRef } from './lookup.js';
import { ToolInputError } from './result.js';
import { rec } from './shape.js';

/**
 * Turning a recipe's free-text ingredient lines into structured ones.
 *
 * Kept apart from the tool so the decisions — which line counts as unparsed,
 * which parse result is good enough to write, what a written line looks like —
 * can be tested without a server. Every one of them fails silently if it is
 * wrong: Mealie accepts a line without a food, and a line with an unknown food
 * id, and stores both as plain text.
 */

/** UUIDs only: a parse result's id is written back as a reference. */
const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The text of an ingredient line nobody has structured yet, or `undefined` for
 * a line that is structured, partly structured, or has nothing to parse.
 *
 * Unparsed is the shape this server and Mealie's importer both write: no food,
 * no unit, no quantity, and the whole line in `note`. A line that carries any
 * of the three was structured by somebody, and is left alone rather than
 * re-guessed. So is a line that points at another recipe — it has no food on
 * purpose.
 */
export function unparsedText(line: unknown): string | undefined {
  const object = rec(line);
  if (isSet(object.food) || isSet(object.unit)) return undefined;
  if (isSet(object.referencedRecipe)) return undefined;
  if (typeof object.quantity === 'number' && object.quantity !== 0) {
    return undefined;
  }
  for (const candidate of [object.note, object.originalText, object.display]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return undefined;
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** A person's answer for one line the parser could not settle on its own. */
export interface LineOverride {
  food?: VocabularyRef | undefined;
  unit?: VocabularyRef | undefined;
}

/** A line that will be, or was, written in structured form. */
export interface StructuredLine {
  index: number;
  line: string;
  quantity: number;
  unit: string | null;
  food: string;
  note: string;
}

/** A line the parser could not settle, with what it suggested and why not. */
export interface UndecidedLine {
  index: number;
  line: string;
  reason: string;
  suggestion: {
    quantity: number;
    unit: string | null;
    unit_known: boolean;
    food: string | null;
    food_known: boolean;
    note: string;
  };
  confidence: number | undefined;
}

export interface ParsePlan {
  /** The full ingredient list to write, untouched lines included. */
  ingredients: unknown[];
  structured: StructuredLine[];
  undecided: UndecidedLine[];
}

/** The parts of a parser result this module reads, as plain values. */
interface ParsedParts {
  quantity: number;
  unit: { id: string | undefined; name: string } | null;
  food: { id: string | undefined; name: string } | null;
  note: string;
  confidence: number | undefined;
}

function vocabularyPart(
  value: unknown
): { id: string | undefined; name: string } | null {
  const object = rec(value);
  if (typeof object.name !== 'string' || object.name.trim() === '') return null;
  return {
    id:
      typeof object.id === 'string' && UUID_SHAPE.test(object.id)
        ? object.id
        : undefined,
    name: object.name.trim(),
  };
}

function partsOf(result: unknown): ParsedParts {
  const object = rec(result);
  const ingredient = rec(object.ingredient);
  const confidence = rec(object.confidence).average;
  const quantity = ingredient.quantity;
  return {
    quantity:
      typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0
        ? quantity
        : 0,
    unit: vocabularyPart(ingredient.unit),
    food: vocabularyPart(ingredient.food),
    note: typeof ingredient.note === 'string' ? ingredient.note.trim() : '',
    confidence:
      typeof confidence === 'number' && Number.isFinite(confidence)
        ? confidence
        : undefined,
  };
}

/**
 * Decides, line by line, what a parse run writes.
 *
 * `targets` are the indexes of the unparsed lines in `current`, in the order
 * their texts went to the parser, and `results` is the parser's answer in that
 * same order. A line is written when it has a food that exists, a unit that
 * exists or no unit at all, and either an override from the caller or a
 * confidence of at least `minConfidence`. Everything else stays exactly as it
 * was and is reported with the reason.
 *
 * A written line keeps everything Mealie had on it — the `referenceId` that
 * links it to the steps, its section title — and keeps the line as it was
 * written in `originalText`. `display` is dropped so Mealie renders it anew.
 */
export function planParse(
  current: readonly unknown[],
  targets: readonly { index: number; line: string }[],
  results: readonly unknown[],
  minConfidence: number,
  overrides: ReadonlyMap<number, LineOverride> = new Map()
): ParsePlan {
  if (results.length !== targets.length) {
    throw new ToolInputError(
      `Mealie's parser answered ${results.length} results for ${targets.length} lines`
    );
  }
  const ingredients = [...current];
  const structured: StructuredLine[] = [];
  const undecided: UndecidedLine[] = [];

  targets.forEach(({ index, line }, position) => {
    const parts = partsOf(results[position]);
    const override = overrides.get(index);
    const food =
      override?.food === undefined
        ? parts.food
        : { id: override.food.id, name: override.food.name };
    const unit =
      override?.unit === undefined
        ? parts.unit
        : { id: override.unit.id, name: override.unit.name };

    const verdict = settle(
      food,
      unit,
      parts.confidence,
      override !== undefined,
      minConfidence
    );
    if ('reason' in verdict) {
      undecided.push({
        index,
        line,
        reason: verdict.reason,
        suggestion: {
          quantity: parts.quantity,
          unit: unit?.name ?? null,
          unit_known: unit === null || unit.id !== undefined,
          food: food?.name ?? null,
          food_known: food !== null && food.id !== undefined,
          note: parts.note,
        },
        confidence: parts.confidence,
      });
      return;
    }

    const original = rec(current[index]);
    const kept: Record<string, unknown> = { ...original };
    delete kept.display;
    ingredients[index] = {
      ...kept,
      quantity: parts.quantity,
      unit: verdict.unit,
      food: verdict.food,
      note: parts.note,
      originalText:
        typeof original.originalText === 'string' &&
        original.originalText.trim() !== ''
          ? original.originalText
          : line,
    };
    structured.push({
      index,
      line,
      quantity: parts.quantity,
      unit: verdict.unit?.name ?? null,
      food: verdict.food.name,
      note: parts.note,
    });
  });

  return { ingredients, structured, undecided };
}

/**
 * Whether one parsed line may be written, and with which references.
 *
 * An override settles the confidence question — a person chose — but not the
 * vocabulary one: the references still have to exist, or Mealie stores the
 * line as no food at all.
 */
function settle(
  food: ParsedParts['food'],
  unit: ParsedParts['unit'],
  confidence: number | undefined,
  overridden: boolean,
  minConfidence: number
): { reason: string } | { food: VocabularyRef; unit: VocabularyRef | null } {
  if (food === null) return { reason: 'the parser found no food in this line' };
  if (food.id === undefined) {
    return { reason: `"${food.name}" is not one of this Mealie's foods` };
  }
  let unitRef: VocabularyRef | null = null;
  if (unit !== null) {
    if (unit.id === undefined) {
      return { reason: `"${unit.name}" is not one of this Mealie's units` };
    }
    unitRef = { id: unit.id, name: unit.name };
  }
  if (!overridden && confidence === undefined) {
    return { reason: 'the parser reported no confidence for this line' };
  }
  if (!overridden && confidence !== undefined && confidence < minConfidence) {
    return {
      // Rounded down, so the figure shown is never one that would
      // have passed.
      reason: `the parser's confidence ${(Math.floor(confidence * 1000) / 1000).toFixed(3)} is below ${minConfidence}`,
    };
  }
  return { food: { id: food.id, name: food.name }, unit: unitRef };
}
