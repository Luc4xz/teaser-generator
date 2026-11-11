import { blankProject } from './model.js';

export function identifyProject(project) {
  return {...project, projectId:project.projectId || crypto.randomUUID(), projectName:project.projectName?.trim() || project.fileName?.replace(/\.[^.]+$/, '') || 'Untitled project', createdAt:project.createdAt || new Date().toISOString()};
}
export function createProject(name='Untitled project') {
  const blank = blankProject();
  const visual = Object.fromEntries([...Object.keys(blank.visual), 'representation', 'purpose'].map(key => [key, '']));
  return identifyProject({...blank,visual,projectName:name.trim() || 'Untitled project',userPrompt:'',canvasImages:[],activeCanvasId:null,pendingRun:null,scientificConcept:null,conceptConfirmed:false,conceptSource:'',parameterLocks:{},conceptLocksBeforeDock:null});
}
export function projectSummary(project, updatedAt) {
  return {id:project.projectId,name:project.projectName,createdAt:project.createdAt,updatedAt,
    fileName:project.fileName || '',versionCount:project.canvasImages?.length || 0,
    hasConcept:!!project.scientificConcept,conceptConfirmed:!!project.conceptConfirmed};
}
