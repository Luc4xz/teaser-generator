import React from 'react';

export default function StudioFoldMark({open}) {
  return <span className="studio-fold-mark" data-open={open || undefined} aria-hidden="true"/>;
}
