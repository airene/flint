import type { AgentAvailability, CliRecheckRequest, CliStatusResponse } from "@local-pair-review/shared";
import { defineStore } from "pinia";
import { ApiClientError } from "../api/client";
import { apiEndpoints } from "../api/endpoints";

function available(cli: AgentAvailability | undefined): boolean {
  return Boolean(cli?.installed && cli.authentication !== "unauthenticated");
}

function clientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError
    ? error
    : new ApiClientError(0, "INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected client error.");
}

export const useSystemStore = defineStore("system", {
  state: () => ({
    cliStatus: null as CliStatusResponse | null,
    loading: false,
    rechecking: false,
    error: null as ApiClientError | null,
  }),
  getters: {
    codexReady: (state): boolean => available(state.cliStatus?.codex),
    claudeReady: (state): boolean => available(state.cliStatus?.claude),
    gitReady: (state): boolean => available(state.cliStatus?.git),
  },
  actions: {
    clearError(): void {
      this.error = null;
    },
    async loadCliStatus(): Promise<CliStatusResponse> {
      this.loading = true;
      this.error = null;
      try {
        this.cliStatus = await apiEndpoints.getCliStatus();
        return this.cliStatus;
      } catch (error) {
        this.error = clientError(error);
        throw this.error;
      } finally {
        this.loading = false;
      }
    },
    async recheckClis(input: CliRecheckRequest = {}): Promise<CliStatusResponse> {
      this.rechecking = true;
      this.error = null;
      try {
        this.cliStatus = await apiEndpoints.recheckClis(input);
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
