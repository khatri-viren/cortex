import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

type Theme = "light" | "dark";

function readTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("theme", theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = (event: MediaQueryListEvent) => {
      if (localStorage.getItem("theme")) return;
      applyTheme(event.matches ? "dark" : "light");
      setThemeState(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onSystemChange);
    return () => media.removeEventListener("change", onSystemChange);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";

    if (!document.startViewTransition) {
      applyTheme(next);
      setThemeState(next);
      return;
    }

    document.startViewTransition(() => {
      flushSync(() => {
        applyTheme(next);
        setThemeState(next);
      });
    });
  }, []);

  return { theme, toggleTheme };
}
