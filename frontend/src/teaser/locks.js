export const PARAMETER_KEYS = ['paper','audience','preserve','preferences','visual.representation','visual.purpose','visual.layout','visual.density', ...['core_concept','entities','mechanism','finding','evidence','limitations'].map(key=>`scientificConcept.${key}`)];
export function lockedParameters(project) { return PARAMETER_KEYS.filter(key=>project.parameterLocks?.[key]); }
export function preserveLockedValues(next, current) {
  const result={...next};
  for(const path of lockedParameters(current)) {
    const [group,key]=path.split('.');
    if(key) result[group]={...(result[group]||{}),[key]:current[group]?.[key]};
    else result[group]=current[group];
    if(path==='paper')result.fileName=current.fileName;
  }
  result.parameterLocks={...(current.parameterLocks||{})};
  return result;
}
