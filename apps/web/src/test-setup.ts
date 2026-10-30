import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Ant Design renders slowly when the whole suite runs in parallel; allow for it.
configure({ asyncUtilTimeout: 5000 });

// Tests of the device storage layer run in plain Node (`@vitest-environment node`), which has no
// window; everything below is for the jsdom tests only.
// jsdom has no matchMedia; Ant Design's responsive components need it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no ResizeObserver; Ant Design's popups and selects observe their size.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
