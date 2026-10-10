import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'resell-theme';
const ThemeContext = createContext({
  theme: 'light',
  isDark: false,
  toggleTheme: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const applyTheme = useCallback((newTheme, enableTransition = false) => {
    const root = document.documentElement;
    const isDark = newTheme === 'dark';

    if (enableTransition) {
      root.classList.add('theme-transition');
      window.clearTimeout(window.__themeTransitionTimeout);
      window.__themeTransitionTimeout = window.setTimeout(() => {
        root.classList.remove('theme-transition');
      }, 350);
    }

    if (isDark) {
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.setAttribute('data-theme', 'light');
      root.style.colorScheme = 'light';
    }

    const meta = document.getElementById('theme-color-meta');
    if (meta) {
      meta.setAttribute('content', isDark ? '#0b0f1a' : '#4f4af0');
    }
  }, []);

  const setTheme = useCallback((nextTheme) => {
    const resolved = typeof nextTheme === 'function' ? nextTheme(theme) : nextTheme;
    setThemeState(resolved);
    localStorage.setItem(STORAGE_KEY, resolved);
    applyTheme(resolved, true);
  }, [theme, applyTheme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, [setTheme]);

  // Initial apply without transitions; persist the resolved theme so the
  // preference survives reloads even before the user toggles manually.
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== theme) {
      localStorage.setItem(STORAGE_KEY, theme);
    }
    applyTheme(theme, false);
  }, [theme, applyTheme]);

  // Listen to OS preference changes if no manual preference is locked in
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        const sysTheme = e.matches ? 'dark' : 'light';
        setThemeState(sysTheme);
        applyTheme(sysTheme, true);
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [applyTheme]);

  const value = useMemo(
    () => ({
      theme,
      isDark: theme === 'dark',
      toggleTheme,
      setTheme,
    }),
    [theme, toggleTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
export default ThemeContext;
