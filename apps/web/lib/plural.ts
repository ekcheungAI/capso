/**
 * "1 capture", "2 captures".
 *
 * Counting nouns appear in eight places across the app and every one of them
 * hardcoded the plural, so a library with one waiting capture greeted you with
 * "1 captures need a project". Small, but it is the first line on the home page
 * and it reads as carelessness in a product whose whole pitch is that it is more
 * organised than you are.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The matching verb, for sentences that continue past the noun. */
export const verb = (n: number, singular: string, pluralForm: string) =>
  n === 1 ? singular : pluralForm;
