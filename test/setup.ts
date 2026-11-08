// Jest setup file for global configuration
// This file runs before each test file

// Extend Jest matchers if needed
// import '@testing-library/jest-dom';

// Keep the first-run skill note out of every test's stderr (and out of the real config dir).
process.env.COOLHAND_NO_NOTICE = '1';

// Set up any global test utilities or mocks here
global.console = {
  ...console,
  // Suppress console.log in tests unless needed
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};