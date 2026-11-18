import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardInvite } from './board-invite.js';

const app = 'https://example.org/research/';
const board = '8-aBoard_id';

test('join accepts the board ID and full invite URL',()=>{
  assert.equal(parseBoardInvite(`  ${board}  `,app),board);
  assert.equal(parseBoardInvite(`${app}?board=${board}&view=canvas#control-center`,app),board);
  assert.equal(parseBoardInvite(`?board=${board}`,app),board);
});

test('join rejects addresses without a usable board ID',()=>{
  for (const invalid of ['',app,`${app}?board=`,`${app}?board=one%2Ftwo`,`file:///research?board=${board}`]) {
    assert.equal(parseBoardInvite(invalid,app),null);
  }
});
