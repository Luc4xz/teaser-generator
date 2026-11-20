import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, { Background, MiniMap, Handle, Position, applyNodeChanges } from 'reactflow';
import 'reactflow/dist/style.css';
import { CONCEPT_FIELDS } from './concept.js';
import Icon from './StudioIcon.jsx';
import StudioDialog from './StudioDialog.jsx';
import { CanvasAvatars } from './StudioTools.jsx';

function SnapshotDetails({item, number, kind, open, onClose}) {
  const concept = item.scientificConcept || item.inputSnapshot?.scientificConcept;
  const review = item.coverReview;
  const showConcept = kind === 'concept';
  return <StudioDialog id="snapshot-details-dialog" open={open} title={showConcept ? 'Scientific concepts & values' : 'Cover quality'}
    description={`Version ${number}${showConcept ? '' : ` · ${review.weightedScore}/10`}`}
    className="snapshot-details-dialog" onClose={onClose}>
    {showConcept ? <dl className="snapshot-detail-list">
      {CONCEPT_FIELDS.map(([key,label])=><React.Fragment key={key}>
        <dt>{label}</dt><dd>{concept?.[key] || 'Not recorded'}</dd>
      </React.Fragment>)}
    </dl> : <>
      <p>{review.summary}</p>
      {review.accepted === false && <p><strong>Issues:</strong> {review.rejectionReasons?.map(reason=>reason.replaceAll('_',' ')).join('; ')}</p>}
      {review.warnings?.map(warning=><p key={warning.id}><strong>Review note: {warning.id.replaceAll('_',' ')}</strong> — {warning.evidence}</p>)}
      <dl className="snapshot-detail-list">
        {review.scores?.map(score=><React.Fragment key={score.id}>
          <dt>{score.id.replaceAll('_',' ')} · {score.score}/10</dt><dd>{score.evidence}</dd>
        </React.Fragment>)}
      </dl>
      <p>Automated visual review. Scientific accuracy still needs human review.</p>
      {item.coverReferences?.map(reference=><p key={reference.id}><a href={reference.source_url} target="_blank" rel="noreferrer">{reference.artwork_title}</a> · {reference.author || reference.cover_designer || reference.journal}</p>)}
    </>}
  </StudioDialog>;
}

const SnapshotNode=memo(function SnapshotNode({data,selected}) {
  const item=data.item, concept=item.scientificConcept || item.inputSnapshot?.scientificConcept;
  return <article className={`snapshot-node ${selected?'is-selected':''}`}>
    <Handle type="target" position={Position.Left}/>
    <header><span>SNAPSHOT {data.number.toString().padStart(2,'0')}</span><span>{item.versionKind === 'figure_edit' ? 'Figure edit' : item.parentVersionId ? 'Iteration' : 'Original'}</span></header>
    <img draggable="false" src={item.image} alt={item.figure?.altText || concept?.core_concept || 'Generated research illustration'}/>
    <div className="snapshot-body"><h3>{concept?.core_concept || item.userPrompt || 'Research illustration'}</h3>
    <div className="snapshot-credit"><strong>Creator: {item.creator?.displayName || 'Unknown · legacy snapshot'}</strong><time dateTime={item.createdAt}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Time unavailable'}</time></div>
    <div className="snapshot-detail-actions">
      <button type="button" className="nodrag secondary-action" aria-haspopup="dialog" onClick={event=>{event.stopPropagation();data.onDetails(item.id,'concept');}}>Scientific concepts &amp; values</button>
      {item.coverReview && <button type="button" className="nodrag secondary-action" aria-haspopup="dialog" onClick={event=>{event.stopPropagation();data.onDetails(item.id,'quality');}}>Cover quality · {item.coverReview.weightedScore}/10</button>}
    </div>
    {item.coverReview?.accepted === false && <p className="snapshot-feedback" role="status"><strong>Needs manual review</strong> — automated quality checks did not pass.</p>}
    {item.revisionFeedback && <p className="snapshot-feedback">{item.revisionFeedback}</p>}
    <div className="snapshot-card-actions">
      <button type="button" className="nodrag secondary-action" onClick={event=>{event.stopPropagation();data.onInspect(item.id,true);}}>Inspect snapshot</button>
      <button type="button" className="nodrag secondary-action" aria-haspopup="dialog" disabled={data.reviewDisabled}
        onClick={event=>{event.stopPropagation();data.onReview(item.id);}}>Review</button>
    </div></div>
    <Handle type="source" position={Position.Right}/>
  </article>;
});
const nodeTypes={snapshot:SnapshotNode};
const positionInGrid = (index,columns=3) => ({x:(index%columns)*370+40,y:Math.floor(index/columns)*650+40});
const FIT_OPTIONS = {padding:0.16,maxZoom:0.85};
const MINIMAP_HEIGHT = 90;

function CanvasTool({icon,label,pressed,disabled,onClick}) {
  return <button type="button" className="studio-tool" aria-label={label} title={label}
    aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon name={icon} size={17}/></button>;
}

export default function SnapshotCanvas({images,selectedId,contributors,navigation,onSelect,onReview,reviewDisabled,onMoveMany}) {
  const [nodes,setNodes]=useState([]);
  const [flow,setFlow]=useState(null);
  const [mode,setMode]=useState('select');
  const [details,setDetails]=useState(null);
  const openDetails = useCallback((id,kind)=>setDetails({id,kind,open:true}),[]);
  const detailIndex = images.findIndex(item=>item.id === details?.id);
  const detailItem = images[detailIndex];
  const board = useRef(null);
  useEffect(()=>{
    setNodes(images.map((item,i)=>({id:item.id,type:'snapshot',position:item.position || positionInGrid(i),selected:item.id===selectedId,
      data:{item,number:i+1,onInspect:onSelect,onReview,reviewDisabled,onDetails:openDetails}})));
  },[images,selectedId,onSelect,onReview,reviewDisabled,openDetails]);
  const edges=useMemo(()=>images.filter(s=>s.parentVersionId && images.some(p=>p.id===s.parentVersionId)).map(s=>({id:`parent-${s.id}`,source:s.parentVersionId,target:s.id,type:'smoothstep',label:'Iterates on',style:{stroke:'var(--ui-muted)'},labelStyle:{fill:'var(--ui-text)',fontSize:11}})),[images]);
  useEffect(()=>{
    if (!flow) return;
    const element = board.current;
    let size = [element.clientWidth,element.clientHeight];
    let frame;
    const observer = new ResizeObserver(()=>{
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(()=>{
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (!width || !height) return;
        const [previousWidth,previousHeight] = size;
        size = [width,height];
        if (!previousWidth || !previousHeight || (width === previousWidth && height === previousHeight)) return;
        // Keep the viewing center while panels move, and refit for a much smaller viewport.
        const shrank = width < previousWidth * 0.75 || height < previousHeight * 0.75 ||
          (width < 360 && width < previousWidth * 0.88);
        if (shrank && flow.getNodes().length) {
          flow.fitView(FIT_OPTIONS);
        } else {
          const {x,y,zoom} = flow.getViewport();
          flow.setViewport({x:x+(width-previousWidth)/2,y:y+(height-previousHeight)/2,zoom});
        }
      });
    });
    observer.observe(element);
    return ()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[flow]);
  function arrange() {
    const columns = Math.max(3,Math.ceil(Math.sqrt(images.length)));
    onMoveMany(images.map((item,index)=>({id:item.id,position:positionInGrid(index,columns)})));
  }
  return <div className="snapshot-board" ref={board} data-tool={mode} style={{'--canvas-minimap-height':`${MINIMAP_HEIGHT}px`}}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow}
      onNodesChange={changes=>setNodes(prev=>applyNodeChanges(changes,prev))}
      onNodeDragStop={(_,node)=>onMoveMany([{id:node.id,position:node.position}])}
      onNodeClick={(_,node)=>{if (mode === 'select') onSelect(node.id);}}
      nodesDraggable={mode === 'select'} elementsSelectable={mode === 'select'}
      nodesConnectable={false} panOnDrag={mode === 'pan' ? true : [1,2]} deleteKeyCode={null}
      minZoom={0.15} maxZoom={1.5} fitView fitViewOptions={FIT_OPTIONS} proOptions={{hideAttribution:true}}>
      <Background color="var(--ui-border-strong)" gap={22}/>
      <MiniMap position="bottom-left" style={{width:130,height:MINIMAP_HEIGHT}} pannable zoomable
        nodeBorderRadius={32} nodeColor="var(--ui-minimap-node)" maskColor="var(--ui-minimap-mask)"/>
    </ReactFlow>
    <CanvasAvatars contributors={contributors}/>
    <div className="canvas-tools">
      {navigation}
      {navigation && <span aria-hidden="true" className="canvas-tools-divider"/>}
      <div className="canvas-tool-actions" role="group" aria-label="Canvas tools">
        <CanvasTool icon="pointer" label="Select and move snapshots" pressed={mode === 'select'} onClick={()=>setMode('select')}/>
        <CanvasTool icon="hand" label="Pan canvas" pressed={mode === 'pan'} onClick={()=>setMode('pan')}/>
        <span aria-hidden="true" className="canvas-tools-divider"/>
        <CanvasTool icon="minus" label="Zoom out" disabled={!flow} onClick={()=>flow.zoomOut({duration:150})}/>
        <CanvasTool icon="plus" label="Zoom in" disabled={!flow} onClick={()=>flow.zoomIn({duration:150})}/>
        <CanvasTool icon="expand" label="Fit snapshots to view" disabled={!flow || !images.length} onClick={()=>flow.fitView({...FIT_OPTIONS,duration:180})}/>
        <CanvasTool icon="grid" label="Arrange snapshots in a grid" disabled={images.length < 2} onClick={arrange}/>
        <CanvasTool icon="inspect" label="Inspect selected snapshot" disabled={!selectedId} onClick={()=>onSelect(selectedId,true)}/>
      </div>
    </div>
    {!images.length && <div className="board-empty"><span>✧</span><h3>A shared space for ideas</h3><p>Generate your first image to add a snapshot.<br/>Explore concepts together, one iteration at a time.</p><div>IMAGE · CONCEPT · CREATOR · TIME</div></div>}
    {detailItem && (details.kind === 'concept' || detailItem.coverReview) &&
      <SnapshotDetails item={detailItem} number={detailIndex+1} kind={details.kind} open={details.open}
        onClose={()=>setDetails({...details,open:false})}/>}
  </div>;
}
