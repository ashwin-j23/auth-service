/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/generated/**'],
  coverageDirectory: 'coverage',
};
