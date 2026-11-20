import React from 'react';
import AutoGrowTextarea from './AutoGrowTextarea.jsx';
import { CONCEPT_FIELDS, conceptIsCurrent } from './concept.js';

export default function ConceptPanel({ project, run, extracting, disabled, onChange, open, onOpenChange }) {
  const concept = project.scientificConcept;
  const stale = concept && !conceptIsCurrent(project);
  if (!concept && !extracting && !run) return null;
  const interrupted = run?.status === 'interrupted';
  const failed = run?.status === 'failed';
  const showEditor = concept && !extracting && !interrupted;
  const status = extracting ? 'Generating…' : interrupted ? 'Connection interrupted' : failed && concept ? 'Previous draft' : failed ? 'Generation failed' : stale ? 'Source changed' : '';
  return <details className="concept-panel concept-artifact review-disclosure" open={open} onToggle={event=>onOpenChange(event.currentTarget.open)} aria-busy={extracting}>
    <summary><span className="review-disclosure-title">Concept fields</span>{status && <span className="review-disclosure-status">{status}</span>}</summary>
    {failed && concept && <p role="status">Regeneration failed. Your previous draft is restored below; no new concept was created.</p>}
    {showEditor && <>
      {stale && <p className="concept-stale" role="status">The paper changed. Open Paper settings to regenerate the concept.</p>}

      <fieldset disabled={disabled} className="concept-fields">
        {CONCEPT_FIELDS.map(([key, label, limit]) => <label key={key} className="brief-field">
          {label}
          <AutoGrowTextarea rows={2} maxLength={limit} value={concept[key] || ''} onChange={e => onChange({ ...concept, [key]: e.target.value })}/>
        </label>)}
        <p className="concept-review-note">Check claims and excerpts against the paper. Edits are saved automatically.</p>
      </fieldset>
    </>}
  </details>;
}
