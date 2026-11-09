import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImages, generationPayload } from './workspace.js';

const ok = () => ({ ok: true, json: async () => ({ image: 'data:image/png;base64,eA==', drawingBrief: 'A leaf' }) });
test('foldable options reach generation without removed legacy fields', () => {
  const payload = generationPayload({ userPrompt: 'Show leaves', insight: 'Gas exchange', title: 'Leaf study', preserve: 'No invented values', preferences: 'Line art', audience: 'Students', reaction: 'Understand tradeoffs', factors: { mechanism: 'Pores open' }, visual: { analogy: 'Doors', rationale: 'Controlled openings', headline: 'Gas exchange', layout: 'split', density: 'none', tone: 'sage', representation: 'abstract', purpose: 'evoke' } });
  assert.equal(payload.user_prompt, 'Show leaves');
  assert.deepEqual(payload.factors, { insight:'', mechanism:'', audience:'Students', keepFixed:'No invented values' });
  assert.equal(payload.title, '');
  assert.equal(payload.preferences, 'Line art');
  assert.equal(payload.reaction, '');
  assert.deepEqual(payload.visual, { headline:'', analogy:'', rationale:'', layout:'split', density:'none', tone:'neutral', representation:'abstract', purpose:'evoke' });
});
test('three images arrive sequentially using a frozen prompt snapshot', async () => {
  const project = { userPrompt: 'Show leaves' }; const events = []; const payloads = [];
  await generateImages(project, 3, async (item, n) => {
    events.push(`image${n}`); assert.equal(item.variant,n); project.userPrompt = 'Changed';
  }, async (_, options) => { events.push('request'); payloads.push(JSON.parse(options.body)); return ok(); });
  assert.deepEqual(events, ['request','image1','request','image2','request','image3']);
  assert.ok(payloads.every(p => p.user_prompt === 'Show leaves'));
});
test('later provider failure leaves earlier results delivered', async () => {
  const images = []; let calls = 0;
  await assert.rejects(generateImages({ userPrompt: 'A leaf' }, 3, item => images.push(item), async () => {
    if (++calls === 1) return ok();
    return { ok:false, status:429, json:async()=>({ detail:'Please retry after cooldown.' }) };
  }), /cooldown/);
  assert.equal(images.length,1); assert.equal(calls,2);
});
test('missing image cannot be recorded as successful output', async () => {
  await assert.rejects(generateImages({ paper:'Leaves exchange gases.' }, 1, () => assert.fail(), async () => ({ ok:true, json:async()=>({}) })), /no usable image/);
});
test('empty input and invalid counts never call provider', async () => {
  const network = () => assert.fail();
  await assert.rejects(generateImages({},1,()=>{},network), /Upload a paper/);
  await assert.rejects(generateImages({ userPrompt:'leaf' },4,()=>{},network), /1 and 3/);
});

test('queued generation polls and only records a completed image', async () => {
  const progress=[]; const images=[]; const calls=[];
  const replies=[{status:'queued',jobId:'job'}, {status:'rendering',jobId:'job',queuePosition:0}, {image:'data:image/png;base64,eA=='}];
  await generateImages({userPrompt:'Leaf'},1,item=>images.push(item),async(url)=>{calls.push(url);return {ok:true,json:async()=>replies.shift()};},state=>progress.push(state.status),async()=>{});
  assert.deepEqual(progress,['queued','rendering']);
  assert.equal(images.length,1);
  assert.ok(calls[1].endsWith('/api/teaser/jobs/job'));
});

test('queue failure never records a placeholder', async () => {
  let call=0;
  await assert.rejects(generateImages({userPrompt:'Leaf'},1,()=>assert.fail(),async()=>++call===1 ? {ok:true,json:async()=>({status:'queued',jobId:'job'})} : {ok:false,json:async()=>({detail:'Worker failed'})},()=>{},async()=>{}), /Worker failed/);
});
