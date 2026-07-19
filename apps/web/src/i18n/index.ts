import { createI18n } from "vue-i18n";
import { LocaleController } from "./locale";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: {
    en,
    "zh-CN": zhCN,
  },
});

function browserStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export const localeController = new LocaleController(
  i18n.global.locale,
  browserStorage(),
  typeof document === "undefined" ? null : document,
);

export function translate(key: string, named?: Record<string, unknown>): string {
  return named ? i18n.global.t(key, named) : i18n.global.t(key);
}
