import React, { useLayoutEffect, useRef } from 'react';

export default function StudioDialog({id, open, title, description, working, onClose, className='', children}) {
  const dialog = useRef(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  function dismiss() {
    if (!working) onClose();
  }

  return <dialog id={id} ref={dialog} className={`workspace-dialog ${className}`} aria-labelledby={`${id}-title`}
    onCancel={event=>{event.preventDefault();dismiss();}}
    onClick={event=>{if(event.target === event.currentTarget) dismiss();}}>
    <header className="workspace-dialog-header">
      <div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div>
      <button type="button" className="workspace-close" onClick={dismiss} disabled={working} aria-label={`Close ${title.toLowerCase()}`}>×</button>
    </header>
    <div className="workspace-dialog-body">{children}</div>
  </dialog>;
}
