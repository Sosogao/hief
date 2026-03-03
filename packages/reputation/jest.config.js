/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@hief/common$': '<rootDir>/../common/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: false } }],
  },
  testTimeout: 30000,
  forceExit: true,
};
