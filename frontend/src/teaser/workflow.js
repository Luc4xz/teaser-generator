import { authHeaders, checkSessionResponse } from './session.js';
import { conceptSource } from './concept.js';
import { API_BASE, generationPayload } from './workspace.js';

export class RunStoppedError extends Error {}

export function inputSnapshot(project) {
  return Object.fromEntries(['textModel','imageModel','paper','fileName','title','userPrompt','audience','preserve','preferences','visual','scientificConcept','conceptSource'].map(key=>[key,structuredClone(project[key] ?? (key==='visual'?{}:key==='scientificConcept'?null:''))]));
}
export function refinementPayload(snapshot, options={}) {
  return {...generationPayload({...snapshot,userPrompt:'',insight:''}), feedback:options.feedback || '', restart_from:options.restartFrom || 'plan',
    drawing_prompt:options.drawingPrompt || '', parent_version_id:options.parentId || ''};
}
async function responseJSON(response) {
  checkSessionResponse(response);
  const value=await response.json().catch(()=>({}));
  if(!response.ok) {
    const fallback = response.status >= 500
      ? `The backend or its proxy could not complete the request (HTTP ${response.status}). Check that the API server is running and reachable, then retry.`
      : `Request failed (${response.status}).`;
    throw new Error(typeof value.detail==='string'?value.detail:Array.isArray(value.detail)?value.detail.map(e=>e.msg).join('; '):fallback);
  }
  return value;
}
export async function extractConcept(project, request=fetch) {
  return responseJSON(await request(`${API_BASE}/api/teaser/concept`, {method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(generationPayload({...project,userPrompt:'',insight:''}))}));
}
export async function startConceptRun(project, request=fetch) {
  const response=await request(`${API_BASE}/api/teaser/concept-runs`, {method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(generationPayload({...project,userPrompt:'',insight:''}))});
  if(response.status===404)throw new Error('The connected server does not support concept progress yet. Restart or update the backend, then retry.');
  return responseJSON(response);
}
export async function pollConceptRun(id,onProgress,request=fetch,pause=pollDelay,signal) {
  return pollRun(id,onProgress,request,pause,signal,'The concept is still processing. Reconnect to check its progress.');
}
export async function startWorkflow(snapshot,options={},request=fetch) {
  return responseJSON(await request(`${API_BASE}/api/teaser/runs`,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(refinementPayload(snapshot,options))}));
}
export async function cancelRun(id, request=fetch) {
  return responseJSON(await request(`${API_BASE}/api/teaser/runs/${encodeURIComponent(id)}/cancel`,{method:'POST',headers:authHeaders()}));
}

function pollDelay(ms,signal) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(()=>{
      signal?.removeEventListener('abort',abort);
      resolve();
    },ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

async function pollRun(id,onProgress,request,pause,signal,timeoutMessage) {
  for(let i=0;i<900;i++) {
    signal?.throwIfAborted();
    const run=await responseJSON(await request(`${API_BASE}/api/teaser/runs/${encodeURIComponent(id)}`,{headers:authHeaders(),signal}));
    signal?.throwIfAborted();
    onProgress(run);
    if(run.status==='failed') throw new Error(run.message);
    if(run.status==='cancelled') throw new RunStoppedError(run.message);
    if(run.status==='complete') return run.result;
    await pause(1000,signal);
  }
  throw new Error(timeoutMessage);
}
export async function pollWorkflow(id,onProgress,request=fetch,pause=pollDelay,signal) {
  const result = await pollRun(id,onProgress,request,pause,signal,'This run is taking too long. Your earlier versions are safe.');
  if(!/^data:image\/(jpeg|png|webp);base64,/.test(result?.image || '')) throw new Error('The run completed without a usable image.');
  return result;
}
export function addVersion(project,result,snapshot,options,runId) {
  if((project.canvasImages||[]).some(v=>v.runId===runId)) return project;
  const item={...result,id:crypto.randomUUID(),runId,createdAt:new Date().toISOString(),
    creator:options.creator || null,
    variant:(project.canvasImages||[]).length+1,inputSnapshot:result.scientificConcept ? {...snapshot,scientificConcept:result.scientificConcept,conceptSource:conceptSource(snapshot)} : snapshot,userPrompt:snapshot.userPrompt,
    paperName:snapshot.fileName || (snapshot.paper?'Pasted paper':''),parentVersionId:options.parentId||null,
    revisionFeedback:options.feedback||'',restartFrom:options.restartFrom||'plan'};
  return {...project,canvasImages:[...(project.canvasImages||[]),item],activeCanvasId:item.id,pendingRun:null};
}
