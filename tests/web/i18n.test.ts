import { describe, expect, test } from "bun:test";

function messageKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => messageKeys(child, prefix ? `${prefix}.${key}` : key));
}

function messageAt(messages: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((value, segment) => (
    value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined
  ), messages);
}

function placeholders(value: unknown): string[] {
  return typeof value === "string"
    ? [...value.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!).sort()
    : [];
}

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class ThrowingStorage {
  getItem(): string | null { throw new Error("storage blocked"); }
  setItem(): void { throw new Error("storage blocked"); }
}

async function setup(stored?: string) {
  const modulePath = new URL("../../apps/web/src/i18n/locale.ts", import.meta.url);
  expect(await Bun.file(modulePath).exists()).toBe(true);
  const { LocaleController } = await import("../../apps/web/src/i18n/locale");
  const storage = new MemoryStorage();
  if (stored !== undefined) storage.values.set("flint.locale", stored);
  const target = { value: "zh-CN" };
  const document = { documentElement: { lang: "" } };
  const controller = new LocaleController(target, storage, document);
  return { controller, document, storage, target };
}

describe("LocaleController", () => {
  test("defaults invalid or missing storage to English", async () => {
    for (const stored of [undefined, "", "fr"]) {
      const { controller, document, target } = await setup(stored);
      expect(controller.init()).toBe("en");
      expect(target.value).toBe("en");
      expect(document.documentElement.lang).toBe("en");
    }
  });

  test("restores, switches and persists a supported locale", async () => {
    const { controller, document, storage, target } = await setup("zh-CN");
    expect(controller.init()).toBe("zh-CN");
    expect(controller.targetIcon()).toBe("A");

    controller.toggle();
    expect(target.value).toBe("en");
    expect(storage.getItem("flint.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(controller.targetIcon()).toBe("文");
  });

  test("continues when browser storage is unavailable", async () => {
    const { LocaleController } = await import("../../apps/web/src/i18n/locale");
    const target = { value: "zh-CN" };
    const document = { documentElement: { lang: "" } };
    const controller = new LocaleController(target, new ThrowingStorage(), document);

    expect(controller.init()).toBe("en");
    expect(controller.setLocale("zh-CN")).toBe("zh-CN");
    expect(target.value).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

describe("locale messages", () => {
  test("English and Simplified Chinese expose the same message keys", async () => {
    const [{ en }, { zhCN }] = await Promise.all([
      import("../../apps/web/src/i18n/locales/en"),
      import("../../apps/web/src/i18n/locales/zh-CN"),
    ]);

    expect(messageKeys(zhCN).sort()).toEqual(messageKeys(en).sort());
    expect(messageKeys(en).filter((key) => (
      placeholders(messageAt(en, key)).join("\0") !== placeholders(messageAt(zhCN, key)).join("\0")
    ))).toEqual([]);
    expect(en.navigation.projects).toBe("Projects");
    expect(zhCN.navigation.projects).toBe("项目");
  });

  test("every statically referenced UI message exists in English", async () => {
    const { en } = await import("../../apps/web/src/i18n/locales/en");
    const sourceFiles = new Bun.Glob("**/*.{ts,vue}").scan({ cwd: new URL("../../apps/web/src", import.meta.url).pathname });
    const keys = new Set<string>();
    for await (const sourceFile of sourceFiles) {
      if (sourceFile.startsWith("i18n/locales/")) continue;
      const source = await Bun.file(new URL(`../../apps/web/src/${sourceFile}`, import.meta.url)).text();
      for (const match of source.matchAll(/\b(?:t|translate)\(\s*["']([^"']+)["']/gu)) keys.add(match[1]!);
    }

    expect([...keys].filter((key) => messageAt(en, key) === undefined)).toEqual([]);
  });

  test("configures vue-i18n with English default and fallback while interpolating Chinese copy", async () => {
    const [{ i18n }, { zhCN }] = await Promise.all([
      import("../../apps/web/src/i18n"),
      import("../../apps/web/src/i18n/locales/zh-CN"),
    ]);
    expect(i18n.global.fallbackLocale.value).toBe("en");
    i18n.global.locale.value = "zh-CN";
    expect(i18n.global.t("project.createAndStart", { developer: "Codex" })).toBe("创建并启动 Codex");

    const { projects: _missing, ...navigation } = zhCN.navigation;
    i18n.global.setLocaleMessage("zh-CN", { ...zhCN, navigation } as unknown as typeof zhCN);
    try {
      expect(i18n.global.t("navigation.projects")).toBe("Projects");
    } finally {
      i18n.global.setLocaleMessage("zh-CN", zhCN);
      i18n.global.locale.value = "en";
    }
  });

  test("covers every dynamic message-key family in both locales", async () => {
    const [{ en }, { zhCN }] = await Promise.all([
      import("../../apps/web/src/i18n/locales/en"),
      import("../../apps/web/src/i18n/locales/zh-CN"),
    ]);
    const keys = [
      ...["draft", "developing", "fixing", "reviewing", "waiting_for_human", "ready_for_review", "completed", "queued", "running", "failed", "cancelled", "interrupted", "delivering", "delivered"].map((status) => `statuses.${status}`),
      ...["pending", "resolving", "allowed", "denied", "expired", "retry"].map((state) => `approvals.state${state[0]!.toUpperCase()}${state.slice(1)}`),
      ...["default", "denied", "granted"].map((permission) => `notifications.permission${permission[0]!.toUpperCase()}${permission.slice(1)}`),
      ...["unknown", "authenticated", "unauthenticated"].map((authentication) => `settings.${authentication}`),
    ];

    expect(keys.filter((key) => messageAt(en, key) === undefined || messageAt(zhCN, key) === undefined)).toEqual([]);
  });
});
