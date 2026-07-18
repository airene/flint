<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ErrorBanner from "../components/ErrorBanner.vue";
import { useProjectsStore } from "../stores/projects";
import { useSystemStore } from "../stores/system";

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();
const system = useSystemStore();
const title = ref("");
const prompt = ref("");
const developerLabel = computed(() => system.providerLabel(system.cliStatus?.roles.developerProvider));
const reviewerLabel = computed(() => system.providerLabel(system.cliStatus?.roles.reviewerProvider));

async function load(): Promise<void> {
  try { await store.selectProject(String(route.params.projectId)); } catch { /* rendered */ }
}
onMounted(load);
watch(() => route.params.projectId, load);

async function createTask(confirmDirtyWorkingTree = false): Promise<void> {
  if (!title.value.trim() || !prompt.value.trim() || !store.currentProject) return;
  const projectId = store.currentProject.id;
  const selectionGeneration = store.selectionGeneration;
  try {
    const task = confirmDirtyWorkingTree
      ? await store.retryCreateTaskWithDirtyWorkingTreeConfirmation(projectId)
      : await store.createTask(projectId, { title: title.value.trim(), originalPrompt: prompt.value.trim() });
    if (task && store.selectionGeneration === selectionGeneration && store.currentProject?.id === projectId
      && String(route.params.projectId) === projectId) await router.push({ path: `/tasks/${task.id}`, query: { start: "1" } });
  } catch { /* dirty/error state is rendered */ }
}

async function removeProject(): Promise<void> {
  if (!store.currentProject) return;
  const hasTasks = store.tasks.length > 0;
  if (!window.confirm(hasTasks ? "Remove this project and all Flint history? Local repository files will not be touched." : "Remove this project from Flint?")) return;
  try { await store.deleteProject(store.currentProject.id, hasTasks); await router.push("/projects"); } catch { /* rendered */ }
}

function cancelDirtyConfirmation(): void {
  store.pendingDirtyTask = null;
  store.clearError();
}
</script>

<template>
  <div class="page compact">
    <header v-if="store.currentProject" class="page-header">
      <div><div class="eyebrow">Repository</div><h1>{{ store.currentProject.name }}</h1><p class="subtitle mono">{{ store.currentProject.rootPath }}</p></div>
      <button class="button danger" @click="removeProject">Remove</button>
    </header>
    <ErrorBanner :message="store.error?.message ?? null" @dismiss="store.clearError" />

    <section class="panel new-task">
      <header class="panel-header"><h2 class="panel-title">New task</h2><span class="badge">base = current HEAD</span></header>
      <div class="panel-body task-form">
        <div class="field"><label for="task-title">Title</label><input id="task-title" v-model="title" class="input" :disabled="Boolean(store.pendingDirtyTask)" placeholder="Validate checkout input"></div>
        <div class="field"><label for="task-prompt">{{ developerLabel }} prompt</label><textarea id="task-prompt" v-model="prompt" class="textarea" :disabled="Boolean(store.pendingDirtyTask)" placeholder="Describe the change and acceptance criteria…" /></div>
        <div class="create-row"><p class="help">Creating the task immediately starts the {{ developerLabel }} session in this repository. If the working tree is dirty, Flint asks for explicit confirmation first.</p><button class="button primary" :disabled="Boolean(store.pendingDirtyTask) || !title.trim() || !prompt.trim()" @click="createTask(false)">Create & start {{ developerLabel }}</button></div>
      </div>
    </section>

    <section v-if="store.pendingDirtyTask?.projectId === store.currentProject?.id" class="dirty-confirm">
      <div><strong>Working tree has existing changes</strong><p>They will be included in the review snapshot together with Agent changes. Confirming creates the task and immediately starts {{ developerLabel }}.</p><ul><li v-for="file in store.dirtyWorkingTreeFiles" :key="file" class="mono">{{ file }}</li></ul></div>
      <div class="button-row"><button class="button" @click="cancelDirtyConfirmation">Cancel</button><button class="button danger" @click="createTask(true)">Create & start anyway</button></div>
    </section>

    <section class="tasks-section">
      <div class="section-heading"><h2>Tasks</h2><span class="badge">{{ store.tasks.length }}</span></div>
      <div v-if="store.tasks.length" class="task-list panel">
        <RouterLink v-for="task in store.tasks" :key="task.id" :to="`/tasks/${task.id}`" class="task-row">
          <span :class="['task-state', task.status]" /><div><strong>{{ task.title }}</strong><small>{{ task.originalPrompt }}</small></div><span :class="['badge', task.status === 'ready_for_review' || task.status === 'completed' ? 'ready' : task.status === 'waiting_for_human' ? 'waiting' : task.status === 'developing' || task.status === 'fixing' ? 'running' : '']">{{ task.status.replaceAll('_',' ') }}</span><span class="card-arrow">→</span>
        </RouterLink>
      </div>
      <div v-else class="panel empty-state"><strong>No tasks yet</strong><span>Create a focused task to start the {{ developerLabel }} → {{ reviewerLabel }} review loop.</span></div>
    </section>
  </div>
</template>

<style scoped>
.new-task{margin-bottom:14px}.task-form{display:grid;gap:13px}.create-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.create-row p{margin:0}.dirty-confirm{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:18px;padding:13px 15px;border:1px solid rgba(243,201,105,.3);border-radius:8px;background:rgba(243,201,105,.07);font-size:11px}.dirty-confirm strong{color:var(--yellow-ink)}.dirty-confirm p{margin:4px 0;color:var(--muted)}.dirty-confirm ul{display:flex;gap:8px;flex-wrap:wrap;margin:7px 0 0;padding:0;list-style:none}.dirty-confirm li{color:var(--yellow-ink);font-size:9px}.tasks-section{margin-top:24px}.section-heading{display:flex;align-items:center;gap:8px;margin-bottom:9px}.section-heading h2{margin:0}.task-list{overflow:hidden}.task-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto 20px;align-items:center;gap:12px;min-height:60px;padding:9px 14px;border-bottom:1px solid var(--border)}.task-row:last-child{border:0}.task-row:hover{background:var(--panel-raised)}.task-row strong,.task-row small{display:block}.task-row strong{font-size:12px}.task-row small{max-width:570px;margin-top:4px;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-state{width:7px;height:7px;border-radius:50%;background:var(--faint)}.task-state.developing,.task-state.fixing,.task-state.reviewing{background:var(--blue)}.task-state.waiting_for_human{background:var(--yellow)}.task-state.ready_for_review,.task-state.completed{background:var(--green)}.card-arrow{color:var(--faint)}
</style>
