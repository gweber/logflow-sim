import { useEffect, useState } from 'preact/hooks';

export type Theme = 'light' | 'dark';

export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    if (document.documentElement.classList.contains('dark')) return 'dark';
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      localStorage.setItem('theme', theme);
    } catch {}
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    set: setTheme
  };
}
