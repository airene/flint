import type {
  AgentAvailability,
  AgentDriver,
  AgentRole,
  CliExecutableSetting,
  Provider,
  ProviderDescriptor,
} from "@local-pair-review/shared";

export interface ProviderRegistryEntry {
  id: Provider;
  label: string;
  executableSetting: CliExecutableSetting;
  roles: AgentRole[];
  driver: AgentDriver;
}

export interface ProviderRegistry {
  get(provider: Provider): ProviderRegistryEntry;
  descriptors(availability: Record<Provider, AgentAvailability>): ProviderDescriptor[];
}

const definitions: Omit<ProviderRegistryEntry, "driver">[] = [
  { id: "codex", label: "Codex", executableSetting: "codexExecutable", roles: ["developer", "reviewer"] },
  { id: "claude", label: "Claude Code", executableSetting: "claudeExecutable", roles: ["developer", "reviewer"] },
];

export function createProviderRegistry(drivers: Record<Provider, AgentDriver>): ProviderRegistry {
  const entries = definitions.map((definition) => ({ ...definition, driver: drivers[definition.id] }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return {
    get(provider) {
      const entry = byId.get(provider);
      if (!entry) throw new Error(`No provider registry entry exists for ${provider}`);
      return entry;
    },
    descriptors(availability) {
      return entries.map(({ driver: _driver, ...entry }) => ({
        ...entry,
        roles: [...entry.roles],
        availability: availability[entry.id],
      }));
    },
  };
}
