import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { AppShell } from '../components/layout/AppShell';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, user } = useAuthStore();
  const location = useLocation();

  if (status !== 'authenticated') {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }

  if (user && !user.isEmailVerified) {
    return <Navigate to="/verify-email?pending=true" replace />;
  }

  return <AppShell>{children}</AppShell>;
}

export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);

  if (status === 'authenticated') {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
