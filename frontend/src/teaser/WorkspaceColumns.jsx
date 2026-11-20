import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import StudioPanel from './StudioPanel.jsx';
import StudioNavigation from './StudioNavigation.jsx';

const STORAGE_KEY = 'teaser-studio-column-widths';
const COLUMN_NAMES = ['left', 'right', 'canvas'];
const TITLES = {paper:'Illustrate your paper', concept:'Scientific concept', snapshot:'Selected snapshot'};
const DEFAULT_SHARES = [0.24, 0.28, 0.48];
const MIN_WIDTHS = {left:210, right:220, canvas:280};
const DIVIDER_WIDTH = 10;
const CARD_MARGIN = 12;
const CARD_FRAME = CARD_MARGIN * 2 + 2;

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

const defaultPanels = source => ({slots:[source,'snapshot'],recent:source});

const WorkspaceColumns = forwardRef(function WorkspaceColumns({
  header, paper, concept, snapshot, snapshotStatus, defaultSource, canvas, canvasRef, canvasBusy, view, page, onWorkspace, children,
}, controller) {
  const [shares, setShares] = useState(readShares);
  const [workspaceWidth,setWorkspaceWidth] = useState(0);
  const [panelLayout, setPanelLayout] = useState(null);
  const {slots} = panelLayout || defaultPanels(defaultSource);
  const visible = Object.fromEntries(Object.keys(TITLES).map(name=>[name,slots.includes(name)]));
  const [dock, setDock] = useState(null);
  const [spotlight, setSpotlight] = useState(null);
  const [resizing, setResizing] = useState(false);
  const [draggedPanel, setDraggedPanel] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const workspace = useRef(null);
  const navigationButtons = useRef({});
  const drag = useRef(null);

  useLayoutEffect(() => {
    const body = workspace.current.parentElement;
    function measure() {
      setWorkspaceWidth(body.clientWidth);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const revealPanel = useCallback((name, {scroll=true,focus=false,smooth=false,reveal=false,replace}={}) => {
    if (name !== 'canvas') setPanelLayout(previous=>{
      const current = previous || defaultPanels(defaultSource);
      const next = [...current.slots];
      const replacement = next.indexOf(replace);
      const empty = next.indexOf(null);
      if (next.includes(name)) {
        if (replacement !== -1 && replace !== name) next[replacement] = null;
      } else {
        const slot = replacement !== -1 ? replacement : empty !== -1 ? empty : next.findIndex(panel=>panel !== current.recent);
        next[slot] = name;
      }
      return {slots:next,recent:name};
    });
    setSpotlight({name,scroll,focus,smooth,reveal});
  }, [defaultSource]);
  useImperativeHandle(controller, ()=>({
    revealPanel,
    resetPanels() {
      setPanelLayout(null);
      setSpotlight(null);
    },
  }), [revealPanel]);

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
    setPanelLayout(previous=>{
      const current = previous || defaultPanels(defaultSource);
      const remaining = current.slots.map(panel=>panel === name ? null : panel);
      return {slots:remaining,recent:current.recent === name ? remaining.find(Boolean) : current.recent};
    });
    navigationButtons.current[name]?.focus({preventScroll:true});
  }

  function markActive(name) {
    setPanelLayout(previous=>{
      const current = previous || defaultPanels(defaultSource);
      return current.recent === name ? previous : {...current,recent:name};
    });
  }

  const activePanels = COLUMN_NAMES.slice(0,2).filter((_,index)=>slots[index]);
  const split = activePanels.length === 2 ? dock : null;
  const hasCard = activePanels.length > 0;
  const hasDivider = activePanels.length === 2 && !split;
  const columns = [...(split ? [split.anchor] : activePanels), 'canvas'];
  const available = Math.max(1, workspaceWidth - (hasCard ? CARD_FRAME : 0) - (hasDivider ? DIVIDER_WIDTH : 0));
  const desiredMinimums = columns.map(name=>MIN_WIDTHS[name]);
  const minimumTotal = desiredMinimums.reduce((sum,width)=>sum+width,0);
  const minimums = desiredMinimums.map(width=>width*Math.min(1,available/minimumTotal));
  const columnShares = columns.map(name=>shares[COLUMN_NAMES.indexOf(name)]);
  columnShares[columnShares.length-1] += 1 - columnShares.reduce((sum,share)=>sum+share,0);
  const extra = columnShares.map((share,index)=>Math.max(0,share*available-minimums[index]));
  const extraTotal = extra.reduce((sum,width)=>sum+width,0);
  const widths = minimums.map((minimum,index)=>
    minimum+(extraTotal ? extra[index]/extraTotal*Math.max(0,available-minimumTotal) : 0));

  const panelWidth = hasCard ? available - widths.at(-1) : 0;

  function resize(startWidths, delta) {
    const [leftWidth, rightWidth, canvasWidth] = startWidths;
    const pairWidth = leftWidth+rightWidth;
    const left = Math.max(minimums[0],Math.min(pairWidth-minimums[1],leftWidth+delta));
    const nextShares = [left,pairWidth-left,canvasWidth].map(width=>width/(pairWidth+canvasWidth));
    setShares(nextShares);
    return nextShares;
  }

  function startResize(event) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = {pointerId:event.pointerId,startX:event.clientX,widths,shares:null};
    setResizing(true);
  }

  function moveResize(event) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    active.shares = resize(active.widths,event.clientX-active.startX);
  }

  function finishResize(event) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    if (active.shares) saveShares(active.shares);
    drag.current = null;
    setResizing(false);
  }

  function resizeWithKeyboard(event) {
    const step = event.shiftKey ? 48 : 16;
    const deltas = {ArrowLeft:-step,ArrowRight:step,Home:-available,End:available};
    if (!Object.hasOwn(deltas,event.key)) return;
    event.preventDefault();
    saveShares(resize(widths,deltas[event.key]));
  }

  function resetColumnWidths() {
    setShares(DEFAULT_SHARES);
    saveShares(DEFAULT_SHARES);
  }

  function divider() {
    const percent = width=>Math.round(width/panelWidth*100);
    return <div key="divider" className={`column-divider${resizing ? ' is-dragging' : ''}`} role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label={`Resize ${TITLES[slots[0]]} and ${TITLES[slots[1]]}`}
      aria-controls={slots.map(name=>`${name}-column`).join(' ')} aria-valuemin={percent(minimums[0])}
      aria-valuemax={percent(panelWidth-minimums[1])} aria-valuenow={percent(widths[0])}
      aria-valuetext={`${percent(widths[0])}% of card width`}
      onPointerDown={startResize} onPointerMove={moveResize}
      onLostPointerCapture={finishResize} onKeyDown={resizeWithKeyboard}/>;
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
    const sourceSlot = COLUMN_NAMES[slots.indexOf(source)];
    const targetSlot = COLUMN_NAMES[slots.indexOf(target)];
    setDock(previous=>({anchor:previous?.anchor || targetSlot, first:edge === 'top' ? sourceSlot : targetSlot}));
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
    const other = slots.find(panel=>panel && panel !== name);
    const className = {paper:'input-panel', concept:'concept-column', snapshot:'snapshot-column'}[name];
    return <StudioPanel key={name} name={name} title={TITLES[name]} status={name === 'snapshot' ? snapshotStatus : undefined} otherTitle={TITLES[other]}
      className={className} visible={visible[name]} onActivate={()=>markActive(name)}
      highlighted={spotlight?.name === name} revealing={spotlight?.name === name && spotlight.reveal}
      dropEdge={dropTarget?.name === name ? dropTarget.edge : undefined}
      docked={Boolean(split)} canDock={Boolean(other)} onFold={()=>foldPanel(name)}
      onDragStart={event=>beginPanelDrag(event,name)} onDragEnd={finishPanelDrag}
      onDragOver={event=>updateDropTarget(event,name)} onDragLeave={event=>clearDropTarget(event,name)}
      onDrop={event=>dropPanel(event,name)} onDock={edge=>dockPanel(name,other,edge)} onSeparate={()=>setDock(null)}>
      {content}
    </StudioPanel>;
  }

  const content = {paper, concept, snapshot};
  const panelOrder = (split?.first === 'right' ? [...slots].reverse() : slots).filter(Boolean);
  const panelItems = panelOrder.map(name=>panel(name,content[name]));
  if (hasDivider) panelItems.splice(1,0,divider());
  for (const name of Object.keys(content)) {
    if (!visible[name]) panelItems.push(panel(name,content[name]));
  }

  const cardStyle = {
    '--panel-card-margin':`${CARD_MARGIN}px`,
    '--panel-card-width':`${panelWidth+CARD_FRAME+(hasDivider ? DIVIDER_WIDTH : 0)}px`,
    '--panel-card-columns':hasDivider ? `${widths[0]}px ${DIVIDER_WIDTH}px minmax(0,1fr)` : undefined,
  };
  const navigation = <StudioNavigation visible={visible} view={view} buttonRefs={navigationButtons} onSection={name=>{
    if (view !== 'workspace') onWorkspace();
    revealPanel(name,{smooth:true,focus:view !== 'workspace',reveal:view === 'workspace' && name !== 'canvas' && !visible[name]});
  }}/>;

  return <div className="core-studio" data-workspace={view === 'workspace' || undefined}
    data-canvas-only={!hasCard || undefined} style={workspaceWidth && hasCard ? cardStyle : undefined}>
    {header}
    <div className="studio-body">
      <main className={`core-workspace${resizing ? ' is-resizing' : ''}`} ref={workspace} hidden={view !== 'workspace'}
        aria-label="Research illustration workspace" data-split={split?.first}>
        <div className="studio-panel-card" hidden={!hasCard} data-both-panels={activePanels.length === 2 || undefined}>
          {panelItems}
        </div>
        <section id="studio-canvas" className="canvas-panel" ref={canvasRef} aria-label="Shared idea canvas" aria-busy={canvasBusy} tabIndex={-1}
          data-highlighted={spotlight?.name === 'canvas' || undefined}
          data-drop-edge={dropTarget?.name === 'canvas' ? 'canvas' : undefined}
          onDragOver={event=>updateDropTarget(event,'canvas')} onDragLeave={event=>clearDropTarget(event,'canvas')}
          onDrop={event=>dropPanel(event,'canvas')}>
          {canvas(view === 'workspace' ? navigation : null)}
        </section>
      </main>
      {page}
      {view !== 'workspace' && <div key={view} className="canvas-tools studio-page-tools">{navigation}</div>}
    </div>
    {children(resetColumnWidths)}
  </div>;
});

export default WorkspaceColumns;
