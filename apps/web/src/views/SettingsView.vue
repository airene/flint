<script setup lang="ts">
import { computed, onMounted, reactive, watch } from "vue";
import type { AgentAvailability, AgentRole, CliRecheckRequest, Provider } from "@local-pair-review/shared";
import ErrorBanner from "../components/ErrorBanner.vue";
import NotificationSettings from "../components/NotificationSettings.vue";
import { browserNotificationController, browserNotificationSettings } from "../realtime/browser-notification-runtime";
import { useSystemStore } from "../stores/system";

const store = useSystemStore();
const paths = reactive<Record<Provider | "git", string>>({ codex: "", claude: "", git: "" });
const initialPaths = reactive<Record<Provider | "git", string>>({ codex: "", claude: "", git: "" });
const roles = reactive<{ developerProvider: Provider; reviewerProvider: Provider }>({
  developerProvider: "codex",
  reviewerProvider: "claude",
});
const initialRoles = reactive({ ...roles });
const hydrated = computed(() => Boolean(store.cliStatus) && !store.loading);

const sourceLabels = {
  environment: "environment",
  user_config: "user config",
  project_config: "project config",
  managed_config: "managed config",
  system_config: "system config",
  session_override: "session override",
  cli_default: "CLI default",
} as const;

function sourceLabel(value: AgentAvailability | undefined): string {
  return value?.modelSource ? sourceLabels[value.modelSource] : "source unavailable";
}

function customPath(value: string | null | undefined): string {
  return value?.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value ?? "") ? value! : "";
}

function ready(value: AgentAvailability | undefined): boolean {
  return Boolean(value?.installed && value.authentication !== "unauthenticated");
}

function roleOptions(role: AgentRole) {
  return store.providersForRole(role);
}

function optionLabel(provider: ReturnType<typeof roleOptions>[number]): string {
  if (!provider.availability.installed) return `${provider.label} (unavailable)`;
  if (provider.availability.authentication === "unauthenticated") return `${provider.label} (login required)`;
  return provider.label;
}

function roleDescription(roleList: AgentRole[]): string {
  return `Available for ${roleList.join(" and ")} tasks.`;
}

watch(() => store.cliStatus, (status) => {
  if (!status) return;
  for (const provider of status.providers) paths[provider.id] = customPath(provider.availability.executablePath);
  paths.git = customPath(status.git.executablePath);
  roles.developerProvider = status.roles.developerProvider;
  roles.reviewerProvider = status.roles.reviewerProvider;
  Object.assign(initialPaths, paths);
  Object.assign(initialRoles, roles);
}, { immediate: true });

async function saveAndRecheck(): Promise<void> {
  if (!hydrated.value || store.rechecking) return;
  const input: CliRecheckRequest = {};
  for (const provider of store.providers) {
    const value = paths[provider.id].trim();
    if (value !== initialPaths[provider.id]) input[provider.executableSetting] = value || null;
  }
  const gitExecutable = paths.git.trim();
  if (gitExecutable !== initialPaths.git) input.gitExecutable = gitExecutable || null;
  if (roles.developerProvider !== initialRoles.developerProvider) input.developerProvider = roles.developerProvider;
  if (roles.reviewerProvider !== initialRoles.reviewerProvider) input.reviewerProvider = roles.reviewerProvider;
  await store.recheckClis(input);
}

onMounted(() => { if (!store.cliStatus) void store.loadCliStatus().catch(() => undefined); });
</script>

<template>
  <div class="page compact">
    <header class="page-header"><div><div class="eyebrow">Local runtime</div><h1>CLI Settings</h1><p class="subtitle">Flint uses existing CLI subscription sessions. API keys are removed from every child process environment.</p></div><button class="button primary" :disabled="!hydrated || store.rechecking" @click="saveAndRecheck">{{ store.loading ? 'Loading…' : store.rechecking ? 'Saving & checking…' : 'Save & recheck' }}</button></header>
    <ErrorBanner :message="store.error?.message ?? null" @dismiss="store.clearError" />
    <NotificationSettings :controller="browserNotificationController" :settings="browserNotificationSettings" />
    <section class="panel role-settings">
      <div class="role-settings-copy"><h2>Task roles</h2><p>Defaults apply only when a new task is created. Existing tasks keep their provider and exact session.</p></div>
      <label for="developer-provider"><span>Developer CLI</span><select id="developer-provider" v-model="roles.developerProvider" class="input" :disabled="!hydrated || store.rechecking"><option v-for="provider in roleOptions('developer')" :key="provider.id" :value="provider.id" :disabled="!ready(provider.availability)">{{ optionLabel(provider) }}</option></select></label>
      <label for="reviewer-provider"><span>Reviewer CLI</span><select id="reviewer-provider" v-model="roles.reviewerProvider" class="input" :disabled="!hydrated || store.rechecking"><option v-for="provider in roleOptions('reviewer')" :key="provider.id" :value="provider.id" :disabled="!ready(provider.availability)">{{ optionLabel(provider) }}</option></select></label>
    </section>
    <div class="stack">
      <section v-for="entry in store.providers" :key="entry.id" class="panel cli-card">
        <div class="cli-icon">{{ entry.label.slice(0, 1) }}</div>
        <div class="cli-main"><h2>{{ entry.label }}</h2><p>{{ roleDescription(entry.roles) }}</p><div class="runtime-metadata"><div><span>Model</span><code>{{ entry.availability.model ?? 'Unavailable' }}</code><small>{{ sourceLabel(entry.availability) }}</small></div><div v-if="entry.availability.reasoningEffort"><span>Reasoning effort</span><code>{{ entry.availability.reasoningEffort }}</code></div></div><label><span>Custom absolute path</span><input v-model="paths[entry.id]" class="input path-input" :disabled="!hydrated || store.rechecking" :placeholder="entry.availability.executablePath ?? 'Use PATH lookup'" spellcheck="false"></label><small v-if="entry.availability.message" class="cli-message">{{ entry.availability.message }}</small><small v-if="entry.availability.authentication === 'unauthenticated'" class="login-help">Complete {{ entry.label }} subscription login in a terminal.</small></div>
        <div class="cli-status"><span :class="['badge', ready(entry.availability) ? 'completed' : 'failed']">{{ !entry.availability.installed ? 'missing' : entry.availability.authentication }}</span><small>{{ entry.availability.version ?? 'Version unavailable' }}</small></div>
      </section>
      <section class="panel cli-card">
        <div class="cli-icon">G</div>
        <div class="cli-main"><h2>Git</h2><p>Repository status, snapshots and diff evidence.</p><label><span>Custom absolute path</span><input v-model="paths.git" class="input path-input" :disabled="!hydrated || store.rechecking" :placeholder="store.cliStatus?.git.executablePath ?? 'Use PATH lookup'" spellcheck="false"></label><small v-if="store.cliStatus?.git.message" class="cli-message">{{ store.cliStatus.git.message }}</small></div>
        <div class="cli-status"><span :class="['badge', store.gitReady ? 'completed' : 'failed']">{{ store.cliStatus?.git.installed ? 'ok' : 'missing' }}</span><small>{{ store.cliStatus?.git.version ?? 'Version unavailable' }}</small></div>
      </section>
    </div>
    <section class="security-note panel"><div class="panel-body"><h2>Executable overrides</h2><p>Overrides must be absolute paths and are stored in the local <code>app_settings</code> table. Clear a field to return to the server default. Credentials and CLI config contents are never stored by Flint.</p></div></section>
  </div>
</template>

<style scoped>
.role-settings{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,.55fr) minmax(180px,.55fr);align-items:end;gap:16px;margin-bottom:16px;padding:15px}.role-settings h2{margin:0 0 5px;font-size:13px}.role-settings p{margin:0;color:var(--muted);font-size:10px;line-height:1.5}.role-settings label{display:grid;gap:6px}.role-settings label span{color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.role-settings select{min-width:0}
.cli-card{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:start;gap:14px;padding:15px}.cli-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:10px;color:var(--accent-ink);background:var(--accent-soft);font-weight:800}.cli-card h2{margin:0 0 4px;font-size:13px}.cli-card p{margin:0 0 9px;color:var(--muted);font-size:11px}.cli-main label{display:grid;gap:5px}.cli-main label span{color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.path-input{font-family:"SFMono-Regular",Consolas,monospace;font-size:10px}.cli-message,.login-help{display:block;margin-top:7px;color:var(--red-ink);font-size:9px;line-height:1.5}.login-help{color:var(--yellow-ink)}.cli-card code{color:var(--accent-ink);font-size:9px}.cli-status{display:grid;justify-items:end;gap:6px}.cli-status small{color:var(--faint);font-size:9px}.security-note{margin-top:16px}.security-note h2{margin-bottom:7px}.security-note p{margin:0;color:var(--muted);font-size:11px;line-height:1.6}.security-note code{color:var(--accent-ink)}
.runtime-metadata{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--raised-tint)}.runtime-metadata>div{display:flex;align-items:baseline;gap:7px}.runtime-metadata span{color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.runtime-metadata code{font-size:10px}.runtime-metadata small{color:var(--faint);font-size:8px}
@media(max-width:800px){.role-settings{grid-template-columns:1fr}}
</style>
