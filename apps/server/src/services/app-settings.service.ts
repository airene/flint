import { isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import {
  agentRoleSettingsSchema,
  type AgentRoleSettings,
  type CliRecheckRequest,
} from "@local-pair-review/shared";
import type { AppDatabase } from "../db/database";
import { appSettings } from "../db/schema";

export interface CliExecutableSettings {
  codexExecutable: string;
  claudeExecutable: string;
  gitExecutable: string;
}

export interface StoredAppSettings {
  cliExecutables: CliExecutableSettings;
  roles: AgentRoleSettings;
}

const settingKeys = {
  codexExecutable: "cli.codex.executable",
  claudeExecutable: "cli.claude.executable",
  gitExecutable: "cli.git.executable",
} as const;

const agentRoleSettingKeys = {
  developerProvider: "agent.defaultDeveloper",
  reviewerProvider: "agent.defaultReviewer",
} as const;

type SettingName = keyof typeof settingKeys;
type AgentRoleSettingName = keyof typeof agentRoleSettingKeys;

export class InvalidAppSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAppSettingError";
  }
}

function validateOverride(value: string | null | undefined): void {
  if (typeof value === "string" && !isAbsolute(value)) {
    throw new InvalidAppSettingError("Custom executable paths must be absolute.");
  }
}

export class AppSettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly defaults: CliExecutableSettings,
  ) {}

  loadCliExecutables(): CliExecutableSettings {
    return this.cliExecutablesFrom(this.storedValues());
  }

  private cliExecutablesFrom(stored: Map<string, string>): CliExecutableSettings {
    const result = { ...this.defaults };
    for (const name of Object.keys(settingKeys) as SettingName[]) {
      const value = stored.get(settingKeys[name]);
      if (value === undefined) continue;
      validateOverride(value);
      result[name] = value;
    }
    return result;
  }

  loadAgentRoles(): AgentRoleSettings {
    return this.rolesFrom(this.storedValues());
  }

  private rolesFrom(stored: Map<string, string>): AgentRoleSettings {
    return agentRoleSettingsSchema.parse({
      developerProvider: stored.get(agentRoleSettingKeys.developerProvider) ?? "codex",
      reviewerProvider: stored.get(agentRoleSettingKeys.reviewerProvider) ?? "claude",
    });
  }

  private storedValues(): Map<string, string> {
    return new Map(this.database.db.select().from(appSettings).all().map((row) => [row.key, row.value]));
  }

  updateSettings(input: CliRecheckRequest): StoredAppSettings {
    for (const name of Object.keys(settingKeys) as SettingName[]) validateOverride(input[name]);
    const rolePatch = agentRoleSettingsSchema.partial().parse({
      ...(input.developerProvider === undefined ? {} : { developerProvider: input.developerProvider }),
      ...(input.reviewerProvider === undefined ? {} : { reviewerProvider: input.reviewerProvider }),
    });
    const timestamp = new Date().toISOString();

    return this.database.db.transaction((transaction) => {
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
      for (const name of Object.keys(agentRoleSettingKeys) as AgentRoleSettingName[]) {
        const value = rolePatch[name];
        if (value === undefined) continue;
        transaction.insert(appSettings).values({
          key: agentRoleSettingKeys[name],
          value,
          updatedAt: timestamp,
        }).onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedAt: timestamp },
        }).run();
      }
      const stored = new Map(transaction.select().from(appSettings).all().map((row) => [row.key, row.value]));
      return {
        cliExecutables: this.cliExecutablesFrom(stored),
        roles: this.rolesFrom(stored),
      };
    }, { behavior: "immediate" });
  }

}
