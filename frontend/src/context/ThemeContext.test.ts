import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTheme, applyTheme, type ResolvedTheme } from './ThemeContext';

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal('window', {
    matchMedia: vi.fn((_query: string) => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function mockLocalStorage() {
  const store: Record<string, string> = {};
  const ls = {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
  vi.stubGlobal('localStorage', ls);
  return store;
}

/**
 * Minimal DOM stub that records the theme-related mutations ThemeContext
 * performs on `document.documentElement` (class, dataset, colorScheme) and the
 * injected <style> element. Enough to assert the FOUC/pre-paint contract.
 */
function mockDocument() {
  const style = {
    id: '',
    textContent: '',
  };
  const root = {
    classList: { toggle: vi.fn() },
    dataset: {} as Record<string, string>,
    style: { colorScheme: '' },
  };
  const doc = {
    documentElement: root,
    head: { appendChild: vi.fn() },
    getElementById: () => null,
    createElement: () => style,
  };
  vi.stubGlobal('document', doc);
  return { root, style };
}

describe('resolveTheme', () => {
  beforeEach(() => mockLocalStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('returns explicit light/dark preferences regardless of system', () => {
    mockMatchMedia(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('falls back to system preference when set to system', () => {
    mockMatchMedia(true);
    expect(resolveTheme('system')).toBe('dark');
    mockMatchMedia(false);
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    mockLocalStorage();
    mockMatchMedia(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('applies the .dark class and data-theme for dark mode', () => {
    const { root } = mockDocument();
    applyTheme('dark' as ResolvedTheme);
    expect(root.classList.toggle).toHaveBeenCalledWith('dark', true);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('removes the .dark class and sets data-theme for light mode', () => {
    const { root } = mockDocument();
    applyTheme('light' as ResolvedTheme);
    expect(root.classList.toggle).toHaveBeenCalledWith('dark', false);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});
