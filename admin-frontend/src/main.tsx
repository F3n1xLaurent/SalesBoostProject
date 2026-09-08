import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProviders } from './app/providers/AppProviders';
import { resetBodyScrollLock } from './shared/lib/body-scroll-lock';
import { initializeFrontendMonitoring, Sentry } from './shared/lib/monitoring/sentry';
import './index.css';

resetBodyScrollLock();
initializeFrontendMonitoring();

const rootElement = document.getElementById('root') as HTMLElement;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div role="alert">Произошла ошибка интерфейса. Обновите страницу.</div>}>
      <AppProviders>
        <App />
      </AppProviders>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
