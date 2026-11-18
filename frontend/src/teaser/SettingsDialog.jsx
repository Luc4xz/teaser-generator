import React from 'react';
import StudioDialog from './StudioDialog.jsx';
import { PALETTES } from './studio-appearance.js';

export default function SettingsDialog({
  open, session, project, models, status, disabled, appearance, changeAppearance,
  onSwitchAccount, onResetLayout, onSelect, onReload, onClose,
}) {
  const accountName = session.displayName || session.username || 'Signed in';
  return <StudioDialog id="settings-dialog" open={open} title="Settings"
    description="Appearance, account, models, and workspace layout." onClose={onClose}>
    <section className="workspace-current settings-section" aria-labelledby="settings-appearance-title">
      <h3 id="settings-appearance-title">Appearance</h3>
      <div className="studio-palette-options" role="group" aria-label="Color palette">
        {PALETTES.map(({id,label})=><button key={id} type="button" className="studio-palette-button"
          aria-pressed={appearance.palette === id} onClick={event=>changeAppearance({palette:id},event.currentTarget)}>
          <span className="studio-palette-swatch" style={{backgroundColor:`var(--palette-${id})`}} aria-hidden="true"/>{label}
        </button>)}
      </div>
    </section>
    <section className="workspace-current settings-section" aria-labelledby="settings-account-title">
      <h3 id="settings-account-title">Account</h3>
      <div className="settings-row">
        <div className="settings-account">
          <span className="person-avatar" aria-hidden="true">{accountName.slice(0,1).toUpperCase()}</span>
          <div><strong>{accountName}</strong>{session.username && <span>@{session.username}</span>}</div>
        </div>
        <button type="button" className="secondary-action" disabled={disabled} onClick={onSwitchAccount}>Switch account</button>
      </div>
    </section>
    <section className="workspace-current settings-section model-settings" aria-labelledby="settings-models-title">
      <h3 id="settings-models-title">Generation models</h3>
      <p>Model choices are saved with this project.</p>
      <div className="model-pickers">
        {['text','image'].map(kind=>{
          const field = `${kind}Model`;
          const choices = models[kind];
          const value = choices.some(model=>model.id === project[field]) ? project[field] : '';
          return <label className="model-picker" key={kind}>
            {kind === 'text' ? 'Text model' : 'Image model'}
            <select value={value} disabled={disabled || !choices.length} onChange={event=>onSelect(field,event.target.value)}>
              {!value && <option value="" disabled>Select a model</option>}
              {choices.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>;
        })}
      </div>
      {status && <p role="status">{status}</p>}
      <button type="button" className="secondary-action" disabled={disabled} onClick={onReload}>Reload models</button>
    </section>
    <section className="workspace-current settings-section" aria-labelledby="settings-layout-title">
      <h3 id="settings-layout-title">Workspace layout</h3>
      <div className="settings-row">
        <p>Restore the default column widths for this browser.</p>
        <button type="button" className="secondary-action" onClick={onResetLayout}>Reset column widths</button>
      </div>
    </section>
  </StudioDialog>;
}
