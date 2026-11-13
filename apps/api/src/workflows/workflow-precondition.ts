export const WORKFLOW_CHANGED = 'The workflow was changed by someone else; reload it and try again';

const STRONG_ENTITY_TAG = /^"([^"]*)"$/;

export function entityTagOf(revision: number): string {
  return `"${revision}"`;
}

export function matchesPrecondition(ifMatch: string, revision: number): boolean {
  const candidates = ifMatch.split(',').map((candidate) => candidate.trim());
  if (candidates.length === 1 && candidates[0] === '*') return true;
  return candidates.some((candidate) => STRONG_ENTITY_TAG.exec(candidate)?.[1] === String(revision));
}
