const questionMock = jest.fn();
const closeMock = jest.fn();

jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({
    question: questionMock,
    close: closeMock,
  })),
}));

import * as readline from 'readline';
import { confirm, isInteractive } from '../src/prompt.js';

describe('prompt', () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalStdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function setTTY(stdin: boolean, stdout: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
  }

  beforeEach(() => {
    questionMock.mockReset();
    closeMock.mockReset();
    (readline.createInterface as jest.Mock).mockClear();
  });

  afterEach(() => {
    if (originalStdin) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdin);
    }
    if (originalStdout) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdout);
    }
  });

  test('isInteractive is false unless both stdin and stdout are TTYs', () => {
    setTTY(false, false);
    expect(isInteractive()).toBe(false);
    setTTY(true, false);
    expect(isInteractive()).toBe(false);
    setTTY(true, true);
    expect(isInteractive()).toBe(true);
  });

  test('confirm returns false immediately when not interactive (never prompts)', async () => {
    setTTY(false, false);
    const result = await confirm('Send now?');
    expect(result).toBe(false);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  test('confirm resolves true for a "y" answer', async () => {
    setTTY(true, true);
    questionMock.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));
    expect(await confirm('Send now?')).toBe(true);
    expect(closeMock).toHaveBeenCalled();
  });

  test('confirm resolves true for "yes" (case-insensitive, trimmed)', async () => {
    setTTY(true, true);
    questionMock.mockImplementation((_q: string, cb: (answer: string) => void) => cb('  YES '));
    expect(await confirm('Send now?')).toBe(true);
  });

  test('confirm resolves false for "n" or empty answer', async () => {
    setTTY(true, true);
    questionMock.mockImplementation((_q: string, cb: (answer: string) => void) => cb('n'));
    expect(await confirm('Send now?')).toBe(false);
    questionMock.mockImplementation((_q: string, cb: (answer: string) => void) => cb(''));
    expect(await confirm('Send now?')).toBe(false);
  });
});
