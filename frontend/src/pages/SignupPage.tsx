import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { signupSchema } from '../schemas/auth.schemas';
import type { SignupFormValues } from '../schemas/auth.schemas';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { useAuthStore } from '../store/authStore';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FormField } from '../components/ui/FormField';
import { Alert } from '../components/ui/Alert';
import { GoogleOAuthButton } from '../components/auth/GoogleOAuthButton';
import { PasswordStrengthMeter } from '../components/ui/PasswordStrengthMeter';

export default function SignupPage() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({ resolver: zodResolver(signupSchema) });

  const password = watch('password') ?? '';

  async function onSubmit(values: SignupFormValues) {
    setFormError(null);
    try {
      const result = await api.signup({
        email: values.email,
        password: values.password,
        name: values.name || undefined,
      });
      setSession(result);
      toast.success('Account created — verify your email to unlock the dashboard.');
      navigate('/verify-email?pending=true', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.status === 429 ? 'Too many attempts. Please wait before trying again.' : err.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8 space-y-1.5">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Create your account</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Get started in less than a minute.</p>
      </div>

      {formError && (
        <div className="mb-5">
          <Alert variant="danger" onDismiss={() => setFormError(null)}>
            {formError}
          </Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="Name" error={errors.name?.message} helperText="Optional">
          <Input autoComplete="name" placeholder="Ada Lovelace" {...register('name')} />
        </FormField>

        <FormField label="Email" error={errors.email?.message} required>
          <Input type="email" autoComplete="email" placeholder="you@example.com" {...register('email')} />
        </FormField>

        <FormField label="Password" error={errors.password?.message} required>
          <Input type="password" autoComplete="new-password" placeholder="At least 8 characters" {...register('password')} />
        </FormField>
        <PasswordStrengthMeter password={password} />

        <Button type="submit" fullWidth loading={isSubmitting}>
          Create account
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="text-xs uppercase tracking-wide text-slate-400">or</span>
        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>

      <GoogleOAuthButton label="Sign up with Google" />

      <p className="mt-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-500 hover:text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
