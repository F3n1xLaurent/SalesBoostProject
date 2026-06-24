import { Route, Routes } from 'react-router';
import { SystemPage } from './pages/system/ui/SystemPage';
import { PublicVoiceDemoPage } from './pages/public-voice-demo/ui/PublicVoiceDemoPage';
import { LoginRoutePage } from './pages/login/ui/LoginRoutePage';
import { RequireAuth } from './app/providers/RequireAuth';
import { AuthBootstrap } from './app/providers/AuthBootstrap';
import { TrainPage } from './pages/train/ui/TrainPage';

export default function App() {
  return (
    <>
      <AuthBootstrap />
      <Routes>
        <Route path="/demo-call/*" element={<PublicVoiceDemoPage />} />
        <Route path="/login" element={<LoginRoutePage />} />
        <Route path="/train/*" element={<RequireAuth><TrainPage /></RequireAuth>} />
        <Route path="/*" element={<RequireAuth><SystemPage /></RequireAuth>} />
      </Routes>
    </>
  );
}
