import React, { useState } from 'react';
import { CONCEPT_DRAG_TYPE, CONCEPT_FIELDS, conceptIsReady } from './concept.js';

export default function ConceptDock({ project, disabled, dragging, onConfirm, onReturn }) {
  const [over, setOver] = useState(false);
  const confirmed = project.conceptConfirmed;
  const ready = conceptIsReady(project);
  const accepts = event => !disabled && !confirmed && ready && Array.from(event.dataTransfer.types).includes(CONCEPT_DRAG_TYPE);
  return <section className={`concept-dock ${confirmed ? 'occupied' : ''} ${dragging && ready ? 'available' : ''} ${over ? 'drag-over' : ''}`} aria-label="Confirmed concept destination"
    onDragOver={event=>{if(accepts(event)){event.preventDefault();event.dataTransfer.dropEffect='move';setOver(true);}}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOver(false);}}
    onDrop={event=>{event.preventDefault();setOver(false);if(accepts(event)&&event.dataTransfer.getData(CONCEPT_DRAG_TYPE)==='current-concept')onConfirm();}}>
    {confirmed ? <>
      <div className="dock-badge">🔒 {ready ? 'Confirmed concept' : 'Review needed'}</div>
      <p className="dock-concept-title">{project.scientificConcept?.core_concept}</p>
      <details className="dock-details"><summary>View 6 locked fields</summary><dl>{CONCEPT_FIELDS.map(([key,label])=><React.Fragment key={key}><dt>{label}</dt><dd>{project.scientificConcept?.[key]}</dd></React.Fragment>)}</dl></details>
      {!ready && <p className="dock-stale" role="status">Source changed. Return to the canvas and regenerate.</p>}
      <button type="button" className="dock-return" disabled={disabled} onClick={onReturn}>Return to canvas to edit ↗</button>
    </> : <>
      <span className="dock-placeholder-icon" aria-hidden="true">↓</span>
      <strong>Concept goes here</strong>
      <p>Review the card on the right, then drag it here to confirm & lock.</p>
      <button type="button" className="dock-confirm" disabled={disabled || !ready} onClick={onConfirm}>Confirm & lock</button>
    </>}
  </section>;
}
