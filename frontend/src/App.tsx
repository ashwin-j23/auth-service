import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './components/layout/AuthProvider';
import { CursorGuide } from './components/effects/CursorGuide';
import { ProtectedRoute, PublicOnlyRoute } from './routes/guards';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import RequestPasswordResetPage from './pages/RequestPasswordResetPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import OAuthCallbackPage from './pages/OAuthCallbackPage';
import DashboardPage from './pages/DashboardPage';
import SettingsSecurityPage from './pages/SettingsSecurityPage';
import SettingsProfilePage from './pages/SettingsProfilePage';
import ForbiddenPage from './pages/ForbiddenPage';
import ServerErrorPage from './pages/ServerErrorPage';
import NotFoundPage from './pages/NotFoundPage';
import CursorDemoPage from './pages/CursorDemoPage';

export default function App() {
  return (
    <AuthProvider>
      <CursorGuide />
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
        <Route path="/signup" element={<PublicOnlyRoute><SignupPage /></PublicOnlyRoute>} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/reset-password/request" element={<PublicOnlyRoute><RequestPasswordResetPage /></PublicOnlyRoute>} />
        <Route path="/reset-password" element={<PublicOnlyRoute><ResetPasswordPage /></PublicOnlyRoute>} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />

        <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
        <Route path="/settings/security" element={<ProtectedRoute><SettingsSecurityPage /></ProtectedRoute>} />
        <Route path="/settings/profile" element={<ProtectedRoute><SettingsProfilePage /></ProtectedRoute>} />

        <Route path="/cursor-demo" element={<CursorDemoPage />} />

        <Route path="/403" element={<ForbiddenPage />} />
        <Route path="/500" element={<ServerErrorPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
