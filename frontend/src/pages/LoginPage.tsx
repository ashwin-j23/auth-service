import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { loginSchema } from '../schemas/auth.schemas';
import type { LoginFormValues } from '../schemas/auth.schemas';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { useAuthStore } from '../store/authStore';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FormField } from '../components/ui/FormField';
import { Alert } from '../components/ui/Alert';
import { GoogleOAuthButton } from '../components/auth/GoogleOAuthButton';
import { useCountdown } from '../hooks/useCountdown';

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const [formError, setFormError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);
  const countdown = useCountdown(retryAfter);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });

  useEffect(() => {
    if (searchParams.get('session') === 'expired') {
      toast.error('Your session has expired. Please log in again.');
    }
    if (searchParams.get('google') === 'cancelled') {
      setFormError('You cancelled Google sign-in. You can try again anytime.');
    }
  }, [searchParams]);

  async function onSubmit(values: LoginFormValues) {
    setFormError(null);
    try {
      const result = await api.login(values);
      setSession(result);
      toast.success('Welcome back!');
      const redirect = searchParams.get('redirect');
      navigate(redirect ? decodeURIComponent(redirect) : '/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setRetryAfter(err.retryAfterSeconds ?? 900);
          setFormError('Too many attempts. Please wait before trying again.');
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  }

  const rateLimited = countdown > 0;

  return (
    <AuthLayout>
      <div className="mb-8 space-y-1.5">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Welcome back</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Sign in to your account to continue.</p>
      </div>

      {formError && (
        <div className="mb-5">
          <Alert variant={rateLimited ? 'warning' : 'danger'} onDismiss={() => setFormError(null)}>
            {formError}
            {rateLimited && <span className="block font-mono text-xs mt-1">Retry in {countdown}s</span>}
          </Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="Email" error={errors.email?.message} required>
          <Input type="email" autoComplete="email" placeholder="you@example.com" {...register('email')} />
        </FormField>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Password
            </label>
            <Link to="/reset-password/request" className="text-xs font-medium text-brand-500 hover:text-brand-600 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            error={Boolean(errors.password)}
            aria-invalid={Boolean(errors.password)}
            {...register('password')}
          />
          {errors.password && (
            <p role="alert" className="mt-1.5 text-xs font-medium text-danger-500">
              {errors.password.message}
            </p>
          )}
        </div>

        <Button type="submit" fullWidth loading={isSubmitting} disabled={rateLimited}>
          {rateLimited ? `Try again in ${countdown}s` : 'Sign in'}
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>

      <GoogleOAuthButton />

      <p className="mt-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Don&apos;t have an account?{' '}
        <Link to="/signup" className="font-medium text-brand-500 hover:text-brand-600 hover:underline">
          Sign up
        </Link>
      </p>
    </AuthLayout>
  );
}
