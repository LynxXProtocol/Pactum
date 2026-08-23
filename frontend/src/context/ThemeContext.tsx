/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'pactum-theme';
const THEME_VARIABLES: Record<ResolvedTheme, string> = {
  light:
    '--bg:#f5f5f7;--bg-card:rgba(255,255,255,.6);--bg-input:rgba(255,255,255,.8);--text-primary:#1d1d1f;--text-secondary:#86868b;--separator:rgba(0,0,0,.05);',
  dark:
    '--bg:#101114;--bg-card:rgba(30,31,36,.78);--bg-input:rgba(38,39,45,.9);--text-primary:#f5f5f7;--text-secondary:#a1a1aa;--separator:rgba(255,255,255,.1);',
};

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  let style = document.getElementById('pactum-theme-variables');
  if (!style) {
    style = document.createElement('style');
    style.id = 'pactum-theme-variables';
    document.head.appendChild(style);
  }
  style.textContent = `:root{${THEME_VARIABLES[theme]}}`;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(preference));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const next = resolveTheme(preference);
      setResolvedTheme(next);
      applyTheme(next);
    };

    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setPreferenceState(next);
    const resolved = resolveTheme(next);
    requestAnimationFrame(() => {
      setResolvedTheme(resolved);
      applyTheme(resolved);
    });
  };

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}

export function ThemeSelector() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  return (
    <label className="theme-selector">
      <span className="sr-only">{t("app.language.label")}</span>
      <select value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)}>
        <option value="system">{t("common.system")}</option>
        <option value="light">{t("common.light")}</option>
        <option value="dark">{t("common.dark")}</option>
      </select>
    </label>
  );
}
