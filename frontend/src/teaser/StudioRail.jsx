import React from 'react';
import Icon from './StudioIcon.jsx';
import { studioHref } from './studio-navigation.js';

const sections = [
  ['paper', 'Illustrate your paper', 'file', 'paper-column'],
  ['concept', 'Review your concept', 'concept', 'concept-column'],
  ['canvas', 'Draggable canvas', 'canvas', 'studio-canvas'],
];
const tools = [
  ['controlCenter', 'Control Center', 'controlCenter'],
  ['chat', 'AI chat', 'chat'],
];

export default function StudioRail({visible, view, onSection, buttonRefs}) {
  const currentTool = view === 'history' ? 'controlCenter' : view;
  return <nav className="studio-rail" aria-label="Workspace tools">
    {sections.map(([id, label, icon, controls]) => <button
      key={id}
      ref={element=>{buttonRefs.current[id]=element;}}
      type="button"
      className="studio-tool"
      aria-label={label}
      title={label}
      aria-controls={controls}
      aria-expanded={id === 'canvas' ? undefined : view === 'workspace' && visible[id]}
      onClick={()=>onSection(id)}
    ><Icon name={icon} size={18}/></button>)}
    <span aria-hidden="true" className="studio-rail-divider"/>
    {tools.map(([id, label, icon]) => <a key={id} className="studio-tool"
      href={studioHref(id)} aria-label={label} title={label} aria-current={currentTool === id ? 'page' : undefined}
    ><Icon name={icon} size={18}/></a>)}
  </nav>;
}
