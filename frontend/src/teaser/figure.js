import { strToU8, zipSync } from 'fflate';

export const MAX_FIGURE_LAYERS = 40;
export const MAX_LABEL_LENGTH = 120;
export const MAX_CAPTION_LENGTH = 2000;
export const MAX_ALT_LENGTH = 1200;
export const DRAWING_BRUSH = {color:'#151515',weight:7};
const MAX_DRAWING_POINTS = 2048;

export function unit(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function figureLayer(type, point={x:.5,y:.5}) {
  const id = crypto.randomUUID();
  if (type === 'label') return {id,type,x:unit(point.x),y:unit(point.y),text:'Label',reference:''};
  const x = Math.min(unit(point.x),.94);
  const y = unit(point.y);
  return {id,type:'arrow',x1:x,y1:y,x2:Math.min(1,x+.19),y2:y,directed:true,reference:''};
}

export function appendDrawingPoint(points, [x,y]) {
  const next = [unit(x),unit(y)];
  const last = points.at(-1);
  if (last && Math.hypot(next[0]-last[0],next[1]-last[1]) < .0015) return points;
  const sampled = points.length < MAX_DRAWING_POINTS ? points : points.filter((_,index)=>index%2 === 0);
  return [...sampled,next];
}

export function drawingBounds(points) {
  return points.reduce(({left,top,right,bottom},[x,y])=>({
    left:Math.min(left,x),top:Math.min(top,y),right:Math.max(right,x),bottom:Math.max(bottom,y),
  }), {left:1,top:1,right:0,bottom:0});
}

export function moveDrawing(points, dx, dy) {
  const {left,top,right,bottom} = drawingBounds(points);
  const offsetX = Math.max(-left,Math.min(1-right,dx));
  const offsetY = Math.max(-top,Math.min(1-bottom,dy));
  return points.map(([x,y])=>[unit(x+offsetX),unit(y+offsetY)]);
}

export function figureLayerName(layer) {
  if (layer.type === 'label') return typeof layer.text === 'string' && layer.text || 'Label';
  if (layer.type === 'drawing') return 'Drawing';
  return layer.directed === false ? 'Connector' : 'Arrow';
}

function readLayers(layers) {
  if (!Array.isArray(layers)) return [];
  const seen = new Set();
  return layers.filter(layer=>['label','arrow','drawing'].includes(layer?.type)).slice(0,MAX_FIGURE_LAYERS).flatMap(layer=>{
    const id = typeof layer.id === 'string' && layer.id && !seen.has(layer.id) ? layer.id : crypto.randomUUID();
    seen.add(id);
    const common = {id,type:layer.type,
      reference:typeof layer.reference === 'string' ? layer.reference.slice(0,240) : ''};
    if (layer.type === 'label') return {...common,x:unit(layer.x),y:unit(layer.y),
      text:typeof layer.text === 'string' ? layer.text.slice(0,MAX_LABEL_LENGTH) : ''};
    if (layer.type === 'drawing') {
      const points = (Array.isArray(layer.points) ? layer.points.slice(0,MAX_DRAWING_POINTS) : [])
        .filter(point=>Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map(([x,y])=>[unit(x),unit(y)]);
      if (!points.length) return [];
      return {...common,points,
        color:typeof layer.color === 'string' && /^#[\da-f]{6}$/i.test(layer.color) ? layer.color : DRAWING_BRUSH.color,
        weight:Number.isFinite(layer.weight) ? Math.min(24,Math.max(2,layer.weight)) : DRAWING_BRUSH.weight};
    }
    return {...common,x1:unit(layer.x1),y1:unit(layer.y1),x2:unit(layer.x2),y2:unit(layer.y2),directed:layer.directed !== false};
  });
}

export function openFigureDraft(snapshot, images) {
  const original = images.find(image=>image.id === snapshot.figure?.baseSnapshotId);
  const base = original || snapshot;
  const layers = original ? readLayers(snapshot.figure?.layers) : [];
  if (!snapshot.figure && snapshot.inputSnapshot?.visual?.density === 'editable' && Array.isArray(snapshot.visualMapping?.labels)) {
    snapshot.visualMapping.labels.slice(0,4).filter(label=>typeof label === 'string' && label.trim())
      .forEach((label,index)=>layers.push({...figureLayer('label',{x:.07,y:.83+.042*index}),text:label.slice(0,MAX_LABEL_LENGTH)}));
  }
  return {
    base, layers,
    caption:typeof snapshot.figure?.caption === 'string' ? snapshot.figure.caption : '',
    altText:typeof snapshot.figure?.altText === 'string' ? snapshot.figure.altText : '',
  };
}

// The editor and raster export use the same geometry in image-space coordinates.
export function figureGeometry(layer, width, height) {
  const shortSide = Math.min(width,height);
  if (layer.type === 'label') {
    return {x:unit(layer.x)*width,y:unit(layer.y)*height,fontSize:Math.max(12,shortSide*.032)};
  }
  if (layer.type === 'drawing') return {
    points:layer.points.map(([x,y])=>[x*width,y*height]),
    strokeWidth:Math.max(1,shortSide*layer.weight/1000),color:layer.color,
  };
  const x1 = unit(layer.x1)*width, y1 = unit(layer.y1)*height;
  const x2 = unit(layer.x2)*width, y2 = unit(layer.y2)*height;
  const shaft = Math.max(2,shortSide*.004);
  const length = Math.hypot(x2-x1,y2-y1);
  const size = Math.min(length*.48,Math.max(9,shortSide*.023));
  const dx = length ? (x2-x1)/length : 0;
  const dy = length ? (y2-y1)/length : 0;
  const tip = layer.directed !== false && length > 0 ? [
    [x2,y2],
    [x2-dx*size+dy*size*.48,y2-dy*size-dx*size*.48],
    [x2-dx*size-dy*size*.48,y2-dy*size+dx*size*.48],
  ] : null;
  return {x1,y1,x2,y2,shaft,tip};
}

export function newFigureVersion(parent, draft, image, session, variant) {
  // Image lineage is separate from provider-run identity and board placement.
  const {id,position,runId,publishedAt,revisionFeedback,caption,altText,...content} = parent;
  return {
    ...content, id:crypto.randomUUID(), image, variant, versionKind:'figure_edit',
    createdAt:new Date().toISOString(), parentVersionId:id,
    creator:{userId:session.userId,displayName:session.displayName},
    figure:{baseSnapshotId:draft.base.id,layers:draft.layers,caption:draft.caption.trim(),altText:draft.altText.trim()},
  };
}

async function openImage(source) {
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(source || '')) throw new Error('This snapshot has no editable image.');
  const image = new Image();
  image.src = source;
  await image.decode().catch(()=>{throw new Error('Could not read the snapshot image.');});
  return image;
}

async function rasterPng(source, layers=[]) {
  const image = await openImage(source);
  const {naturalWidth,naturalHeight} = image;
  const scale = Math.min(1,4096/Math.max(naturalWidth,naturalHeight),Math.sqrt(4000000/(naturalWidth*naturalHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(naturalWidth*scale));
  canvas.height = Math.max(1,Math.round(naturalHeight*scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The browser could not render the edited figure.');
  ctx.drawImage(image,0,0,canvas.width,canvas.height);
  for (const layer of layers) {
    const bounds = figureGeometry(layer,canvas.width,canvas.height);
    ctx.fillStyle = '#151515';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (layer.type === 'drawing') {
      const {points,strokeWidth,color} = bounds;
      const [first,...rest] = points;
      ctx.beginPath();
      if (rest.length) {
        ctx.moveTo(...first);
        for (const point of rest) ctx.lineTo(...point);
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      } else {
        ctx.arc(...first,strokeWidth/2,0,Math.PI*2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      continue;
    }
    if (layer.type === 'label') {
      ctx.font = `600 ${bounds.fontSize}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2,bounds.fontSize*.13);
      ctx.strokeText(layer.text,bounds.x,bounds.y);
      ctx.fillText(layer.text,bounds.x,bounds.y);
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(bounds.x1,bounds.y1);
    ctx.lineTo(bounds.x2,bounds.y2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = bounds.shaft+2;
    ctx.stroke();
    ctx.strokeStyle = '#151515';
    ctx.lineWidth = bounds.shaft;
    ctx.stroke();
    if (bounds.tip) {
      ctx.beginPath();
      ctx.moveTo(...bounds.tip[0]);
      ctx.lineTo(...bounds.tip[1]);
      ctx.lineTo(...bounds.tip[2]);
      ctx.closePath();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fill();
    }
  }
  return new Promise((resolve,reject)=>canvas.toBlob(
    blob=>blob ? resolve(blob) : reject(new Error('The browser could not save a PNG.')),
    'image/png',
  ));
}

export async function flattenFigure(draft) {
  const png = await rasterPng(draft.base.image,draft.layers);
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = ()=>reject(new Error('The browser could not save the edited figure.'));
    reader.readAsDataURL(png);
  });
}

export async function approvedFigureArchive(snapshot, review) {
  if (review?.status !== 'approved' || review.snapshotId !== snapshot.id) {
    throw new Error('This version needs approval before exporting an approved figure.');
  }
  const png = snapshot.image.startsWith('data:image/png;base64,')
    ? await fetch(snapshot.image).then(response=>response.blob())
    : await rasterPng(snapshot.image);
  const archive = zipSync({
    'figure.png':new Uint8Array(await png.arrayBuffer()),
    'caption.txt':strToU8(review.caption),
    'alt-text.txt':strToU8(review.altText),
  },{level:0});
  return new Blob([archive],{type:'application/zip'});
}

export async function downloadApprovedFigure(snapshot, review) {
  const archive = await approvedFigureArchive(snapshot,review);
  const url = URL.createObjectURL(archive);
  const link = document.createElement('a');
  link.href = url;
  link.download = `approved-figure-${snapshot.variant || snapshot.id}.zip`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export const REVIEW_STATUS_LABEL = {pending:'In review',approved:'Approved',changes_requested:'Changes requested'};
