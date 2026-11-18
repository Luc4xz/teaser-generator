import React, { useEffect, useRef, useState } from 'react';
import Icon from './StudioIcon.jsx';

const SWEEP_DURATION = 360;

export default function GenerationButton({busy, disabled, onClick, onStop, children}) {
  const [sweeping,setSweeping] = useState(false);
  const timer = useRef(null);
  const generate = useRef(null);
  useEffect(()=>()=>clearTimeout(timer.current),[]);

  function activate(event) {
    setSweeping(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(()=>setSweeping(false),SWEEP_DURATION);
    onClick(event);
  }

  const label = <><span>{children}</span><Icon name="arrow"/></>;
  return <div className="generation-controls" data-active={busy || undefined}>
    <button ref={generate} className="generate-button generation-action" type="button"
      disabled={disabled} aria-busy={busy} data-sweeping={sweeping || undefined} data-filled={busy || sweeping || undefined}
      style={{'--generation-sweep-duration':`${SWEEP_DURATION}ms`}} onClick={activate}>
      <span className="generation-button-content">{label}</span>
      <span className="generation-button-content generation-fill" aria-hidden="true">{label}</span>
    </button>
    <div className="generation-stop-slot" aria-hidden={!busy}>
      <button className="generation-stop" disabled={!busy} type="button" onClick={()=>{
        onStop();
        requestAnimationFrame(()=>generate.current?.focus({preventScroll:true}));
      }}>Stop</button>
    </div>
  </div>;
}
