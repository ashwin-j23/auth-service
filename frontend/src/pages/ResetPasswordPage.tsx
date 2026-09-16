import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { resetPasswordSchema } from '../schemas/auth.schemas';
import type { ResetPasswordFormValues } from '../schemas/auth.schemas';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FormField } from '../components/ui/FormField';
import { Alert } from '../components/ui/Alert';
import { PasswordStrengthMeter } from '../components/ui/PasswordStrengthMeter';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({ resolver: zodResolver(resetPasswordSchema) });

  const password = watch('password') ?? '';

  async function onSubmit(values: ResetPasswordFormValues) {
    if (!token) return;
    setFormError(null);
    try {
      await api.confirmPasswordReset(token, values.password);
      toast.success('Password has been reset. Please log in again.');
      navigate('/login', { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-50 dark:bg-danger-500/10">
            <XCircle size={30} className="text-danger-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Invalid link</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This password reset link is missing or malformed. Request a new one to continue.
          </p>
          <Link to="/reset-password/request">
            <Button className="mt-2">Request a new link</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="mb-8 space-y-1.5">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Set a new password</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Choose a strong password you haven&apos;t used before. This will sign out all other sessions.
        </p>
      </div>

      {formError && (
        <div className="mb-5">
          <Alert
            variant="danger"
            onDismiss={() => setFormError(null)}
            title={formError.toLowerCase().includes('expired') || formError.toLowerCase().includes('invalid') ? 'Link expired' : undefined}
          >
            {formError}
            {(formError.toLowerCase().includes('expired') || formError.toLowerCase().includes('invalid')) && (
              <>
                {' '}
                <Link to="/reset-password/request" className="underline">
                  Request a new one
                </Link>
                .
              </>
            )}
          </Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="New password" error={errors.password?.message} required>
          <Input type="password" autoComplete="new-password" placeholder="At least 8 characters" {...register('password')} />
        </FormField>
        <PasswordStrengthMeter password={password} />

        <FormField label="Confirm new password" error={errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" placeholder="Re-enter your password" {...register('confirmPassword')} />
        </FormField>

        <Button type="submit" fullWidth loading={isSubmitting}>
          Reset password
        </Button>
      </form>

      <p className="mt-8 text-center text-sm">
        <CheckCircle2 size={13} className="mr-1 inline text-success-500" />
        <span className="text-slate-500 dark:text-slate-400">This immediately signs you out everywhere else.</span>
      </p>
    </AuthLayout>
  );
}
