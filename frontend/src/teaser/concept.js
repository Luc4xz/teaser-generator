export const CONCEPT_FIELDS = [
  ['core_concept', 'Core concept', 1200], ['entities', 'Key entities', 1600],
  ['mechanism', 'Relationships & mechanism', 2000], ['finding', 'Main finding', 1600],
  ['evidence', 'Evidence & source excerpts', 2400], ['limitations', 'Limits & uncertainty', 1600],
];
export function conceptSource(project) { return JSON.stringify([project.paper || '', project.userPrompt || '']); }
export function conceptIsCurrent(project) { return !!project.scientificConcept && project.conceptSource === conceptSource(project); }
export function conceptIsReady(project) {
  return conceptIsCurrent(project) && CONCEPT_FIELDS.every(([key,,limit]) => typeof project.scientificConcept[key] === 'string' && project.scientificConcept[key].trim() && project.scientificConcept[key].length <= limit);
}

export const CONCEPT_DRAG_TYPE = 'application/x-scientific-concept';
export function dockConcept(project) {
  if (!conceptIsReady(project) || project.conceptConfirmed) return project;
  const parameterLocks = {...project.parameterLocks};
  const conceptLocksBeforeDock = {};
  for (const [key] of CONCEPT_FIELDS) {
    const name = `scientificConcept.${key}`;
    conceptLocksBeforeDock[name] = !!parameterLocks[name];
    parameterLocks[name] = true;
  }
  return {...project, conceptConfirmed:true, conceptLocksBeforeDock, parameterLocks};
}
export function undockConcept(project) {
  if (!project.conceptConfirmed) return project;
  const parameterLocks = {...project.parameterLocks};
  for (const [key] of CONCEPT_FIELDS) {
    const name = `scientificConcept.${key}`;
    parameterLocks[name] = !!project.conceptLocksBeforeDock?.[name];
  }
  return {...project, conceptConfirmed:false, conceptLocksBeforeDock:null, parameterLocks};
}
