import { isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import type { CliRecheckRequest } from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import { appSettings } from "../db/schema";

export interface CliExecutableSettings {
  codexExecutable: string;
  claudeExecutable: string;
  gitExecutable: string;
}

const settingKeys = {
  codexExecutable: "cli.codex.executable",
  claudeExecutable: "cli.claude.executable",
  gitExecutable: "cli.git.executable",
} as const;

type SettingName = keyof typeof settingKeys;

function validateOverride(value: string | null | undefined): void {
  if (typeof value === "string" && !isAbsolute(value)) {
    throw new SyntaxError("Custom executable paths must be absolute.");
  }
}

export class AppSettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly defaults: CliExecutableSettings,
  ) {}

  loadCliExecutables(): CliExecutableSettings {
    const stored = new Map(this.database.db.select().from(appSettings).all().map((row) => [row.key, row.value]));
    const result = { ...this.defaults };
    for (const name of Object.keys(settingKeys) as SettingName[]) {
      const value = stored.get(settingKeys[name]);
      if (value === undefined) continue;
      validateOverride(value);
      result[name] = value;
    }
    return result;
  }

  updateCliExecutables(input: CliRecheckRequest): CliExecutableSettings {
    for (const value of Object.values(input)) validateOverride(value);
    const timestamp = new Date().toISOString();
    this.database.db.transaction((transaction) => {
      for (const name of Object.keys(settingKeys) as SettingName[]) {
        const value = input[name];
        if (value === undefined) continue;
        const key = settingKeys[name];
        if (value === null) {
          transaction.delete(appSettings).where(eq(appSettings.key, key)).run();
        } else {
          transaction.insert(appSettings).values({ key, value, updatedAt: timestamp }).onConflictDoUpdate({
            target: appSettings.key,
            set: { value, updatedAt: timestamp },
          }).run();
        }
      }
    }, { behavior: "immediate" });
    return this.loadCliExecutables();
  }
}
