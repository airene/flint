<script setup lang="ts">
import { computed, onMounted, reactive, watch } from "vue";
import type { AgentAvailability, CliRecheckRequest } from "@local-pair-review/shared";
import ErrorBanner from "../components/ErrorBanner.vue";
import { useSystemStore } from "../stores/system";

const store = useSystemStore();
const paths = reactive({ codexExecutable: "", claudeExecutable: "", gitExecutable: "" });
const initialPaths = reactive({ codexExecutable: "", claudeExecutable: "", gitExecutable: "" });
const hydrated = computed(() => Boolean(store.cliStatus) && !store.loading);
const entries = computed<Array<{ key: keyof typeof paths; name: string; description: string; login: string | null; value: AgentAvailability | undefined }>>(() => [
  { key: "codexExecutable", name: "Codex CLI", description: "Workspace-write developer agent using your subscription login.", login: "codex login", value: store.cliStatus?.codex },
  { key: "claudeExecutable", name: "Claude Code", description: "Read-only reviewer using plan permission mode.", login: "claude auth login", value: store.cliStatus?.claude },
  { key: "gitExecutable", name: "Git", description: "Repository status, snapshots and diff evidence.", login: null, value: store.cliStatus?.git },
]);

function customPath(value: string | null | undefined): string {
  return value?.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value ?? "") ? value! : "";
}

watch(() => store.cliStatus, (status) => {
  if (!status) return;
  paths.codexExecutable = customPath(status.codex.executablePath);
  paths.claudeExecutable = customPath(status.claude.executablePath);
  paths.gitExecutable = customPath(status.git.executablePath);
  Object.assign(initialPaths, paths);
}, { immediate: true });

async function saveAndRecheck(): Promise<void> {
  if (!hydrated.value || store.rechecking) return;
  const input: CliRecheckRequest = {};
  for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
    const value = paths[key].trim();
    if (value !== initialPaths[key]) input[key] = value || null;
  }
  await store.recheckClis(input);
}

onMounted(() => { if (!store.cliStatus) void store.loadCliStatus().catch(() => undefined); });
</script>

<template>
  <div class="page compact">
    <header class="page-header"><div><div class="eyebrow">Local runtime</div><h1>CLI Settings</h1><p class="subtitle">Flint uses existing CLI subscription sessions. API keys are removed from every child process environment.</p></div><button class="button primary" :disabled="!hydrated || store.rechecking" @click="saveAndRecheck">{{ store.loading ? 'Loading…' : store.rechecking ? 'Saving & checking…' : 'Save & recheck' }}</button></header>
    <ErrorBanner :message="store.error?.message ?? null" @dismiss="store.clearError" />
    <div class="stack">
      <section v-for="entry in entries" :key="entry.name" class="panel cli-card">
        <div class="cli-icon">{{ entry.name.slice(0, 1) }}</div>
        <div class="cli-main"><h2>{{ entry.name }}</h2><p>{{ entry.description }}</p><label><span>Custom absolute path</span><input v-model="paths[entry.key]" class="input path-input" :disabled="!hydrated || store.rechecking" :placeholder="entry.value?.executablePath ?? 'Use PATH lookup'" spellcheck="false"></label><small v-if="entry.value?.message" class="cli-message">{{ entry.value.message }}</small><small v-if="entry.value?.authentication === 'unauthenticated' && entry.login" class="login-help">Complete subscription login in a terminal: <code>{{ entry.login }}</code></small></div>
        <div class="cli-status"><span :class="['badge', entry.value?.installed && entry.value.authentication !== 'unauthenticated' ? 'completed' : 'failed']">{{ !entry.value?.installed ? 'missing' : entry.value.authentication }}</span><small>{{ entry.value?.version ?? 'Version unavailable' }}</small></div>
      </section>
    </div>
    <section class="security-note panel"><div class="panel-body"><h2>Executable overrides</h2><p>Overrides must be absolute paths and are stored in the local <code>app_settings</code> table. Clear a field to return to the server default. Credentials and CLI config contents are never stored by Flint.</p></div></section>
  </div>
</template>

<style scoped>
.cli-card{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:start;gap:14px;padding:15px}.cli-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:10px;color:#ffb48d;background:var(--accent-soft);font-weight:800}.cli-card h2{margin:0 0 4px;font-size:13px}.cli-card p{margin:0 0 9px;color:var(--muted);font-size:11px}.cli-main label{display:grid;gap:5px}.cli-main label span{color:var(--faint);font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.path-input{font-family:"SFMono-Regular",Consolas,monospace;font-size:10px}.cli-message,.login-help{display:block;margin-top:7px;color:#d6a1a6;font-size:9px;line-height:1.5}.login-help{color:#d7bc7a}.cli-card code{color:#d5a17f;font-size:9px}.cli-status{display:grid;justify-items:end;gap:6px}.cli-status small{color:var(--faint);font-size:9px}.security-note{margin-top:16px}.security-note h2{margin-bottom:7px}.security-note p{margin:0;color:var(--muted);font-size:11px;line-height:1.6}.security-note code{color:#d5a17f}
</style>
