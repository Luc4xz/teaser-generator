import React from 'react';
import ConceptTrace from './ConceptTrace.jsx';
export default function RunProgress({run,busy,onRetry,onReconnect}) {
  if(!run)return null;
  return <section className="run-progress" aria-label="Generation progress">
    <div className="run-title" role="status"><strong>{['failed','interrupted'].includes(run.status)?'Generation paused':run.status==='complete'?'Version ready': 'Creating your next version'}</strong>{busy&&<span className="spinner"/>}</div>
    <p role={run.status==='failed'?'alert':undefined}>{run.message}</p>
    <ol className="run-steps">{(run.steps||[]).map(step=><li key={step.id} className={step.status}><span>{step.status==='complete'?'✓':step.status==='failed'?'!':step.status==='skipped'?'—':'•'}</span>{step.label}<small>{step.status}</small></li>)}</ol>
    {run.artifacts?.visualPlan&&<details><summary>Visual plan ready</summary><p>{run.artifacts.visualPlan.subject}</p><p>{run.artifacts.visualPlan.composition}</p></details>}
    {run.artifacts?.notes?.length>0&&<p className="run-note">{run.artifacts.notes[0]}</p>}
    {run.artifacts?.scientificConcept && <ConceptTrace item={run.artifacts}/>}
    {run.artifacts?.drawingPrompt&&<details><summary>Drawing prompt ready</summary><pre>{run.artifacts.drawingPrompt}</pre></details>}
    {run.status==='interrupted'&&<button type="button" className="secondary-action" onClick={onReconnect}>Reconnect to this run</button>}
    {run.status==='failed'&&<button type="button" className="secondary-action" onClick={onRetry}>{run.artifacts?.drawingPrompt?'Retry from image generation':'Retry planning'}</button>}
  </section>;
}
