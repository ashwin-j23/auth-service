/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  // Tests must be hermetic against tests/setup.ts + withFreshEnv alone —
  // never against a real .env file that happens to exist on the machine
  // running them. See tests/mocks/dotenv-config.ts.
  moduleNameMapper: {
    '^dotenv/config$': '<rootDir>/tests/mocks/dotenv-config.ts',
  },
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/generated/**'],
  coverageDirectory: 'coverage',
};
