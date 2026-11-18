import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import StudioPanel from './StudioPanel.jsx';
import StudioRail from './StudioRail.jsx';

const STORAGE_KEY = 'teaser-studio-column-widths';
const PANEL_NAMES = ['paper', 'concept'];
const COLUMN_NAMES = [...PANEL_NAMES, 'canvas'];
const TITLES = {paper:'Illustrate your paper', concept:'Review your concept', canvas:'canvas'};
const DEFAULT_SHARES = [0.24, 0.28, 0.48];
const MIN_WIDTHS = {paper:210, concept:220, canvas:280};
const DIVIDER_WIDTH = 10;

function readShares() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(value => Number.isFinite(value) && value > 0)) {
      const total = saved.reduce((sum, value) => sum + value, 0);
      return saved.map(value => value / total);
    }
  } catch { /* Use the default layout if storage is unavailable. */ }
  return DEFAULT_SHARES;
}

function saveShares(shares) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shares)); }
  catch { /* Resizing still works without storage. */ }
}

const otherPanel = name => name === 'paper' ? 'concept' : 'paper';

const WorkspaceColumns = forwardRef(function WorkspaceColumns({
  header, paper, concept, canvas, canvasRef, canvasBusy, view, page, onWorkspace, children,
}, controller) {
  const [shares, setShares] = useState(readShares);
  const [workspaceWidth,setWorkspaceWidth] = useState(0);
  const [visible, setVisible] = useState({paper:true, concept:true});
  const [dock, setDock] = useState(null);
  const [spotlight, setSpotlight] = useState(null);
  const [activeDivider, setActiveDivider] = useState(null);
  const [draggedPanel, setDraggedPanel] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const workspace = useRef(null);
  const railButtons = useRef({});
  const drag = useRef(null);

  useLayoutEffect(() => {
    const body = workspace.current.parentElement;
    const rail = body.firstElementChild;
    function measure() {
      setWorkspaceWidth(body.clientWidth - rail.offsetWidth);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  const revealPanel = useCallback((name, {scroll=true,focus=false,smooth=false,reveal=false}={}) => {
    if (name !== 'canvas') setVisible(previous=>previous[name] ? previous : {...previous,[name]:true});
    setSpotlight({name,scroll,focus,smooth,reveal});
  }, []);
  useImperativeHandle(controller, ()=>({revealPanel}), [revealPanel]);

  useLayoutEffect(() => {
    if (spotlight && view === 'workspace') {
      const id = spotlight.name === 'canvas' ? 'studio-canvas' : `${spotlight.name}-column`;
      const section = workspace.current.querySelector(`#${id}`);
      if (spotlight.scroll && section) {
        const top = section.getBoundingClientRect().top;
        const jumpsToStart = spotlight.smooth && (top < 0 || top > window.innerHeight - 48);
        const animate = spotlight.smooth && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
        section.scrollIntoView({block:jumpsToStart ? 'start' : 'nearest',inline:'nearest',behavior:animate ? 'smooth' : 'auto'});
      }
      if (spotlight.focus) section?.focus({preventScroll:true});
    }
  }, [spotlight,view]);
  useEffect(() => {
    if (!spotlight) return;
    const timeout = setTimeout(()=>setSpotlight(null), 950);
    return ()=>clearTimeout(timeout);
  }, [spotlight]);

  function foldPanel(name) {
    setVisible(previous=>({...previous,[name]:false}));
    railButtons.current[name]?.focus({preventScroll:true});
  }

  const activePanels = PANEL_NAMES.filter(name=>visible[name]);
  const split = activePanels.length === 2 ? dock : null;
  const columns = [...(split ? [split.anchor] : activePanels), 'canvas'];
  const dividerCount = columns.length - 1;
  const available = Math.max(1, workspaceWidth - DIVIDER_WIDTH * dividerCount);
  const desiredMinimums = columns.map(name=>MIN_WIDTHS[name]);
  const minimumTotal = desiredMinimums.reduce((sum,width)=>sum+width,0);
  const minimums = desiredMinimums.map(width=>width*Math.min(1,available/minimumTotal));
  const columnShares = columns.map(name=>shares[COLUMN_NAMES.indexOf(name)]);
  columnShares[columnShares.length-1] += 1 - columnShares.reduce((sum,share)=>sum+share,0);
  const extra = columnShares.map((share,index)=>Math.max(0,share*available-minimums[index]));
  const extraTotal = extra.reduce((sum,width)=>sum+width,0);
  const widths = minimums.map((minimum,index)=>
    minimum+(extraTotal ? extra[index]/extraTotal*Math.max(0,available-minimumTotal) : 0));

  function resize(index, startWidths, delta) {
    const pairWidth = startWidths[index]+startWidths[index+1];
    const left = Math.max(minimums[index],Math.min(pairWidth-minimums[index+1],startWidths[index]+delta));
    const next = [...startWidths];
    next[index] = left;
    next[index+1] = pairWidth-left;
    const total = next.reduce((sum,width)=>sum+width,0);
    const nextShares = next.map(width=>width/total);
    let saved = nextShares;
    if (columns.length === 2) {
      const kept = COLUMN_NAMES.indexOf(columns[0]);
      saved = shares.map((share,i)=>i === kept ? nextShares[0] : share/(1-shares[kept])*nextShares[1]);
    }
    setShares(saved);
    return saved;
  }

  function startResize(event, index) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = {pointerId:event.pointerId,index,startX:event.clientX,widths,shares:null};
    setActiveDivider(index);
  }

  function moveResize(event) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    active.shares = resize(active.index,active.widths,event.clientX-active.startX);
  }

  function finishResize(event) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    if (active.shares) saveShares(active.shares);
    drag.current = null;
    setActiveDivider(null);
  }

  function resizeWithKeyboard(event,index) {
    const step = event.shiftKey ? 48 : 16;
    const deltas = {ArrowLeft:-step,ArrowRight:step,Home:-available,End:available};
    if (!Object.hasOwn(deltas,event.key)) return;
    event.preventDefault();
    saveShares(resize(index,widths,deltas[event.key]));
  }

  function resetColumnWidths() {
    setShares(DEFAULT_SHARES);
    saveShares(DEFAULT_SHARES);
  }

  function divider(index) {
    if (index >= dividerCount) return null;
    const percent = width=>Math.round(width/available*100);
    const left = columns[index];
    const right = columns[index+1];
    const labels = {paper:'paper',concept:'concept',canvas:'canvas'};
    return <div className={`column-divider${activeDivider === index ? ' is-dragging' : ''}`}
      style={{gridArea:index ? 'divider-b' : 'divider-a'}} role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label={`Resize ${labels[left]} and ${labels[right]} columns`}
      aria-controls={`${left}-column`} aria-valuemin={percent(minimums[index])}
      aria-valuemax={percent(widths[index]+widths[index+1]-minimums[index+1])} aria-valuenow={percent(widths[index])}
      aria-valuetext={`${percent(widths[index])}% of workspace width`}
      onPointerDown={event=>startResize(event,index)} onPointerMove={moveResize}
      onLostPointerCapture={finishResize} onKeyDown={event=>resizeWithKeyboard(event,index)}/>;
  }

  function beginPanelDrag(event,name) {
    event.dataTransfer.setData('text/plain',TITLES[name]);
    event.dataTransfer.effectAllowed = 'move';
    setDraggedPanel(name);
  }

  function finishPanelDrag() {
    setDraggedPanel(null);
    setDropTarget(null);
  }

  function dockPanel(source,target,edge) {
    setDock(previous=>({anchor:previous?.anchor || target, first:edge === 'top' ? source : target}));
    finishPanelDrag();
  }

  function updateDropTarget(event,name) {
    if (!draggedPanel || name === draggedPanel || (name === 'canvas' && !split)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    const edge = name === 'canvas' ? 'canvas' : event.clientY < box.top+box.height/2 ? 'top' : 'bottom';
    setDropTarget(previous=>previous?.name === name && previous?.edge === edge ? previous : {name,edge});
  }

  function clearDropTarget(event,name) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDropTarget(previous=>previous?.name === name ? null : previous);
    }
  }

  function dropPanel(event,name) {
    if (dropTarget?.name !== name || !draggedPanel) return;
    event.preventDefault();
    if (name === 'canvas') {
      setDock(null);
      finishPanelDrag();
    } else dockPanel(draggedPanel,name,dropTarget.edge);
  }

  function panel(name,content) {
    const other = otherPanel(name);
    return <StudioPanel name={name} title={TITLES[name]} otherTitle={TITLES[other]}
      className={name === 'paper' ? 'input-panel' : 'concept-column'} visible={visible[name]}
      highlighted={spotlight?.name === name} revealing={spotlight?.name === name && spotlight.reveal}
      dropEdge={dropTarget?.name === name ? dropTarget.edge : undefined}
      docked={Boolean(split)} canDock={visible[other]} onFold={()=>foldPanel(name)}
      onDragStart={event=>beginPanelDrag(event,name)} onDragEnd={finishPanelDrag}
      onDragOver={event=>updateDropTarget(event,name)} onDragLeave={event=>clearDropTarget(event,name)}
      onDrop={event=>dropPanel(event,name)} onDock={edge=>dockPanel(name,other,edge)} onSeparate={()=>setDock(null)}>
      {content}
    </StudioPanel>;
  }

  const tracks = columns.flatMap((name,index)=>index ? [index === 1 ? 'divider-a' : 'divider-b',name] : [name]);
  const gridAreas = split ? `"${split.first} divider-a canvas" "${otherPanel(split.first)} divider-a canvas"` : `"${tracks.join(' ')}"`;
  const style = {
    '--divider-width':`${DIVIDER_WIDTH}px`,
    '--workspace-areas':gridAreas,
    '--workspace-columns':widths.flatMap((width,index)=>index ? [`${DIVIDER_WIDTH}px`,`${width}px`] : [`${width}px`]).join(' '),
  };

  return <div className="core-studio" style={workspaceWidth ? style : undefined} data-canvas-only={!dividerCount || undefined}>
    {header}
    <div className="studio-body">
      <StudioRail visible={visible} view={view} buttonRefs={railButtons} onSection={name=>{
        if (view !== 'workspace') onWorkspace();
        revealPanel(name,{smooth:true,reveal:view === 'workspace' && name !== 'canvas' && !visible[name]});
      }}/>
      <main className={`core-workspace${activeDivider !== null ? ' is-resizing' : ''}`} ref={workspace} hidden={view !== 'workspace'}
        data-split={split?.first}>
        {panel('paper',paper)}
        {divider(0)}
        {panel('concept',concept)}
        {divider(1)}
        <section id="studio-canvas" className="canvas-panel" ref={canvasRef} aria-label="Shared idea canvas" aria-busy={canvasBusy} tabIndex={-1}
          data-highlighted={spotlight?.name === 'canvas' || undefined}
          data-drop-edge={dropTarget?.name === 'canvas' ? 'canvas' : undefined}
          onDragOver={event=>updateDropTarget(event,'canvas')} onDragLeave={event=>clearDropTarget(event,'canvas')}
          onDrop={event=>dropPanel(event,'canvas')}>
          {canvas}
        </section>
      </main>
      {page}
    </div>
    {children(resetColumnWidths)}
  </div>;
});

export default WorkspaceColumns;
