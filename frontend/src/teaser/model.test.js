import test from 'node:test';
import assert from 'node:assert/strict';
import { blankProject, prepareFactors, editFactor, readyForLock, generateDraft as realGenerateDraft, canExport, draftIsCurrent, updateBrief, migrateProject, teaserSvg, prepareDrawingPlan, drawingPlanIsCurrent, generateReviewedDraft } from './model.js';
let imageId = 0;
const generateDraft = (p, visual = null) => realGenerateDraft(p, visual, async () => ({ok:true,json:async () => ({image:`data:image/jpeg;base64,test${++imageId}`,model:'test-image'})}));
function prepared() {
  const p = prepareFactors({ ...blankProject(), title: 'Study <&>', paper: 'Evidence from the paper.', insight: 'People steer visuals.', reaction: 'Understand the mechanism.', preserve: 'Core claim with limits.', audience: 'Researchers' });
  return { ...p, factors: { ...p.factors, mechanism: 'Edit selected factors.' }, meaningChecked: true, visual: { ...p.visual, analogy: 'A mixing console', rationale: 'Separate controls represent separate choices.' } };
}
test('brief fields are copied without inventing extracted mechanisms', async () => {
  assert.throws(() => prepareFactors(blankProject()), /Complete/);
  const p = prepared(); assert.equal(p.factors.insight, p.insight); assert.equal(p.factors.keepFixed,p.preserve);
  p.factors.mechanism = ''; assert.equal(readyForLock(p),false);
});
test('generation proceeds without human confirmation or a complete brief', async () => {
  const result=await generateDraft({...blankProject(),insight:'A purple dragon reading a book'});
  assert.equal(result.versions.length,1);
});
test('visual revision preserves fixed factors and immutable earlier snapshots', async () => {
  const first = await generateDraft(prepared()); const oldSvg = first.versions[0].image;
  const next = await generateDraft({...first,feedback:'Make insight more prominent'}, {...first.visual,layout:'finding-first',density:'insight-led'});
  assert.deepEqual(next.factors,first.factors); assert.equal(next.versions.length,2);
  assert.equal(next.versions[0].image,oldSvg); assert.notEqual(next.versions[1].image,oldSvg);
  assert.equal(next.versions[1].instruction,'Make insight more prominent');
  assert.deepEqual(next.versions[1].changes.map(c=>c.field),['Composition','Text emphasis','Feedback']);
  assert.equal(next.authorApproved,false); assert.equal(next.designerApproved,false);
});
test('editing factors makes earlier drafts stale without discarding them', async () => {
  const first=await generateDraft(prepared()); const next=editFactor(first,'insight','Corrected finding');
  assert.equal(next.versions.length,1); assert.equal(next.locked,false); assert.equal(draftIsCurrent(next),false);
});
test('export requires both approvals and a draft matching current inputs', async () => {
  const p=await generateDraft(prepared()); assert.equal(canExport(p),false);
  p.authorApproved=true; assert.equal(canExport(p),false); p.designerApproved=true; assert.equal(canExport(p),true);
  assert.equal(canExport(updateBrief(p,{paper:'Changed source'})),false);
  assert.equal(canExport({...p,visual:{...p.visual,tone:'blue'}}),false);
});
test('unchanged inputs can generate another image', async () => {
  const p=await generateDraft(prepared()); const next=await generateDraft(p,p.visual);
  assert.equal(next.versions.length,2);
});
test('legacy data migrates without losing the old project', async () => {
  const old={title:'Old',paper:'Original paper',factors:{S2:'Finding',S3:'Limits',A1:'Audience'},variants:[{svg:'old'}]};
  const p=migrateProject(old); assert.equal(p.insight,'Finding'); assert.equal(p.preserve,'Limits'); assert.equal(p.schema,2); assert.equal(p.legacyProject,old); assert.equal(p.locked,false);
});
test('SVG includes full claims and escapes markup', async () => {
  const p=prepared(); const svg=teaserSvg(p); assert.ok(svg.includes('Study &lt;&amp;&gt;'));
  assert.ok(svg.includes(p.factors.insight)); assert.ok(svg.includes(p.factors.keepFixed)); assert.ok(svg.includes(p.visual.analogy));
});

test('API receives the paper, fixed facts and feedback; failed requests keep history intact', async () => {
  const p=prepared();
  await realGenerateDraft(p, null, async (url, options) => {
    assert.equal(url, '/api/teaser/generate');
    const body=JSON.parse(options.body); assert.equal(body.paper,p.paper); assert.deepEqual(body.factors,p.factors);
    return {ok:true,json:async()=>({image:'data:image/jpeg;base64,result'})};
  });
  await assert.rejects(()=>realGenerateDraft(p,null,async()=>({ok:false,json:async()=>({detail:'Quota reached'})})),/Quota reached/);
  assert.equal(p.versions.length,0);
});
test('feedback alone can generate a revision', async () => {
  const p=await generateDraft(prepared());
  const revised=await generateDraft({...p,feedback:'Use a single connected scene'},p.visual);
  assert.equal(revised.versions.length,2); assert.deepEqual(revised.factors,p.factors);
});
test('validation errors identify the rejected field', async () => {
  await assert.rejects(() => realGenerateDraft(prepared(), null, async () => ({ok:false,status:422,json:async()=>({detail:[{loc:['body','paper'],msg:'String should have at most 1000000 characters'}]})})), /paper: String should have at most 1000000/);
});
test('papers above the old limit reach the API intact', async () => {
  const paper='x'.repeat(130000);
  await realGenerateDraft({...prepared(),paper}, null, async (url, options) => {
    assert.equal(JSON.parse(options.body).paper,paper);
    return {ok:true,json:async()=>({image:'data:image/jpeg;base64,result'})};
  });
});

test('plan review is invalidated by source, visual, or feedback changes', async () => {
  const planned=await prepareDrawingPlan(prepared(),null,async()=>({ok:true,json:async()=>({drawingBrief:'Draw the leaf.',groundingPlan:{subject:'Leaf'},planHash:'verified-plan'})}));
  assert.equal(drawingPlanIsCurrent(planned),true);
  assert.equal(drawingPlanIsCurrent({...planned,paper:'Different paper'}),false);
  assert.equal(drawingPlanIsCurrent({...planned,feedback:'New instruction'}),false);
  await generateReviewedDraft({...planned,visual:{...planned.visual,tone:'blue'}},async(url,options)=>{
    assert.equal(JSON.parse(options.body).reviewed_plan_hash,undefined);
    assert.equal(JSON.parse(options.body).visual.tone,'blue');
    return {ok:true,json:async()=>({image:'data:image/jpeg;base64,test'})};
  });
  const final=await generateReviewedDraft(planned,async(url,options)=>{
    assert.equal(JSON.parse(options.body).reviewed_plan_hash,'verified-plan');
    return {ok:true,json:async()=>({image:'data:image/jpeg;base64,test',groundingPlan:{subject:'Leaf'}})};
  });
  assert.equal(final.pendingDrawingPlan,null);
  assert.equal(final.versions[0].groundingPlan.subject,'Leaf');
});
