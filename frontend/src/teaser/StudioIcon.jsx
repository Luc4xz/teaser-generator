import React from 'react';

export default function Icon({ name, size = 20 }) {
  const paths = {
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    file: <><path d="M14 3H5v18h14V8z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
    research: <><rect x="3" y="3.5" width="18" height="17" rx="3"/><path d="M7 7.5v9h10"/><path d="m9.5 13.5 3-3 2 1.5 3-3"/><circle cx="17.5" cy="9" r=".85" fill="currentColor" stroke="none"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
    link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/></>,

    concept: <><path d="M9 18h6m-5 3h4m-3-6v-4m2 4v-4"/><path d="M8.2 14.8a6 6 0 1 1 7.6 0L15 16H9z"/></>,
    canvas: <><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="6" y="7" width="4" height="4" rx=".6"/><rect x="14" y="13" width="4" height="4" rx=".6"/><path d="m10 11 4 2"/></>,
    folder: <><path d="M3 8V6.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2V10"/><path d="M3 10h16.7a1.5 1.5 0 0 1 1.45 1.88l-1.45 5.7a2 2 0 0 1-1.94 1.5H5a2 2 0 0 1-2-2Z"/><path d="M7 14h5"/></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--ui-surface)"/><circle cx="15" cy="12" r="2" fill="var(--ui-surface)"/><circle cx="10" cy="18" r="2" fill="var(--ui-surface)"/></>,
    moon: <path d="M20.4 15.25a8.7 8.7 0 1 1-11.65-11.65 7.5 7.5 0 0 0 11.65 11.65Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 5a3 3 0 0 1 0 6m2 3a4 4 0 0 1 3 4v2"/></>,
    controlCenter: <><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18m-11 0v11M6.5 6.5h.01" strokeWidth="1.7"/><path d="M13 16l2-2.5 2 1 1.5-2"/><path d="M6.5 13h.01m0 3h.01" strokeWidth="2"/></>,
    history: <><path d="M3 12a9 9 0 1 1 2.7 6.4M3 6v6h6"/><path d="M12 7v5l3 2"/></>,
    chat: <><path d="M20 4H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3v3l4-3h9a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z"/><path d="M8 10h8m-8 4h5"/></>,
    grip: <><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3"/></>,
    pointer: <path d="m5 3 13 10-6 1-3 6z"/>,
    hand: <path d="M8 12V7a1.5 1.5 0 0 1 3 0v4-6a1.5 1.5 0 0 1 3 0v6-4a1.5 1.5 0 0 1 3 0v4-2a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-2a5 5 0 0 1-4-2l-4-5a1.5 1.5 0 0 1 2-2z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    minus: <path d="M5 12h14"/>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    inspect: <><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></>,
    send: <path d="M3 4l18 8-18 8 3-8zm3 8h8"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.image}</svg>;
}
