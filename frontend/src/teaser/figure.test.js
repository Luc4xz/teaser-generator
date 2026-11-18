import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { appendDrawingPoint, approvedFigureArchive, figureGeometry, moveDrawing, newFigureVersion, openFigureDraft } from './figure.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=';
const source = {id:'original',image:png,runId:'generation',position:{x:3,y:5},creator:{userId:'first'},
  inputSnapshot:{visual:{density:'editable'}},visualMapping:{labels:['24 participants']}};

test('edited figure versions keep layers and lineage independent of the original',()=>{
  const draft = openFigureDraft(source,[source]);
  assert.equal(draft.layers[0].text,'24 participants');
  draft.layers[0] = {...draft.layers[0],text:'18 participants',reference:'Page 4'};
  const saved = newFigureVersion(source,draft,png,{userId:'second',displayName:'A coauthor'},2);
  assert.equal(saved.versionKind,'figure_edit');
  assert.equal(saved.parentVersionId,source.id);
  assert.equal(saved.runId,undefined);
  assert.equal(saved.position,undefined);
  assert.equal(saved.creator.userId,'second');
  const reopened = openFigureDraft(saved,[source,saved]);
  assert.equal(reopened.base,source);
  assert.equal(reopened.layers[0].text,'18 participants');
  assert.equal(reopened.layers[0].reference,'Page 4');
  assert.equal(source.visualMapping.labels[0],'24 participants');
});

test('a connector shares the arrow geometry without a directional tip',()=>{
  const arrow = {type:'arrow',x1:.1,y1:.2,x2:.6,y2:.3,directed:true};
  const geometry = figureGeometry(arrow,100,200);
  assert.deepEqual(geometry.tip[0],[60,60]);
  assert.equal(figureGeometry({...arrow,directed:false},100,200).tip,null);
});

test('drawings stay editable after saving and move as one stroke',()=>{
  const draft = openFigureDraft(source,[source]);
  const points = [[.25,.25],[.5,.125],[.75,.375]];
  draft.layers.push({id:'brush-stroke',type:'drawing',points,color:'#c83520',weight:12,reference:'Page 5'});
  const saved = newFigureVersion(source,draft,png,{userId:'first',displayName:'Author'},2);
  const reopened = openFigureDraft(saved,[source,saved]);
  const stroke = reopened.layers[1];
  assert.deepEqual(stroke,draft.layers[1]);
  assert.deepEqual(figureGeometry(stroke,1000,500),{
    points:[[250,125],[500,62.5],[750,187.5]],color:'#c83520',strokeWidth:6,
  });
  assert.deepEqual(moveDrawing(stroke.points,1,-1),[[.5,.125],[.75,0],[1,.25]]);
  assert.deepEqual(stroke.points,points);
});

test('long freehand gestures keep their start and latest point',()=>{
  let points = appendDrawingPoint([],[-.3,.5]);
  assert.equal(appendDrawingPoint(points,[.0002,.5]),points);
  for (let step=0;step<2500;step++) {
    points = appendDrawingPoint(points,[(step%2)+.25,.6]);
  }
  assert.ok(points.length <= 2048);
  assert.deepEqual(points[0],[0,.5]);
  assert.deepEqual(points.at(-1),[1,.6]);
});

test('a package requires approval of the exact snapshot and includes its reviewed text',async()=>{
  const review = {snapshotId:'original',status:'approved',caption:'Reviewed caption',altText:'Reviewed alternative text'};
  await assert.rejects(approvedFigureArchive({...source,id:'child'},review),/needs approval/);
  await assert.rejects(approvedFigureArchive(source,{...review,status:'changes_requested'}),/needs approval/);
  const files = unzipSync(new Uint8Array(await (await approvedFigureArchive(source,review)).arrayBuffer()));
  assert.deepEqual([...files['figure.png'].slice(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(strFromU8(files['caption.txt']),review.caption);
  assert.equal(strFromU8(files['alt-text.txt']),review.altText);
});
