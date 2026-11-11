import React, { memo, useEffect, useMemo, useState } from 'react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position, applyNodeChanges } from 'reactflow';
import 'reactflow/dist/style.css';
import { CONCEPT_FIELDS } from './concept.js';
const SnapshotNode=memo(function SnapshotNode({data,selected}) {
  const item=data.item, concept=item.scientificConcept || item.inputSnapshot?.scientificConcept;
  return <article className={`snapshot-node ${selected?'is-selected':''}`}>
    <Handle type="target" position={Position.Left}/>
    <header><span>SNAPSHOT {data.number.toString().padStart(2,'0')}</span><span>{item.parentVersionId?'Iteration':'Original'}</span></header>
    <img draggable="false" src={item.image} alt={concept?.core_concept || 'Generated research illustration'}/>
    <div className="snapshot-body"><h3>{concept?.core_concept || item.userPrompt || 'Research illustration'}</h3>
    <div className="snapshot-credit"><strong>Creator: {item.creator?.displayName || 'Unknown · legacy snapshot'}</strong><time dateTime={item.createdAt}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Time unavailable'}</time></div>
    <details className="nodrag nowheel"><summary>Scientific concepts & values</summary><dl>{CONCEPT_FIELDS.map(([key,label])=><React.Fragment key={key}><dt>{label}</dt><dd>{concept?.[key] || 'Not recorded'}</dd></React.Fragment>)}</dl></details>
    {item.revisionFeedback && <p className="snapshot-feedback">{item.revisionFeedback}</p>}
    <button className="nodrag" onClick={()=>data.onInspect(item.id)}>Inspect & iterate ↗</button></div>
    <Handle type="source" position={Position.Right}/>
  </article>;
});
const nodeTypes={snapshot:SnapshotNode};
export default function SnapshotCanvas({images,selectedId,onSelect,onMove}) {
  const [nodes,setNodes]=useState([]);
  useEffect(()=>setNodes(images.map((item,i)=>({id:item.id,type:'snapshot',position:item.position || {x:(i%3)*370+40,y:Math.floor(i/3)*650+40},selected:item.id===selectedId,data:{item,number:i+1,onInspect:onSelect}}))),[images,selectedId,onSelect]);
  const edges=useMemo(()=>images.filter(s=>s.parentVersionId && images.some(p=>p.id===s.parentVersionId)).map(s=>({id:`parent-${s.id}`,source:s.parentVersionId,target:s.id,type:'smoothstep',label:'Iterates on',style:{stroke:'#8b8aab'},labelStyle:{fill:'#65617f',fontSize:11}})),[images]);
  return <div className="snapshot-board"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes=>setNodes(prev=>applyNodeChanges(changes,prev))} onNodeDragStop={(_,node)=>onMove(node.id,node.position)} onNodeClick={(_,node)=>onSelect(node.id)} nodesConnectable={false} deleteKeyCode={null} minZoom={0.15} maxZoom={1.5} fitView fitViewOptions={{maxZoom:0.85,padding:0.15}}><Background color="#d5d4dd" gap={22}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#c6c0df"/></ReactFlow>
    {!images.length && <div className="board-empty"><span>✧</span><h3>A shared space for ideas</h3><p>Generate your first image to add a snapshot.<br/>Explore concepts together, one iteration at a time.</p><div>IMAGE · CONCEPT · CREATOR · TIME</div></div>}
  </div>;
}
