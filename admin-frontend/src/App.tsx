import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { RequireAuth } from './app/providers/RequireAuth';
import { AuthBootstrap } from './app/providers/AuthBootstrap';

const SystemPage = lazy(() => import('./pages/system/ui/SystemPage').then((module) => ({ default: module.SystemPage })));
const PublicVoiceDemoPage = lazy(() => import('./pages/public-voice-demo/ui/PublicVoiceDemoPage').then((module) => ({ default: module.PublicVoiceDemoPage })));
const LoginRoutePage = lazy(() => import('./pages/login/ui/LoginRoutePage').then((module) => ({ default: module.LoginRoutePage })));
const LegacyTrainRedirect = lazy(() => import('./pages/train/ui/LegacyTrainRedirect').then((module) => ({ default: module.LegacyTrainRedirect })));

export default function App() {
  return (
    <>
      <AuthBootstrap />
      <Suspense fallback={<div role="status" aria-live="polite">Загрузка…</div>}>
        <Routes>
          <Route path="/demo-call/*" element={<PublicVoiceDemoPage />} />
          <Route path="/login" element={<LoginRoutePage />} />
          <Route path="/train/*" element={<RequireAuth><LegacyTrainRedirect /></RequireAuth>} />
          <Route path="/*" element={<RequireAuth><SystemPage /></RequireAuth>} />
        </Routes>
      </Suspense>
    </>
  );
}
