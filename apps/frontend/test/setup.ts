import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  Object.assign(window, { ResizeObserver: NoopResizeObserver });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
