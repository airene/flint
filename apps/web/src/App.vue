<script setup lang="ts">
import { computed, onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useProjectsStore } from "./stores/projects";
import { useSystemStore } from "./stores/system";

const route = useRoute();
const projects = useProjectsStore();
const system = useSystemStore();
const currentProjectId = computed(() => String(route.params.projectId ?? ""));
const hasCliIssue = computed(() => Boolean(system.cliStatus && (!system.codexReady || !system.claudeReady || !system.gitReady)));

onMounted(() => {
  void projects.loadProjects().catch(() => undefined);
  void system.loadCliStatus().catch(() => undefined);
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

      <div class="sidebar-footer">
        <span class="local-pulse" />
        <span>127.0.0.1 · local only</span>
      </div>
    </aside>

    <main class="main-surface">
      <RouterView />
    </main>
  </div>
</template>
