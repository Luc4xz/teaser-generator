import React, { useState } from 'react';
import Icon from './StudioIcon.jsx';
import StudioFoldMark from './StudioFoldMark.jsx';

export default function StudioPanel({
  name, title, status, otherTitle, className, visible, highlighted, revealing, dropEdge, docked, canDock,
  onActivate, onFold, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onDock, onSeparate, children,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const heading = `studio-${name}-title`;
  return <section id={`${name}-column`} className={`studio-panel ${className}`}
    hidden={!visible} tabIndex={-1} aria-labelledby={heading} data-highlighted={highlighted || undefined} data-rail-reveal={revealing || undefined}
    data-drop-edge={dropEdge} onFocusCapture={onActivate} onPointerDownCapture={onActivate}
    onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <header className="studio-panel-header">
      <h2 id={heading}>{title}</h2>
      {status && <span className="studio-panel-status">{status}</span>}
      <div className="studio-panel-controls">
        <button type="button" className="studio-tool" title={`Fold ${title}`} aria-label={`Fold ${title}`}
          aria-controls={`${name}-column`} onClick={()=>{
          setMenuOpen(false);
          onFold();
        }}><StudioFoldMark open/></button>
        <div className="studio-layout-menu" onBlur={event=>{
          if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
        }} onKeyDown={event=>{
          if (event.key === 'Escape' && menuOpen) {
            setMenuOpen(false);
            event.currentTarget.querySelector('button').focus();
          }
        }}>
          <button type="button" className="studio-tool studio-grip" title={`Drag or move ${title}`}
            aria-label={`Move ${title}`} aria-expanded={menuOpen} aria-controls={`${name}-layout-menu`}
            draggable={canDock && !menuOpen} onDragStart={onDragStart} onDragEnd={onDragEnd}
            onClick={()=>setMenuOpen(open=>!open)}>
            <Icon name="grip" size={15}/>
          </button>
          <div className="studio-layout-options" id={`${name}-layout-menu`} hidden={!menuOpen}>
            <button type="button" disabled={!canDock} onClick={()=>{setMenuOpen(false);onDock('top');}}>Place above {otherTitle || 'other section'}</button>
            <button type="button" disabled={!canDock} onClick={()=>{setMenuOpen(false);onDock('bottom');}}>Place below {otherTitle || 'other section'}</button>
            {docked && <button type="button" onClick={()=>{setMenuOpen(false);onSeparate();}}>Separate columns</button>}
          </div>
        </div>
      </div>
    </header>
    {children}
  </section>;
}
