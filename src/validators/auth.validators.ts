import { z } from 'zod';

export const signupSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
    // Deliberately no upper bound on complexity rules — NIST guidance
    // (SP 800-63B) favors length + breach-list checks over forced
    // character-class mixing, which mostly just pushes users to bad patterns.
    // The max(72) here isn't a complexity rule, though — it's a correctness
    // fix: bcrypt (src/utils/password.ts) silently truncates its input at 72
    // *bytes*, so without this, two different passwords sharing the same
    // 72-byte prefix would hash identically and both work. Bounding at 72
    // *characters* is a conservative proxy for that (a character can be more
    // than one UTF-8 byte, so this can't fully eliminate the truncation case
    // for non-ASCII input, but it removes the common case and keeps the
    // limit simple to explain to a user).
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long'),
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

export const googleExchangeSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'code is required'),
  }),
});

export const requestEmailVerificationSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
  }),
});

export const confirmEmailVerificationSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'token is required'),
  }),
});

export const requestPasswordResetSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Must be a valid email address'),
  }),
});

// Same length bounds as signupSchema's password field, and for the same
// reason (bcrypt's 72-byte truncation — see the comment there); a reset
// password goes through the exact same hashPassword() call.
export const confirmPasswordResetSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'token is required'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password must be at most 72 characters long'),
  }),
});

export type SignupBody = z.infer<typeof signupSchema>['body'];
export type LoginBody = z.infer<typeof loginSchema>['body'];
export type RefreshBody = z.infer<typeof refreshSchema>['body'];
export type GoogleExchangeBody = z.infer<typeof googleExchangeSchema>['body'];
export type RequestEmailVerificationBody = z.infer<typeof requestEmailVerificationSchema>['body'];
export type ConfirmEmailVerificationBody = z.infer<typeof confirmEmailVerificationSchema>['body'];
export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetSchema>['body'];
export type ConfirmPasswordResetBody = z.infer<typeof confirmPasswordResetSchema>['body'];
