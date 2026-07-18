<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import ErrorBanner from "../components/ErrorBanner.vue";
import { useProjectsStore } from "../stores/projects";

const store = useProjectsStore();
const router = useRouter();
const rootPath = ref("");

async function addProject(): Promise<void> {
  if (!rootPath.value.trim()) return;
  try {
    const project = await store.createProject({ rootPath: rootPath.value.trim() });
    rootPath.value = "";
    await router.push(`/projects/${project.id}`);
  } catch { /* store exposes the actionable error */ }
}
</script>

<template>
  <div class="page compact">
    <header class="page-header">
      <div><div class="eyebrow">Workspace</div><h1>Repositories</h1><p class="subtitle">Register local Git repositories. Flint never moves, deletes, commits, or pushes your files.</p></div>
    </header>
    <ErrorBanner :message="store.error?.message ?? null" @dismiss="store.clearError" />
    <section class="panel add-project">
      <div class="panel-body add-row">
        <div class="field grow"><label for="root-path">Git repository path</label><input id="root-path" v-model="rootPath" class="input mono" placeholder="/absolute/path/to/repository" @keyup.enter="addProject"></div>
        <button class="button primary" :disabled="store.loading || !rootPath.trim()" @click="addProject">Register repository</button>
      </div>
    </section>

    <div v-if="store.projects.length" class="project-grid">
      <RouterLink v-for="project in store.projects" :key="project.id" :to="`/projects/${project.id}`" class="project-card panel">
        <div class="project-letter">{{ project.name.slice(0, 1).toUpperCase() }}</div>
        <div class="project-copy"><h2>{{ project.name }}</h2><p class="mono truncate">{{ project.rootPath }}</p><span>{{ project.lastOpenedAt ? `Opened ${new Date(project.lastOpenedAt).toLocaleDateString()}` : 'Not opened yet' }}</span></div>
        <span class="card-arrow">→</span>
      </RouterLink>
    </div>
    <section v-else class="panel empty-state repositories-empty"><strong>No repositories registered</strong><span>Add an absolute path to a local Git repository to begin.</span></section>
  </div>
</template>

<style scoped>
.add-project{margin-bottom:18px}.add-row{display:flex;align-items:flex-end;gap:11px}.grow{flex:1}.project-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.project-card{display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:13px;padding:15px;transition:.16s ease}.project-card:hover{border-color:var(--border-bright);background:var(--panel-raised);transform:translateY(-1px)}.project-letter{width:42px;height:42px;display:grid;place-items:center;border-radius:9px;color:var(--accent-ink);background:var(--accent-soft);font-weight:800}.project-copy h2{margin:0 0 4px;font-size:13px}.project-copy p{margin:0;color:var(--muted);font-size:9px}.project-copy span{display:block;margin-top:6px;color:var(--faint);font-size:9px}.card-arrow{color:var(--faint)}.repositories-empty{margin-top:10px}
</style>
