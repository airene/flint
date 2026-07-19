export const APP_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = typeof APP_LOCALES[number];

export const LOCALE_STORAGE_KEY = "flint.locale";

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocaleDocument {
  documentElement: { lang: string };
}

export interface LocaleTarget {
  value: string;
}

function supportedLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "zh-CN";
}

export class LocaleController {
  constructor(
    private readonly target: LocaleTarget,
    private readonly storage: LocaleStorage | null,
    private readonly document: LocaleDocument | null,
  ) {}

  init(): AppLocale {
    let stored: string | null = null;
    try { stored = this.storage?.getItem(LOCALE_STORAGE_KEY) ?? null; } catch { /* fall back to English */ }
    return this.apply(supportedLocale(stored) ? stored : "en", false);
  }

  setLocale(locale: AppLocale): AppLocale {
    return this.apply(locale, true);
  }

  toggle(): AppLocale {
    return this.setLocale(this.locale() === "en" ? "zh-CN" : "en");
  }

  locale(): AppLocale {
    return supportedLocale(this.target.value) ? this.target.value : "en";
  }

  targetIcon(): "A" | "文" {
    return this.locale() === "en" ? "文" : "A";
  }

  private apply(locale: AppLocale, persist: boolean): AppLocale {
    this.target.value = locale;
    if (this.document) this.document.documentElement.lang = locale;
    if (persist) {
      try { this.storage?.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* persistence is best effort */ }
    }
    return locale;
  }
}
