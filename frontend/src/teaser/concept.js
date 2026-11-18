export const CONCEPT_FIELDS = [
  ['core_concept', 'Core concept', 1200], ['entities', 'Key entities', 1600],
  ['mechanism', 'Relationships & mechanism', 2000], ['finding', 'Main finding', 1600],
  ['evidence', 'Evidence & source excerpts', 2400], ['limitations', 'Limits & uncertainty', 1600],
];
export function conceptSource(project) { return JSON.stringify([project.paper || '']); }
export function conceptIsCurrent(project) {
  if (!project.scientificConcept) return false;
  try {
    // Accept saved [paper, prompt] fingerprints: the retired prompt no longer invalidates a concept.
    const source = JSON.parse(project.conceptSource);
    return Array.isArray(source) && (source.length === 1 || source.length === 2) && source[0] === (project.paper || '');
  } catch { return false; }
}
export function conceptIsReady(project) {
  return conceptIsCurrent(project) && CONCEPT_FIELDS.every(([key,,limit]) => typeof project.scientificConcept[key] === 'string' && project.scientificConcept[key].trim() && project.scientificConcept[key].length <= limit);
}
