import type { PrismaClient } from '@prisma/client';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';

// Register the mock BEFORE requiring the real module, so every subsequent
// `import { prisma } from '../../src/lib/prisma'` (in services, controllers,
// etc.) resolves to this deep mock instead of a real PrismaClient. Using a
// plain require() here (rather than an ES `import`) makes the ordering
// explicit instead of depending on jest/ts-jest hoisting behavior.
jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  prisma: mockDeep<PrismaClient>(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../../src/lib/prisma') as { prisma: PrismaClient };

export const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
});
