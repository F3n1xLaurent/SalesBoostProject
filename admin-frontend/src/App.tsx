import { Route, Routes } from 'react-router';
import { SystemPage } from './pages/system/ui/SystemPage';
import { PublicVoiceDemoPage } from './pages/public-voice-demo/ui/PublicVoiceDemoPage';
import { LandingPage } from './pages/landing/ui/LandingPage';
import { LoginRoutePage } from './pages/login/ui/LoginRoutePage';
import { RequireAuth } from './app/providers/RequireAuth';
import { AuthBootstrap } from './app/providers/AuthBootstrap';
import { LegacyTrainRedirect } from './pages/train/ui/LegacyTrainRedirect';

export default function App() {
  return (
    <>
      <AuthBootstrap />
      <Routes>
        <Route path="/landing/*" element={<LandingPage />} />
        <Route path="/demo-call/*" element={<PublicVoiceDemoPage />} />
        <Route path="/login" element={<LoginRoutePage />} />
        <Route path="/train/*" element={<RequireAuth><LegacyTrainRedirect /></RequireAuth>} />
        <Route path="/*" element={<RequireAuth><SystemPage /></RequireAuth>} />
      </Routes>
    </>
  );
}
