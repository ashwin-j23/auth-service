import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { requestEmailSchema } from '../schemas/auth.schemas';
import type { RequestEmailFormValues } from '../schemas/auth.schemas';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { useAuthStore } from '../store/authStore';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FormField } from '../components/ui/FormField';
import { Alert } from '../components/ui/Alert';
import { Spinner } from '../components/ui/Spinner';
import { useCountdown } from '../hooks/useCountdown';

type Status = 'verifying' | 'success' | 'error' | 'pending';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const user = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const countdown = useCountdown(resendCooldown);

  useEffect(() => {
    if (!token) return;
    api
      .confirmEmailVerification(token)
      .then(() => setStatus('success'))
      .catch((err) => {
        setErrorMessage(err instanceof ApiError ? err.message : 'This link is invalid or has expired.');
        setStatus('error');
      });
  }, [token]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestEmailFormValues>({
    resolver: zodResolver(requestEmailSchema),
    defaultValues: { email: user?.email ?? '' },
  });

  async function onResend(values: RequestEmailFormValues) {
    try {
      await api.requestEmailVerification(values.email);
      setResendCooldown(60);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setResendCooldown(err.retryAfterSeconds ?? 900);
      }
    }
  }

  if (status === 'verifying') {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <Spinner size="lg" className="text-brand-500" />
          <p className="text-sm text-slate-500 dark:text-slate-400">Verifying your email…</p>
        </div>
      </AuthLayout>
    );
  }

  if (status === 'success') {
    return (
      <AuthLayout>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4 py-6 text-center"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-50 dark:bg-success-500/10">
            <CheckCircle2 size={30} className="text-success-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Email verified</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Your email address has been confirmed. You can now sign in.
          </p>
          <Link to="/login">
            <Button className="mt-2">Continue to sign in</Button>
          </Link>
        </motion.div>
      </AuthLayout>
    );
  }

  if (status === 'error') {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-50 dark:bg-danger-500/10">
            <XCircle size={30} className="text-danger-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Verification failed</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{errorMessage}</p>
          <Button onClick={() => setStatus('pending')} variant="secondary" className="mt-2">
            Request a new link
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-900/30">
          <MailCheck size={28} className="text-brand-500" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Check your inbox</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          We&apos;ve sent a verification link to your email. Click it to activate your account.
        </p>
      </div>

      {countdown > 0 && (
        <div className="mt-5">
          <Alert variant="info">Verification email sent. You can resend in {countdown}s.</Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onResend)} noValidate className="mt-6 space-y-4">
        <FormField label="Email address" error={errors.email?.message}>
          <Input type="email" placeholder="you@example.com" disabled={Boolean(user)} {...register('email')} />
        </FormField>
        <Button type="submit" variant="secondary" fullWidth loading={isSubmitting} disabled={countdown > 0}>
          {countdown > 0 ? `Resend in ${countdown}s` : 'Resend verification email'}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-slate-500 dark:text-slate-400">
        <Link to="/login" className="font-medium text-brand-500 hover:text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
