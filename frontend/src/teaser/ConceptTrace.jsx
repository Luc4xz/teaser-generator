import React from 'react';
import { CONCEPT_FIELDS } from './concept.js';

export default function ConceptTrace({ item }) {
  const prompt = item.drawingBrief || item.promptSections?.map(({title, content})=>`${title}\n${content}`).join('\n\n');
  const concept = item.scientificConcept || item.inputSnapshot?.scientificConcept;
  const mappings = item.visualMapping?.mappings;
  if (!prompt && !concept && !mappings?.length) return null;

  return <details className="concept-trace">
    <summary>Image generation prompt</summary>
    {prompt ? <p className="generation-prompt">{prompt}</p> : <>
      <p>The original prompt is unavailable. This version has the following generation details.</p>
      <dl className="snapshot-detail-list">
        {concept && CONCEPT_FIELDS.map(([key, label])=><React.Fragment key={key}>
          <dt>{label}</dt><dd>{concept[key]}</dd>
        </React.Fragment>)}
        {mappings?.map(({concept_field, depiction, rationale}, index)=><React.Fragment key={index}>
          <dt>Visual mapping · {CONCEPT_FIELDS.find(([key])=>key===concept_field)?.[1] || concept_field}</dt>
          <dd>{depiction}{rationale && `\n${rationale}`}</dd>
        </React.Fragment>)}
      </dl>
    </>}
  </details>;
}
