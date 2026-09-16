import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { useAuthStore } from '../store/authStore';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

export default function OAuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const oauthError = searchParams.get('error');
    if (oauthError === 'google_consent_denied') {
      navigate('/login?google=cancelled', { replace: true });
      return;
    }

    const code = searchParams.get('code');
    if (!code) {
      setError('No authorization code was provided by Google.');
      return;
    }

    api
      .googleExchange(code)
      .then((result) => {
        setSession(result);
        toast.success('Signed in with Google');
        navigate('/dashboard', { replace: true });
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Could not complete Google sign-in.');
      });
  }, [searchParams, navigate, setSession]);

  if (error) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-50 dark:bg-danger-500/10">
            <XCircle size={30} className="text-danger-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Google sign-in failed</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{error}</p>
          <Link to="/login">
            <Button className="mt-2">Back to sign in</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <Spinner size="lg" className="text-brand-500" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Finishing Google sign-in…</p>
      </div>
    </AuthLayout>
  );
}
