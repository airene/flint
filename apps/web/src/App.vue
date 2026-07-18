<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useProjectsStore } from "./stores/projects";
import { useSystemStore } from "./stores/system";
import { useTaskWorkspaceStore } from "./stores/task-workspace";
import { useThemeStore } from "./stores/theme";

const route = useRoute();
const projects = useProjectsStore();
const system = useSystemStore();
const workspace = useTaskWorkspaceStore();
const theme = useThemeStore();
const currentProjectId = computed(() => String(route.params.projectId ?? ""));
const currentTaskId = computed(() => String(route.params.taskId ?? ""));
const hasCliIssue = computed(() => Boolean(system.cliStatus && (!system.allProvidersReady || !system.gitReady)));

onMounted(() => {
  void projects.loadProjects()
    .then(() => projects.loadUnfinishedTasks())
    .catch(() => undefined);
  void system.loadCliStatus().catch(() => undefined);
});

// Keep the unfinished-task shortcuts fresh as the user navigates (task statuses change mid-session).
watch(() => route.fullPath, () => {
  void projects.loadUnfinishedTasks().catch(() => undefined);
});

// Mirror the currently-open task's live status (arrives via WebSocket) into the sidebar list,
// so a task that starts/continues development shows up without waiting for a navigation refetch.
watch(() => workspace.task, (task) => {
  if (task) projects.syncTask(task);
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
        <div class="section-label"><span>Unfinished tasks</span><span class="section-count">{{ projects.unfinishedTasks.length }}</span></div>
        <div v-if="projects.unfinishedLoading && !projects.unfinishedTasks.length" class="sidebar-empty">Loading…</div>
        <div v-else-if="!projects.unfinishedTasks.length" class="sidebar-empty">All caught up</div>
        <RouterLink
          v-for="task in projects.unfinishedTasks"
          :key="task.id"
          :to="`/tasks/${task.id}`"
          class="repo-link task-link"
          :class="{ active: currentTaskId === task.id }"
          :title="task.title"
        >
          <span :class="['task-dot', task.status]" />
          <span class="truncate">{{ task.title }}</span>
        </RouterLink>
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
