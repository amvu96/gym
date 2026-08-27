import { FRONT_MUSCLES } from './front.js';
import { BACK_MUSCLES } from './back.js';

/** The full default muscle registry (all genders and views). */
export const MUSCLES = [...FRONT_MUSCLES, ...BACK_MUSCLES];

/**
 * Canonical muscle groups, in head-to-toe display order. Every entry in the
 * built-in registry uses one of these. Handy for building legends, pickers, or
 * preset UIs without hard-coding the list.
 */
export const MUSCLE_GROUPS = [
  'chest',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'abs',
  'obliques',
  'upper_back',
  'lats',
  'lower_back',
  'glutes',
  'quads',
  'hamstrings',
  'calves',
];

const byId = new Map(MUSCLES.map((m) => [m.id, m]));

/** Look up a muscle definition by id in the default registry. */
export function getMuscle(id) {
  return byId.get(id);
}

/**
 * Muscles for a given gender + view, from `registry` (defaults to the built-in
 * one). Male and female anatomy differ, so masks are filtered by both.
 */
export function getMuscles(gender, view, registry = MUSCLES) {
  return registry.filter((m) => m.gender === gender && m.view === view);
}
