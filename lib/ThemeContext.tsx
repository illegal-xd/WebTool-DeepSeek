import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  THEME_QUERY,
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '../core/theme';

export type { ThemePreference } from '../core/theme';

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
}

function persistTheme(preference: ThemePreference) {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  chrome.runtime.sendMessage({ type: 'SET_THEME', payload: preference }).catch(() => {});
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemePreference] = useState<ThemePreference>(() => getStoredPreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const resolvedTheme = resolveTheme(theme, systemTheme);

  useEffect(() => {
    const media = window.matchMedia(THEME_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    setSystemTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    applyTheme(theme, resolvedTheme);
    persistTheme(theme);
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((nextTheme: ThemePreference) => {
    setThemePreference(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemePreference((current) => {
      const currentResolved = resolveTheme(current, getSystemTheme());
      return currentResolved === 'dark' ? 'light' : 'dark';
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
  }), [theme, resolvedTheme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
