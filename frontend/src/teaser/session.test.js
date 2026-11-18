import test from 'node:test';
import assert from 'node:assert/strict';
import {readSession, saveSession, authHeaders, checkSessionResponse, SESSION_EXPIRED} from './session.js';
import {inputSnapshot, startConceptRun, startWorkflow, pollConceptRun, refinementPayload} from './workflow.js';

test('authenticated generation carries both model selections and token through submission and polling',async()=>{
  const values = new Map();
  globalThis.localStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  try {
    saveSession({token:'test-token',expiresAt:Date.now()+60000});
    const project={paper:'Paper',textModel:'claude',imageModel:'gemini-image'};
    const snapshot=inputSnapshot(project);project.textModel='changed';
    assert.equal(refinementPayload(snapshot).text_model,'claude');
    assert.equal(refinementPayload(snapshot).image_model,'gemini-image');
    const request=async(url,options)=>{
      assert.equal(options.headers.Authorization,'Bearer test-token');
      if(options.body){const body=JSON.parse(options.body);assert.equal(body.text_model,'claude');assert.equal(body.image_model,'gemini-image');}
      return {ok:true,json:async()=>({id:'job',status:'complete',result:{core_concept:'Idea'}})};
    };
    await startConceptRun(snapshot,request);await startWorkflow(snapshot,{},request);await pollConceptRun('job',()=>{},request);
    saveSession({token:'expired',expiresAt:Date.now()-1});assert.equal(readSession(),null);assert.deepEqual(authHeaders(),{});
  } finally {delete globalThis.localStorage;}
});

test('a server rejection clears the session and asks the login gate to reopen',()=>{
  let removed, event;
  globalThis.localStorage={removeItem:key=>{removed=key;}};
  globalThis.window={dispatchEvent:value=>{event=value.type;}};
  try {checkSessionResponse({status:401});assert.equal(removed,'research-board-session');assert.equal(event,SESSION_EXPIRED);}
  finally {delete globalThis.localStorage;delete globalThis.window;}
});
