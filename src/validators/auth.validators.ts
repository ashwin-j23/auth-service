import { z } from 'zod';

export const signupSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
    // Deliberately no upper bound on complexity rules beyond length — NIST
    // guidance (SP 800-63B) favors length + breach-list checks over forced
    // character-class mixing, which mostly just pushes users to bad patterns.
    password: z.string().min(8, 'Password must be at least 8 characters long'),
    name: z.string().trim().min(1).max(100).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'refreshToken is required'),
  }),
});

export type SignupBody = z.infer<typeof signupSchema>['body'];
export type LoginBody = z.infer<typeof loginSchema>['body'];
export type RefreshBody = z.infer<typeof refreshSchema>['body'];
