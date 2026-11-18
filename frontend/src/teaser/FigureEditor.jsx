import React, { useRef, useState } from 'react';
import StudioDialog from './StudioDialog.jsx';
import { appendDrawingPoint, DRAWING_BRUSH, drawingBounds, figureGeometry, figureLayer, figureLayerName, flattenFigure, MAX_ALT_LENGTH, MAX_CAPTION_LENGTH, MAX_FIGURE_LAYERS, MAX_LABEL_LENGTH, moveDrawing, openFigureDraft, unit } from './figure.js';

function CoordinateField({name,value,onChange}) {
  return <label>{name}<input type="number" min="0" max="100" step="1" value={Math.round(unit(value)*100)} onChange={event=>onChange(unit(Number(event.target.value)/100))}/></label>;
}

function DrawingStroke({geometry, selected, onPointerDown}) {
  const {points,strokeWidth,color} = geometry;
  const [[x,y]] = points;
  const line = points.map(pair=>pair.join(',')).join(' ');
  const highlightWidth = strokeWidth+4;
  return <g className="figure-drawing-stroke" pointerEvents={onPointerDown ? undefined : 'none'} onPointerDown={onPointerDown}>
    {points.length === 1 ? <>
      {selected && <circle cx={x} cy={y} r={highlightWidth/2} fill="#b1d5ff"/>}
      <circle cx={x} cy={y} r={strokeWidth/2} fill={color}/>
      {onPointerDown && <circle cx={x} cy={y} r={Math.max(8,highlightWidth/2)} fill="transparent"/>}
    </> : <>
      {selected && <polyline points={line} stroke="#b1d5ff" strokeWidth={highlightWidth}/>}
      <polyline points={line} stroke={color} strokeWidth={strokeWidth}/>
      {onPointerDown && <polyline points={line} stroke="transparent" strokeWidth={Math.max(16,highlightWidth)}/>}
    </>}
  </g>;
}

function FigureStage({source, loaded, size, setSize, layers, selected, drawing, brush, working, onSelect, onMove, onDraw}) {
  const svg = useRef(null);
  const gesture = useRef(null);
  const [preview,setPreview] = useState(null);
  const {width,height} = size;
  const handleSize = Math.max(7,Math.min(width,height)*.014);

  function point(event) {
    const box = svg.current.getBoundingClientRect();
    return {x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height};
  }
  function start(event, layer, part) {
    if (drawing || working || gesture.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    svg.current.setPointerCapture(event.pointerId);
    gesture.current = {layer,part,initial:point(event),pointerId:event.pointerId};
    onSelect(layer.id);
  }
  function startOnCanvas(event) {
    if (working || gesture.current || event.button !== 0) return;
    if (!drawing) { onSelect(null); return; }
    event.preventDefault();
    svg.current.setPointerCapture(event.pointerId);
    const {x,y} = point(event);
    const stroke = {id:crypto.randomUUID(),type:'drawing',reference:'',...brush,points:appendDrawingPoint([],[x,y])};
    gesture.current = {stroke,pointerId:event.pointerId};
    setPreview(stroke);
  }
  function move(event) {
    const active = gesture.current;
    if (working || !active || active.pointerId !== event.pointerId) return;
    const destination = point(event);
    const {layer,part,initial,stroke} = active;
    if (stroke) {
      const points = appendDrawingPoint(stroke.points,[destination.x,destination.y]);
      if (points !== stroke.points) {
        active.stroke = {...stroke,points};
        setPreview(active.stroke);
      }
      return;
    }
    const dx = destination.x-initial.x, dy = destination.y-initial.y;
    if (layer.type === 'label') {
      onMove(layer.id,{x:unit(layer.x+dx),y:unit(layer.y+dy)});
    } else if (layer.type === 'drawing') {
      onMove(layer.id,{points:moveDrawing(layer.points,dx,dy)});
    } else if (part === 'start') {
      onMove(layer.id,{x1:unit(layer.x1+dx),y1:unit(layer.y1+dy)});
    } else if (part === 'end') {
      onMove(layer.id,{x2:unit(layer.x2+dx),y2:unit(layer.y2+dy)});
    } else {
      const x = Math.max(-Math.min(layer.x1,layer.x2),Math.min(1-Math.max(layer.x1,layer.x2),dx));
      const y = Math.max(-Math.min(layer.y1,layer.y2),Math.min(1-Math.max(layer.y1,layer.y2),dy));
      onMove(layer.id,{x1:unit(layer.x1+x),y1:unit(layer.y1+y),x2:unit(layer.x2+x),y2:unit(layer.y2+y)});
    }
  }
  function finish(event) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!active.stroke) return;
    setPreview(null);
    if (event.type === 'pointerup' && !working) {
      const {x,y} = point(event);
      onDraw({...active.stroke,points:appendDrawingPoint(active.stroke.points,[x,y])});
    }
  }

  return <div className="figure-stage" style={loaded ? {aspectRatio:width+'/'+height} : undefined}>
    <img src={source} alt="Figure preview" draggable={false}
      onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})}
      onError={()=>setSize({width:0,height:0,error:true})}/>
    {loaded && <svg ref={svg} viewBox={`0 0 ${width} ${height}`} className="figure-stage-overlay" aria-hidden="true" data-drawing={drawing}
      onPointerDown={startOnCanvas} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      {layers.map(layer=>{
        const geometry = figureGeometry(layer,width,height);
        const isSelected = layer.id === selected;
        if (layer.type === 'label') return <text key={layer.id} x={geometry.x} y={geometry.y}
          fontSize={geometry.fontSize} fontWeight="600" fontFamily="system-ui, sans-serif" dominantBaseline="central"
          fill="#151515" stroke={isSelected ? '#b1d5ff' : '#fff'} strokeLinejoin="round"
          strokeWidth={Math.max(2,geometry.fontSize*.13)} paintOrder="stroke fill"
          onPointerDown={event=>start(event,layer,'move')}>{layer.text || 'Label'}</text>;
        if (layer.type === 'drawing') return <DrawingStroke key={layer.id} geometry={geometry} selected={isSelected && !preview}
          onPointerDown={event=>start(event,layer,'move')}/>;
        const {x1,y1,x2,y2,shaft,tip} = geometry;
        return <g key={layer.id}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isSelected ? '#b1d5ff' : '#fff'} strokeWidth={shaft+2} strokeLinecap="round"/>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#151515" strokeWidth={shaft} strokeLinecap="round"/>
          {tip && <polygon points={tip.map(pair=>pair.join(',')).join(' ')} fill="#151515" stroke={isSelected ? '#b1d5ff' : '#fff'}
            strokeWidth="2" strokeLinejoin="round" paintOrder="stroke fill"/>}
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={2*handleSize}
            onPointerDown={event=>start(event,layer,'move')}/>
          {isSelected && <><circle className="figure-arrow-handle" cx={x1} cy={y1} r={handleSize} onPointerDown={event=>start(event,layer,'start')}/>
            <circle className="figure-arrow-handle" cx={x2} cy={y2} r={handleSize} onPointerDown={event=>start(event,layer,'end')}/></>}
        </g>;
      })}
      {preview && <DrawingStroke geometry={figureGeometry(preview,width,height)}/>}
    </svg>}
  </div>;
}

export default function FigureEditor({snapshot,images,onSave,onClose}) {
  const [draft,setDraft] = useState(()=>openFigureDraft(snapshot,images));
  const [selected,setSelected] = useState(draft.layers[0]?.id || null);
  const [size,setSize] = useState({width:0,height:0});
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState('');
  const [drawing,setDrawing] = useState(false);
  const [brush,setBrush] = useState(DRAWING_BRUSH);
  const layer = draft.layers.find(item=>item.id === selected);
  const loaded = Boolean(size.width && size.height);
  const canAdd = loaded && !saving && draft.layers.length < MAX_FIGURE_LAYERS;
  const drawingLayer = layer?.type === 'drawing' ? layer : null;
  const brushSettings = drawingLayer || brush;
  const bounds = drawingLayer && drawingBounds(drawingLayer.points);

  function updateLayer(id, change) {
    setDraft(previous=>({...previous,layers:previous.layers.map(item=>item.id === id ? {...item,...change} : item)}));
  }
  function insertLayer(next) {
    setDraft(previous=>previous.layers.length < MAX_FIGURE_LAYERS ? {...previous,layers:[...previous.layers,next]} : previous);
    setSelected(next.id);
    if (draft.layers.length+1 >= MAX_FIGURE_LAYERS) setDrawing(false);
  }
  function addLayer(type) {
    const offset = (draft.layers.length%4)*.055;
    setDrawing(false);
    insertLayer(figureLayer(type,{x:.30+offset,y:.40+offset}));
  }
  function updateBrush(change) {
    setBrush(previous=>({...previous,...change}));
    if (drawingLayer) updateLayer(drawingLayer.id,change);
  }
  function deleteLayer() {
    const layers = draft.layers.filter(item=>item.id !== selected);
    setDraft(previous=>({...previous,layers}));
    setSelected(drawing ? null : layers.at(-1)?.id || null);
  }
  async function save() {
    setSaving(true);
    setError('');
    try {
      const image = await flattenFigure(draft);
      onSave(draft,image);
    } catch (failure) {
      setError(failure.message);
    } finally { setSaving(false); }
  }

  return <StudioDialog id="figure-editor" open title="Edit figure" className="figure-editor-dialog"
    description="Add text, arrows, and drawings as layers. Saving creates a new version."
    onClose={onClose} working={saving}>
    <div className="figure-editor-grid">
      <div>
        <div className="figure-editor-toolbar">
          <button type="button" className="secondary-action" onClick={()=>addLayer('label')} disabled={!canAdd}>Add text</button>
          <button type="button" className="secondary-action" onClick={()=>addLayer('arrow')} disabled={!canAdd}>Add arrow</button>
          <button type="button" className="secondary-action" aria-pressed={drawing} disabled={!canAdd} onClick={()=>{
            if (!drawing) setSelected(null);
            setDrawing(!drawing);
          }}>Draw</button>
        </div>
        <FigureStage source={draft.base.image} size={size} setSize={setSize} loaded={loaded}
          layers={draft.layers} selected={selected} drawing={drawing && canAdd} brush={brush} working={saving}
          onSelect={setSelected} onMove={updateLayer} onDraw={insertLayer}/>
        {size.error && <p className="workspace-manager-error" role="alert">Could not load the figure.</p>}
      </div>
      <aside className="figure-editor-properties" aria-label="Figure properties">
        <div role="group" aria-label="Figure layers" className="figure-layer-list">
          {draft.layers.map((item,index)=><button type="button" className="secondary-action" key={item.id}
            aria-pressed={selected === item.id} onClick={()=>{setDrawing(false);setSelected(item.id);}}>{index+1}. {figureLayerName(item)}</button>)}
        </div>
        {(drawing || drawingLayer) && <fieldset className="figure-brush-fields" disabled={saving}>
          <label>Stroke color<input type="color" value={brushSettings.color} onChange={event=>updateBrush({color:event.target.value})}/></label>
          <label>Stroke width<input type="range" min="2" max="24" value={brushSettings.weight}
            onChange={event=>updateBrush({weight:Number(event.target.value)})}/></label>
        </fieldset>}
        {layer && <fieldset className="figure-layer-fields" disabled={saving}>
          {layer.type === 'label' ? <>
            <label>Label text<input maxLength={MAX_LABEL_LENGTH} value={layer.text} onChange={event=>updateLayer(layer.id,{text:event.target.value})}/></label>
            <div className="figure-coordinates">
              <CoordinateField name="Horizontal (%)" value={layer.x} onChange={x=>updateLayer(layer.id,{x})}/>
              <CoordinateField name="Vertical (%)" value={layer.y} onChange={y=>updateLayer(layer.id,{y})}/>
            </div>
          </> : drawingLayer ? <div className="figure-coordinates">
            <CoordinateField name="Horizontal (%)" value={bounds.left}
              onChange={x=>updateLayer(layer.id,{points:moveDrawing(layer.points,x-bounds.left,0)})}/>
            <CoordinateField name="Vertical (%)" value={bounds.top}
              onChange={y=>updateLayer(layer.id,{points:moveDrawing(layer.points,0,y-bounds.top)})}/>
          </div> : <>
            <label>Line style<select value={layer.directed !== false ? 'arrow' : 'connector'}
              onChange={event=>updateLayer(layer.id,{directed:event.target.value === 'arrow'})}>
              <option value="arrow">Arrow</option><option value="connector">Plain connector</option>
            </select></label>
            <div className="figure-coordinates">
              {['x1','y1','x2','y2'].map((key,index)=><CoordinateField key={key} name={['Start X (%)','Start Y (%)','End X (%)','End Y (%)'][index]}
                value={layer[key]} onChange={position=>updateLayer(layer.id,{[key]:position})}/>)}
            </div>
          </>}
          <label>Paper reference<input placeholder="Page or section (optional)" maxLength={240}
            value={layer.reference || ''} onChange={event=>updateLayer(layer.id,{reference:event.target.value})}/></label>
          <button type="button" className="secondary-action" onClick={deleteLayer}>Delete selected layer</button>
        </fieldset>}
        <fieldset className="figure-metadata-fields" disabled={saving}>
          <label>Caption<textarea value={draft.caption} maxLength={MAX_CAPTION_LENGTH} rows={2}
            onChange={event=>setDraft(previous=>({...previous,caption:event.target.value}))}/></label>
          <label>Alt text<textarea value={draft.altText} maxLength={MAX_ALT_LENGTH} rows={2}
            onChange={event=>setDraft(previous=>({...previous,altText:event.target.value}))}/></label>
        </fieldset>
      </aside>
    </div>
    {error && <p className="workspace-manager-error" role="alert">{error}</p>}
    <div className="figure-dialog-actions">
      <button type="button" className="secondary-action" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="figure-primary-action" onClick={save}
        disabled={saving || !loaded || draft.layers.some(item=>item.type === 'label' && !item.text.trim())}>
        {saving ? 'Saving…' : 'Save as new version'}
      </button>
    </div>
  </StudioDialog>;
}
