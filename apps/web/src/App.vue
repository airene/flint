<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import type { UnfinishedTaskSummary } from "@local-pair-review/shared";
import UnfinishedTaskList from "./components/UnfinishedTaskList.vue";
import { apiEndpoints } from "./api/endpoints";
import { applyUnfinishedTaskSocketMessage, replaceUnfinishedTaskSnapshot } from "./realtime/unfinished-task-events";
import { useProjectsStore } from "./stores/projects";
import { useSystemStore } from "./stores/system";
import { useThemeStore } from "./stores/theme";
import { useUnfinishedTasksStore } from "./stores/unfinished-tasks";

const route = useRoute();
const router = useRouter();
const projects = useProjectsStore();
const system = useSystemStore();
const unfinished = useUnfinishedTasksStore();
const theme = useThemeStore();
const currentProjectId = computed(() => String(route.params.projectId ?? ""));
const currentTaskId = computed(() => String(route.params.taskId ?? ""));
const hasCliIssue = computed(() => Boolean(system.cliStatus && (!system.allProvidersReady || !system.gitReady)));
let unfinishedSocket: WebSocket | null = null;
let unfinishedReconnect: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function unfinishedWebSocketUrl(): string {
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${globalThis.location?.host ?? "127.0.0.1:3000"}/ws`;
}

function connectUnfinishedTasks(): void {
  if (stopped) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(unfinishedWebSocketUrl());
  } catch {
    unfinishedReconnect = setTimeout(() => {
      unfinishedReconnect = null;
      connectUnfinishedTasks();
    }, 500);
    return;
  }
  unfinishedSocket = socket;
  let snapshotReady = false;
  const buffered: unknown[] = [];
  socket.onopen = () => socket.send(JSON.stringify({ action: "subscribe_unfinished" }));
  socket.onmessage = (message) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(message.data)); } catch { return; }
    if (parsed && typeof parsed === "object" && (parsed as { action?: unknown }).action === "subscribed_unfinished") {
      unfinished.loading = true;
      void replaceUnfinishedTaskSnapshot(unfinished, () => apiEndpoints.listUnfinishedTasks())
        .then(() => {
          snapshotReady = true;
          for (const event of buffered.splice(0)) applyUnfinishedTaskSocketMessage(unfinished, event);
        })
        .catch(() => socket.close(1011, "Unfinished task snapshot failed"))
        .finally(() => { unfinished.loading = false; });
      return;
    }
    if (!snapshotReady) buffered.push(parsed);
    else applyUnfinishedTaskSocketMessage(unfinished, parsed);
  };
  socket.onerror = () => socket.close(1011, "Unfinished task stream failed");
  socket.onclose = () => {
    if (unfinishedSocket === socket) unfinishedSocket = null;
    if (!stopped && unfinishedReconnect === null) {
      unfinishedReconnect = setTimeout(() => {
        unfinishedReconnect = null;
        connectUnfinishedTasks();
      }, 500);
    }
  };
}

function selectUnfinishedTask(task: UnfinishedTaskSummary): void {
  void router.push(`/tasks/${encodeURIComponent(task.id)}`);
}

onMounted(() => {
  void projects.loadProjects().catch(() => undefined);
  void system.loadCliStatus().catch(() => undefined);
  connectUnfinishedTasks();
});

watch(currentTaskId, (taskId) => unfinished.setCurrentTask(taskId || null), { immediate: true });
onBeforeUnmount(() => {
  stopped = true;
  if (unfinishedReconnect) clearTimeout(unfinishedReconnect);
  unfinishedSocket?.close(1000, "Application closed");
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/projects">
        <span class="brand-mark">F</span>
        <span><strong>Flint</strong><small>Local Pair Review</small></span>
      </RouterLink>

      <nav class="primary-nav" aria-label="Primary navigation">
        <RouterLink to="/projects" class="nav-item">
          <span class="nav-icon">⌘</span> Projects
        </RouterLink>
        <RouterLink to="/settings" class="nav-item">
          <span class="nav-icon">⚙</span> CLI Settings
          <span v-if="hasCliIssue" class="status-dot warning" title="CLI needs attention" />
        </RouterLink>
      </nav>

      <div class="sidebar-section">
        <div class="section-label"><span>Repositories</span><RouterLink to="/projects">＋</RouterLink></div>
        <div v-if="projects.loading && !projects.projects.length" class="sidebar-empty">Loading…</div>
        <RouterLink
          v-for="project in projects.projects"
          :key="project.id"
          :to="`/projects/${project.id}`"
          class="repo-link"
          :class="{ active: currentProjectId === project.id }"
        >
          <span class="repo-glyph">{{ project.name.slice(0, 1).toUpperCase() }}</span>
          <span class="truncate">{{ project.name }}</span>
        </RouterLink>
      </div>

      <div class="sidebar-section">
        <div class="section-label"><span>Unfinished tasks</span><span class="section-count">{{ unfinished.tasks.length }}</span></div>
        <div v-if="unfinished.loading && !unfinished.tasks.length" class="sidebar-empty">Loading…</div>
        <div v-else-if="!unfinished.tasks.length" class="sidebar-empty">All caught up</div>
        <UnfinishedTaskList :tasks="unfinished.tasks" :current-task-id="currentTaskId" @select="selectUnfinishedTask" />
      </div>

      <div class="sidebar-footer">
        <span class="local-pulse" />
        <span>127.0.0.1 · local only</span>
        <button
          type="button"
          class="theme-toggle"
          :title="theme.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
          :aria-label="theme.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="theme.toggle()"
        >
          {{ theme.theme === "dark" ? "☾" : "☀" }}
        </button>
      </div>
    </aside>

    <main class="main-surface">
      <RouterView />
    </main>
  </div>
</template>
