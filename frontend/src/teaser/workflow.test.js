import test from 'node:test';
import assert from 'node:assert/strict';
import {inputSnapshot,refinementPayload,pollWorkflow,addVersion} from './workflow.js';

test('refinement uses an immutable input snapshot without copying image history',()=>{
 const project={paper:'Original paper',userPrompt:'Draw leaves',visual:{layout:'split'},canvasImages:[{image:'large'}]};
 const snap=inputSnapshot(project);project.visual.layout='central';project.paper='Changed paper';
 assert.equal(snap.paper,'Original paper');assert.equal(snap.visual.layout,'split');assert.equal(snap.canvasImages,undefined);
 const payload=refinementPayload(snap,{parentId:'v1',restartFrom:'render',drawingPrompt:'Saved prompt',feedback:'Simplify'});
 assert.equal(payload.parent_version_id,'v1');assert.equal(payload.drawing_prompt,'Saved prompt');assert.equal(payload.feedback,'Simplify');
});
test('new versions preserve originals and branch from the selected parent',()=>{
 const original={id:'v1',image:'original',variant:1};const project={canvasImages:[original]};
 const next=addVersion(project,{image:'new'}, {userPrompt:'leaf'},{parentId:'v1',feedback:'Simplify'},'run2');
 assert.equal(project.canvasImages.length,1);assert.equal(next.canvasImages.length,2);assert.equal(next.canvasImages[0],original);
 assert.equal(next.canvasImages[1].parentVersionId,'v1');assert.equal(next.canvasImages[1].variant,2);
 assert.equal(next.activeCanvasId,next.canvasImages[1].id);
 assert.equal(addVersion(next,{image:'duplicate'},{},{},'run2'),next);
});
test('polling displays genuine stage updates and finishes only with an image',async()=>{
 const states=[{status:'running',stage:'plan'},{status:'running',stage:'render'},{status:'complete',result:{image:'data:image/png;base64,eA=='}}];
 const seen=[];
 const result=await pollWorkflow('job',r=>seen.push(r.stage||r.status),async()=>({ok:true,json:async()=>states.shift()}),async()=>{});
 assert.deepEqual(seen,['plan','render','complete']);assert.ok(result.image);
});
test('a failed run exposes its prompt before reporting the error',async()=>{
 let seen;
 await assert.rejects(pollWorkflow('job',run=>{seen=run;},async()=>({ok:true,json:async()=>({status:'failed',message:'Quota',artifacts:{drawingPrompt:'Ready to retry'}})}),async()=>{}),/Quota/);
 assert.equal(seen.artifacts.drawingPrompt,'Ready to retry');
});
