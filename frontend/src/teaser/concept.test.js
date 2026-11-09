import test from 'node:test';
import assert from 'node:assert/strict';
import {CONCEPT_FIELDS, conceptSource, conceptIsReady} from './concept.js';
import {generationPayload} from './workspace.js';
import {inputSnapshot, addVersion, extractConcept} from './workflow.js';
const concept=Object.fromEntries(CONCEPT_FIELDS.map(([key])=>[key,`Reviewed ${key}`]));
function project() {const p={paper:'Paper A',userPrompt:'Explain the mechanism',scientificConcept:structuredClone(concept)};return {...p,conceptSource:conceptSource(p)};}

test('source changes invalidate concept but styling changes preserve it',()=>{
 const p=project();assert.equal(conceptIsReady(p),true);
 assert.equal(conceptIsReady({...p,paper:'Paper B'}),false);
 assert.equal(conceptIsReady({...p,userPrompt:'Explain something else'}),false);
 assert.equal(conceptIsReady({...p,visual:{layout:'split'}}),true);
 assert.equal(generationPayload({...p,paper:'Paper B'}).scientific_concept,null);
 assert.deepEqual(generationPayload(p).scientific_concept,concept);
});
test('blank required concept field prevents generation',()=>{
 const p=project();p.scientificConcept.evidence=' ';assert.equal(conceptIsReady(p),false);
});
test('version snapshots retain reviewed concept independently of later edits',()=>{
 const p=project();const snapshot=inputSnapshot(p);p.scientificConcept.mechanism='Changed';
 const next=addVersion(p,{image:'image',scientificConcept:concept,visualMapping:{composition:'Central leaf'}},snapshot,{},'run');
 assert.equal(next.canvasImages[0].inputSnapshot.scientificConcept.mechanism,'Reviewed mechanism');
 assert.equal(next.canvasImages[0].visualMapping.composition,'Central leaf');
 assert.equal(conceptIsReady(next.canvasImages[0].inputSnapshot),true);
});
test('concept extraction calls only concept endpoint and exposes API errors',async()=>{
 let url;
 assert.deepEqual(await extractConcept(project(),async target=>{url=target;return {ok:true,json:async()=>concept};}),concept);
 assert.ok(url.endsWith('/api/teaser/concept'));
 await assert.rejects(extractConcept(project(),async()=>({ok:false,json:async()=>({detail:'Credits exhausted'})})),/Credits exhausted/);
});

test('docking confirms the concept and locks all fields; returning restores prior locks',async()=>{
 const {dockConcept,undockConcept}=await import('./concept.js');
 const p={...project(),parameterLocks:{'scientificConcept.evidence':true,'visual.layout':true}};
 const docked=dockConcept(p);
 assert.equal(docked.conceptConfirmed,true);
 for(const [key] of CONCEPT_FIELDS)assert.equal(docked.parameterLocks[`scientificConcept.${key}`],true);
 assert.equal(p.parameterLocks['scientificConcept.finding'],undefined);
 assert.equal(dockConcept(docked),docked);
 const returned=undockConcept(docked);
 assert.equal(returned.conceptConfirmed,false);
 assert.equal(returned.parameterLocks['scientificConcept.evidence'],true);
 assert.equal(returned.parameterLocks['scientificConcept.finding'],false);
 assert.equal(returned.parameterLocks['visual.layout'],true);
 assert.deepEqual(returned.scientificConcept,p.scientificConcept);
 const snap=inputSnapshot(docked);
 assert.equal(snap.conceptConfirmed,true);
 assert.deepEqual(snap.conceptLocksBeforeDock,docked.conceptLocksBeforeDock);
});
test('stale and incomplete concepts cannot be docked',async()=>{
 const {dockConcept}=await import('./concept.js');
 const stale={...project(),paper:'Changed source'};
 assert.equal(dockConcept(stale),stale);
 const incomplete=project();incomplete.scientificConcept.finding='';
 assert.equal(dockConcept(incomplete),incomplete);
});
