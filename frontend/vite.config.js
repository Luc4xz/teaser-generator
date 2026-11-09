import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base =
  process.env.VITE_BASE_PATH ||
  (process.env.GITHUB_ACTIONS ? '/teaser-generator/' : '/');

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
});
