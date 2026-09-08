import type { User } from '@prisma/client';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  isEmailVerified: boolean;
  createdAt: Date;
}

/** Strips fields (passwordHash, googleId) that should never leave the server. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
  };
}
