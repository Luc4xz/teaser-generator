import React from 'react';

export default function VersionStack({ images, selectedId, onSelect, saveStatus }) {
  return <aside className="version-stack" aria-label="Saved image versions">
    <div className="version-stack-heading"><h3>Version stack</h3><span>{images.length}</span></div>
    <p className={`version-save-status ${saveStatus}`} role="status">{saveStatus === 'saved' ? 'Saved on this device' : saveStatus === 'error' ? 'Could not save on this device' : 'Saving…'}</p>
    <ol className="version-stack-list">
      {images.map((item, index) => ({ item, number: index + 1 })).reverse().map(({ item, number }) => {
        const parentIndex = images.findIndex(version => version.id === item.parentVersionId);
        const date = new Date(item.createdAt);
        const label = item.revisionFeedback || item.userPrompt || item.sourceTitle || 'Initial direction';
        return <li key={item.id}>
          <button type="button" className={`version-stack-card ${item.id === selectedId ? 'selected' : ''}`} aria-pressed={item.id === selectedId} aria-label={`View version ${number}: ${label}`} onClick={() => onSelect(item.id)}>
            <div className="version-stack-preview"><img src={item.image} alt="" loading="lazy"/><span>V{number}</span></div>
            <div className="version-stack-info">
              <div className="version-stack-title"><strong>Version {number}</strong>{number === images.length && <span>Latest</span>}</div>
              <p title={label}>{label}</p>
              <span className="version-stack-origin">{parentIndex >= 0 ? `From version ${parentIndex + 1}` : 'Original direction'}</span>
              {!Number.isNaN(date.getTime()) && <time dateTime={item.createdAt}>{date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>}
            </div>
          </button>
        </li>;
      })}
    </ol>
    <p className="version-stack-note">Every generation adds a version. Select any version to view, download, or refine it.</p>
  </aside>;
}
