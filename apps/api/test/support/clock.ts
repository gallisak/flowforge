const REAL_TIMERS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

export function setClock(at: string): void {
  jest.useFakeTimers({ advanceTimers: true, doNotFake: [...REAL_TIMERS] });
  jest.setSystemTime(new Date(at));
}

export function restoreClock(): void {
  jest.useRealTimers();
}
