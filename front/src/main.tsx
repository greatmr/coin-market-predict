import '@fontsource-variable/inter/opsz.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { loadRuntimeConfig } from './lib/config';
import './styles.css';

// The API location (same origin by default) comes from /app-config.json before the first request.
void loadRuntimeConfig().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
