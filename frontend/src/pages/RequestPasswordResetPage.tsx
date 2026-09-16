import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion } from 'framer-motion';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { requestEmailSchema } from '../schemas/auth.schemas';
import type { RequestEmailFormValues } from '../schemas/auth.schemas';
import { api } from '../lib/api/client';
import { ApiError } from '../lib/api/types';
import { AuthLayout } from '../components/layout/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FormField } from '../components/ui/FormField';
import { Alert } from '../components/ui/Alert';

export default function RequestPasswordResetPage() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestEmailFormValues>({ resolver: zodResolver(requestEmailSchema) });

  async function onSubmit(values: RequestEmailFormValues) {
    setFormError(null);
    try {
      await api.requestPasswordReset(values.email);
      setSent(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4 py-6 text-center"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-900/30">
            <MailCheck size={28} className="text-brand-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Check your inbox</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            If an account exists for that email, a password reset link has been sent.
          </p>
          <Link to="/login" className="mt-2 text-sm font-medium text-brand-500 hover:text-brand-600 hover:underline">
            Back to sign in
          </Link>
        </motion.div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Link to="/login" className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
        <ArrowLeft size={15} />
        Back to sign in
      </Link>

      <div className="mb-8 space-y-1.5">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Reset your password</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>
      </div>

      {formError && (
        <div className="mb-5">
          <Alert variant="danger" onDismiss={() => setFormError(null)}>
            {formError}
          </Alert>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="Email" error={errors.email?.message} required>
          <Input type="email" autoComplete="email" placeholder="you@example.com" {...register('email')} />
        </FormField>
        <Button type="submit" fullWidth loading={isSubmitting}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
