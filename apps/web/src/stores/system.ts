import type {
  AgentAvailability,
  AgentRole,
  CliRecheckRequest,
  Provider,
  ProviderDescriptor,
  SettingsResponse,
} from "@local-pair-review/shared";
import { defineStore } from "pinia";
import { ApiClientError } from "../api/client";
import { apiEndpoints } from "../api/endpoints";
import { translate } from "../i18n";

function available(cli: AgentAvailability | undefined): boolean {
  return Boolean(cli?.installed && cli.authentication !== "unauthenticated");
}

function provider(settings: SettingsResponse | null, id: Provider | undefined): ProviderDescriptor | undefined {
  return id ? settings?.providers.find((candidate) => candidate.id === id) : undefined;
}

function clientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError
    ? error
    : new ApiClientError(0, "INTERNAL_ERROR", error instanceof Error ? error.message : translate("errors.unexpectedClient"));
}

export const useSystemStore = defineStore("system", {
  state: () => ({
    cliStatus: null as SettingsResponse | null,
    loading: false,
    rechecking: false,
    error: null as ApiClientError | null,
  }),
  getters: {
    providers: (state): ProviderDescriptor[] => state.cliStatus?.providers ?? [],
    providerById: (state) => (id: Provider | undefined): ProviderDescriptor | undefined => provider(state.cliStatus, id),
    providerReady: (state) => (id: Provider | undefined): boolean => available(provider(state.cliStatus, id)?.availability),
    providerLabel: (state) => (id: Provider | undefined): string => provider(state.cliStatus, id)?.label ?? id ?? "Agent",
    providersForRole: (state) => (role: AgentRole): ProviderDescriptor[] => (
      state.cliStatus?.providers.filter((candidate) => candidate.roles.includes(role)) ?? []
    ),
    allProvidersReady: (state): boolean => Boolean(
      state.cliStatus?.providers.every((candidate) => available(candidate.availability)),
    ),
    gitReady: (state): boolean => available(state.cliStatus?.git),
  },
  actions: {
    clearError(): void {
      this.error = null;
    },
    async loadCliStatus(): Promise<SettingsResponse> {
      this.loading = true;
      this.error = null;
      try {
        this.cliStatus = await apiEndpoints.getSettings();
        return this.cliStatus;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.loading = false;
      }
    },
    async recheckClis(input: CliRecheckRequest = {}): Promise<SettingsResponse> {
      this.rechecking = true;
      this.error = null;
      try {
        this.cliStatus = await apiEndpoints.updateSettings(input);
        return this.cliStatus;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.rechecking = false;
      }
    },
  },
});
