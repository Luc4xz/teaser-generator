import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveLockedValues } from './locks.js';
import { generationPayload } from './workspace.js';
import { inputSnapshot } from './workflow.js';

test('locks preserve individual values without preventing unlocked edits or mutating versions',()=>{
 const old={paper:'Old paper',fileName:'old.pdf',visual:{layout:'split',density:'none'},scientificConcept:{finding:'Keep finding',mechanism:'Old mechanism'},parameterLocks:{paper:true,'visual.layout':true,'scientificConcept.finding':true}};
 const proposed={paper:'New paper',fileName:'new.pdf',visual:{layout:'central',density:'balanced'},scientificConcept:{finding:'New finding',mechanism:'New mechanism'}};
 const result=preserveLockedValues(proposed,old);
 assert.equal(result.paper,'Old paper');assert.equal(result.fileName,'old.pdf');
 assert.deepEqual(result.visual,{layout:'split',density:'balanced'});
 assert.deepEqual(result.scientificConcept,{finding:'Keep finding',mechanism:'New mechanism'});
 assert.equal(proposed.visual.layout,'central');assert.equal(old.scientificConcept.mechanism,'Old mechanism');
});
test('stale concepts still send locked values for regeneration and snapshots retain locks',()=>{
 const p={paper:'Changed paper',scientificConcept:{finding:'Preserve'},parameterLocks:{'scientificConcept.finding':true},conceptSource:'old'};
 const payload=generationPayload(p);
 assert.equal(payload.scientific_concept,null);assert.equal(payload.previous_concept.finding,'Preserve');
 assert.deepEqual(payload.parameter_locks,['scientificConcept.finding']);
 const snap=inputSnapshot(p);p.parameterLocks['scientificConcept.finding']=false;
 assert.equal(snap.parameterLocks['scientificConcept.finding'],true);
});
