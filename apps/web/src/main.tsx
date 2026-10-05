import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/archivo';
import './styles/index.css';
import './i18n';
import { App } from './App';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

// installable app + offline shell; skipped in development so hot reload is not served from a cache
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener(
    'load',
    () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined),
  );
}
