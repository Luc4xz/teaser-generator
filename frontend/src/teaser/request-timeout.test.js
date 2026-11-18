import test from 'node:test';
import assert from 'node:assert/strict';
import { withRequestTimeout } from './request-timeout.js';

test('a connection deadline aborts a stalled request and reports a retryable error',async()=>{
  let signal;
  await assert.rejects(withRequestTimeout(requestSignal=>{
    signal = requestSignal;
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },5),/server took too long to respond/);
  assert.equal(signal.aborted,true);
});

test('ordinary responses and errors complete without waiting for the connection deadline',async()=>{
  assert.equal(await withRequestTimeout(async()=>200),200);
  const error = new Error('Wrong password');
  await assert.rejects(withRequestTimeout(async()=>{throw error;}),failure=>failure === error);
});
