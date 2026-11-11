import React from 'react';
import { CONCEPT_FIELDS } from './concept.js';

export default function ConceptTrace({ item }) {
  if (!item.scientificConcept && !item.drawingBrief) return null;
  return <section className="concept-trace" aria-label="Concept to image">
    <h3>{item.scientificConcept ? 'Concept → visual mapping → drawing prompt' : 'Drawing prompt'}</h3>
    <p>This version’s saved plan. Check the image against it; the plan does not verify the rendered result.</p>
    {item.scientificConcept && <details><summary>Scientific concept used for this version</summary><dl>{CONCEPT_FIELDS.map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{item.scientificConcept[key]}</dd></React.Fragment>)}</dl></details>}
    {item.visualMapping && <details open><summary>How the concept becomes a visual</summary><div className="concept-mappings">{item.visualMapping.mappings.map((mapping, i) => <div key={i}><strong>{CONCEPT_FIELDS.find(([key])=>key===mapping.concept_field)?.[1] || mapping.concept_field}</strong><p>{mapping.depiction}</p><small>{mapping.rationale}</small></div>)}</div></details>}
    {item.promptSections && <details><summary>Drawing prompt · {item.promptSections.length} fixed sections</summary>{item.promptSections.map(section=><div className="prompt-section" key={section.title}><h4>{section.title}</h4><p>{section.content}</p></div>)}</details>}
    {!item.promptSections?.length && item.drawingBrief && <details><summary>Drawing prompt</summary><div className="prompt-section"><p>{item.drawingBrief}</p></div></details>}
    {!item.visualMapping && <p>Rendered from saved or edited drawing instructions. The visual mapping was not rebuilt for this version.</p>}
  </section>;
}
