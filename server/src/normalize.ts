/**
 * Normalisation stricte des réponses françaises (PRD v0.2 §4.2) :
 * minuscules, accents supprimés, ponctuation supprimée, articles en tête
 * retirés (jusqu'à 2), espaces compressées. La comparaison ignore aussi le
 * « s » pluriel final (longueur > 3 pour éviter de casser « os », « tas »).
 */

const LEADING_ARTICLES = /^(le|la|les|l|un|une|du|de la|des|de|d|au|aux)\s+/;

export function normalizeFr(input: string): string {
  let t = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 2; i++) t = t.replace(LEADING_ARTICLES, '');
  return t;
}

function stripPlural(t: string): string {
  const parts = t.split(' ');
  const last = parts[parts.length - 1] ?? '';
  if (last.length > 3 && last.endsWith('s')) parts[parts.length - 1] = last.slice(0, -1);
  return parts.join(' ');
}

/** Égalité stricte normalisée entre réponse utilisateur et traduction attendue. */
export function frMatch(answer: string, expected: string): boolean {
  const a = normalizeFr(answer);
  const b = normalizeFr(expected);
  if (a === b) return true;
  return stripPlural(a) === stripPlural(b);
}
