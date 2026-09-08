import { PrismaClient } from '@prisma/client';

// A single PrismaClient instance shared across the app (and swapped for a
// deep mock in unit tests — see tests/mocks/prisma.mock.ts).
export const prisma = new PrismaClient();
