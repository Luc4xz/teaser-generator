import React from 'react';

export function ParameterLock({ label, locked, disabled, onToggle }) {
  return <button type="button" className={`parameter-lock ${locked ? 'is-locked' : ''}`} aria-label={`${locked ? 'Unlock' : 'Lock'} ${label}`} aria-pressed={!!locked} title={locked ? 'Keep this value. Unlock to change it.' : 'Allow changes. Lock to preserve this value.'} disabled={disabled} onClick={onToggle}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/>{locked ? <path d="M8 10V7a4 4 0 0 1 8 0v3"/> : <path d="M8 10V7a4 4 0 0 1 7.5-2"/>}<path d="M12 14v3"/></svg>
    <span>{locked ? 'Keep' : 'Change'}</span>
  </button>;
}
export default function LockedField({ name, label, locks, onToggle, disabled, children }) {
  const locked = !!locks?.[name];
  return <div className={`brief-field lockable-field ${locked ? 'field-locked' : ''}`}>
    <div className="parameter-label"><label htmlFor={`parameter-${name}`}>{label}</label><ParameterLock label={label} locked={locked} disabled={disabled} onToggle={()=>onToggle(name)}/></div>
    {React.cloneElement(children, {id:`parameter-${name}`, disabled:disabled || locked})}
  </div>;
}
