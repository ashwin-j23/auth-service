// Replaces `dotenv/config` for the whole test suite (see jest.config.js's
// `moduleNameMapper`). Without this, `src/config/env.ts`'s `import
// 'dotenv/config'` re-reads the real .env file on disk every time
// `jest.isolateModules` re-requires it — silently repopulating any var a
// test just deleted from `process.env` (e.g. withFreshEnv clearing
// CORS_ALLOWED_ORIGINS) with whatever a developer's real .env happens to
// contain. Tests must be hermetic against tests/setup.ts and withFreshEnv
// alone, never against what's on disk.
export {};
