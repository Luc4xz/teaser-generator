import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './teaser/TeaserApp.jsx';
import { applyStudioAppearance, readStudioAppearance } from './teaser/studio-appearance.js';

applyStudioAppearance(readStudioAppearance());
const root = createRoot(document.getElementById('root'));
root.render(<App />);
