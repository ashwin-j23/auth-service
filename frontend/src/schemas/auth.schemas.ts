import { z } from 'zod';

// Mirrors src/validators/auth.validators.ts on the backend exactly — same
// bounds, same messages where it matters for UX consistency.
export const emailSchema = z.string().trim().min(1, 'Email is required').email('Enter a valid email address');

export const signupSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(72, 'Password must be at most 72 characters long'),
  name: z.string().trim().min(1).max(100).optional().or(z.literal('')),
});
export type SignupFormValues = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginFormValues = z.infer<typeof loginSchema>;

export const requestEmailSchema = z.object({
  email: emailSchema,
});
export type RequestEmailFormValues = z.infer<typeof requestEmailSchema>;

export const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
export type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;
