import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import { ConfirmProvider } from './components/ui/confirm.jsx';
import { I18nProvider } from './lib/i18n.js';
import { useActiveClient } from './lib/api.js';
import './index.css';

// Drive the UI language from the ACTIVE client's config.locale so switching client
// switches language (I18nProvider re-derives t from its `locale` prop). Sits inside
// QueryClientProvider so it can read the clients query; before the first fetch (or
// when a client has no locale) the prop is undefined and I18nProvider falls back to
// the stored/browser locale, then re-renders once the active client resolves.
function LocaleGate({ children }) {
  const { activeClient } = useActiveClient();
  return <I18nProvider locale={activeClient?.locale}>{children}</I18nProvider>;
}

// The real first-paint theme bootstrap lives inline in index.html <head>
// (UX-07); this line is only a dev-server safety mirror.
document.documentElement.classList.toggle('dark', localStorage.getItem('pendpost-theme') !== 'light');
// Gate the body color transition behind .theme-ready (added one frame after
// first paint) so the bootstrap itself never animates the wrong theme.
requestAnimationFrame(() => document.documentElement.classList.add('theme-ready'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleGate>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </LocaleGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
