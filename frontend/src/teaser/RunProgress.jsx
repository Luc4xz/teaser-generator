import React from 'react';

const STEP_LABELS = {
  concept: {source:'Read paper',summary:'Prepare context',concept:'Extract concept',check:'Validate'},
  image: {source:'Read brief',plan:'Plan',prompt:'Write prompt',render:'Render',check:'Check image',evaluate:'Evaluate cover'},
};

export default function RunProgress({run, busy, onRetry, onReconnect, kind='image'}) {
  if (!run || run.status === 'complete') return null;
  if (!busy) {
    return <section className="run-progress run-message" aria-label={`${kind} generation status`}>
      <p role={run.status === 'failed' ? 'alert' : 'status'}>{run.message}</p>
      {run.status === 'interrupted' && onReconnect &&
        <button type="button" className="secondary-action" onClick={onReconnect}>Reconnect</button>}
      {run.status === 'failed' && onRetry &&
        <button type="button" className="secondary-action" onClick={onRetry}>Retry</button>}
    </section>;
  }
  const labels = STEP_LABELS[kind];
  const steps = run.steps?.length ? run.steps.filter(step=>step.status !== 'skipped') :
    Object.keys(labels).map(id=>({id,status:'pending'}));
  const current = steps.find(step=>step.status === 'running');
  const stageLabel = current ? labels[current.id] || current.label : 'Waiting to start';
  const completed = steps.filter(step=>step.status === 'complete').length;
  return <section className="run-progress" aria-label={`${kind} generation progress`}>
    <p className="run-current-stage" role="status">{stageLabel}</p>
    <div className="run-progress-track" role="progressbar" aria-label={`${kind} generation`}
      aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completed}
      aria-valuetext={`${completed} of ${steps.length} stages complete. ${stageLabel}.`}>
      {steps.map(step=><span key={step.id} data-status={step.status}/>)}
    </div>
    <ol className="run-steps" aria-label="Generation stages">
      {steps.map(step=><li key={step.id} data-status={step.status} aria-current={step === current ? 'step' : undefined}>
        {labels[step.id] || step.label}
      </li>)}
    </ol>
  </section>;
}
