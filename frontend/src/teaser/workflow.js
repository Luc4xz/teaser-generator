import { conceptSource } from './concept.js';
import { API_BASE, generationPayload } from './workspace.js';

export function inputSnapshot(project) {
  return Object.fromEntries(['paper','fileName','title','userPrompt','audience','preserve','preferences','visual','scientificConcept','conceptSource','parameterLocks','conceptConfirmed','conceptLocksBeforeDock'].map(key=>[key,structuredClone(project[key] ?? ((key==='visual'||key==='parameterLocks')?{}:key==='scientificConcept'?null:''))]));
}
export function refinementPayload(snapshot, options={}) {
  return {...generationPayload(snapshot), feedback:options.feedback || '', restart_from:options.restartFrom || 'plan',
    drawing_prompt:options.drawingPrompt || '', parent_version_id:options.parentId || ''};
}
async function responseJSON(response) {
  const value=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(typeof value.detail==='string'?value.detail:Array.isArray(value.detail)?value.detail.map(e=>e.msg).join('; '):`Request failed (${response.status}).`);
  return value;
}
export async function extractConcept(project, request=fetch) {
  return responseJSON(await request(`${API_BASE}/api/teaser/concept`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(generationPayload(project))}));
}
export async function startWorkflow(snapshot,options={},request=fetch) {
  return responseJSON(await request(`${API_BASE}/api/teaser/runs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(refinementPayload(snapshot,options))}));
}
export async function pollWorkflow(id,onProgress,request=fetch,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  for(let i=0;i<900;i++) {
    const run=await responseJSON(await request(`${API_BASE}/api/teaser/runs/${encodeURIComponent(id)}`));
    onProgress(run);
    if(run.status==='failed') throw new Error(run.message);
    if(run.status==='complete') {
      if(!/^data:image\/(jpeg|png|webp);base64,/.test(run.result?.image || '')) throw new Error('The run completed without a usable image.');
      return run.result;
    }
    await pause(1000);
  }
  throw new Error('This run is taking too long. Your earlier versions are safe.');
}
export function addVersion(project,result,snapshot,options,runId) {
  if((project.canvasImages||[]).some(v=>v.runId===runId)) return project;
  const item={...result,id:crypto.randomUUID(),runId,createdAt:new Date().toISOString(),
    variant:(project.canvasImages||[]).length+1,inputSnapshot:result.scientificConcept ? {...snapshot,scientificConcept:result.scientificConcept,conceptSource:conceptSource(snapshot)} : snapshot,userPrompt:snapshot.userPrompt,
    paperName:snapshot.fileName || (snapshot.paper?'Pasted paper':''),parentVersionId:options.parentId||null,
    revisionFeedback:options.feedback||'',restartFrom:options.restartFrom||'plan'};
  return {...project,canvasImages:[...(project.canvasImages||[]),item],activeCanvasId:item.id,pendingRun:null};
}
