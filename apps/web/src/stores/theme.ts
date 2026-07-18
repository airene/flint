import { defineStore } from "pinia";

export type ThemeName = "dark" | "light";

const STORAGE_KEY = "flint.theme";

function readStoredTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage may be unavailable (private mode, SSR); fall through to default.
  }
  return "dark";
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

export const useThemeStore = defineStore("theme", {
  state: () => ({
    theme: readStoredTheme(),
  }),
  actions: {
    /** Apply the persisted theme to the document. Call once on app start. */
    init(): void {
      applyTheme(this.theme);
    },
    setTheme(theme: ThemeName): void {
      this.theme = theme;
      applyTheme(theme);
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
    },
    toggle(): void {
      this.setTheme(this.theme === "dark" ? "light" : "dark");
    },
  },
});
