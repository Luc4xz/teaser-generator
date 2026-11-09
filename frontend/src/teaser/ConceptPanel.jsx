import React, { useEffect, useRef } from 'react';
import AutoGrowTextarea from './AutoGrowTextarea.jsx';
import LockedField from './ParameterLock.jsx';
import { CONCEPT_FIELDS, conceptIsCurrent, conceptIsReady, CONCEPT_DRAG_TYPE } from './concept.js';

export default function ConceptPanel({ project, extracting, disabled, onChange, onToggleLock, onConfirm, onDragState }) {
  const dragPreview = useRef(null);
  const clearDragPreview = () => { dragPreview.current?.remove(); dragPreview.current = null; };
  useEffect(() => clearDragPreview, []);
  const concept = project.scientificConcept;
  const stale = concept && !conceptIsCurrent(project);
  if (project.conceptConfirmed || (!concept && !extracting)) return null;
  const canMove = !disabled && conceptIsReady(project);
  function startDrag(event) {
    event.stopPropagation();
    if (!canMove) { event.preventDefault(); return; }
    clearDragPreview();
    // An explicit, isolated preview prevents the browser capturing the canvas column.
    const preview = document.createElement('div');
    preview.className = 'concept-only-drag-preview';
    const title = document.createElement('strong');
    title.textContent = 'Scientific concept';
    const text = document.createElement('p');
    text.textContent = concept.core_concept;
    preview.append(title, text);
    document.body.appendChild(preview);
    dragPreview.current = preview;
    event.dataTransfer.setData(CONCEPT_DRAG_TYPE, 'current-concept');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setDragImage(preview, 28, 24);
    onDragState(true);
  }
  return <section className="concept-panel concept-artifact" aria-labelledby="concept-heading" aria-busy={extracting}>
    <div className={`concept-heading ${canMove ? 'concept-drag-handle' : ''}`} draggable={canMove} onDragStart={startDrag} onDragEnd={event=>{event.stopPropagation();clearDragPreview();onDragState(false);}} title={canMove ? 'Drag this header to move only the concept card' : undefined}><span className="concept-drag-grip" aria-hidden="true">⠿</span><h3 id="concept-heading">Scientific concept</h3><span>{extracting ? 'GENERATING…' : stale ? 'SOURCE CHANGED' : 'CURRENT DRAFT'}</span></div>
    {extracting && <p role="status">Reading your paper and generating a concept…</p>}
    {concept && <>
      {stale && <p className="concept-stale" role="status">Paper changed. Generate the concept again using the button on the left.</p>}
      <div className="concept-move-action"><span>Drag the card header to the box beside your paper.</span><button type="button" disabled={!canMove} onClick={onConfirm}>← Confirm & move left</button></div>
      <div className="concept-editor">
        <fieldset disabled={disabled} className="concept-fields">{CONCEPT_FIELDS.map(([key, label, limit]) => <LockedField key={key} name={`scientificConcept.${key}`} label={label} locks={project.parameterLocks} onToggle={onToggleLock} disabled={disabled}><AutoGrowTextarea rows={2} maxLength={limit} value={concept[key] || ''} onChange={e => onChange({ ...concept, [key]: e.target.value })}/></LockedField>)}
          <p className="concept-review-note">Check claims and excerpts against the paper. Edits are saved automatically.</p>
        </fieldset>
      </div>
    </>}
  </section>;
}
