export const WORKFLOW_CHANGED = 'The workflow was changed by someone else; reload it and try again';

const ENTITY_TAG = /^(?:W\/)?"([^"]*)"$/;

export function entityTagOf(version: number): string {
  return `"${version}"`;
}

export function matchesPrecondition(ifMatch: string, version: number): boolean {
  const candidates = ifMatch.split(',').map((candidate) => candidate.trim());
  if (candidates.length === 1 && candidates[0] === '*') return true;
  return candidates.some((candidate) => ENTITY_TAG.exec(candidate)?.[1] === String(version));
}
