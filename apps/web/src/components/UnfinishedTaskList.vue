<script setup lang="ts">
import type { UnfinishedTaskSummary } from "@local-pair-review/shared";
import { useI18n } from "vue-i18n";
import { unfinishedTaskStatusKey, unfinishedTaskStatusLabel } from "../stores/unfinished-tasks";

const props = defineProps<{
  tasks: readonly UnfinishedTaskSummary[];
  currentTaskId?: string | null;
}>();

const emit = defineEmits<{ select: [task: UnfinishedTaskSummary] }>();
const { t } = useI18n();

function statusLabel(task: UnfinishedTaskSummary): string {
  const key = unfinishedTaskStatusKey(task);
  return key ? t(key) : unfinishedTaskStatusLabel(task);
}

function select(task: UnfinishedTaskSummary): void {
  emit("select", task);
}
</script>

<template>
  <ul class="unfinished-task-list" :aria-label="t('navigation.unfinishedTasks')">
    <li v-for="task in props.tasks" :key="task.id">
      <button
        type="button"
        :class="['unfinished-task', { current: task.id === props.currentTaskId }]"
        :aria-current="task.id === props.currentTaskId ? 'page' : undefined"
        @click="select(task)"
      >
        <span class="state-indicator" :class="task.attention" aria-hidden="true" />
        <span class="task-content">
          <span class="repository">{{ task.projectName }}</span>
          <span class="title">{{ task.title }}</span>
          <span class="status sr-only">{{ t("accessibility.status", { status: statusLabel(task) }) }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.unfinished-task-list{margin:0;padding:0;list-style:none}.unfinished-task{display:grid;grid-template-columns:8px minmax(0,1fr);gap:10px;width:100%;padding:9px 10px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer}.unfinished-task:hover,.unfinished-task.current{background:var(--panel-raised,rgba(255,255,255,.06))}.state-indicator{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--faint,#777)}.state-indicator.pending_approval,.state-indicator.needs_attention{background:var(--red,#ff6b75)}.state-indicator.running{background:var(--blue,#75a7ff)}.state-indicator.waiting_for_human{background:var(--yellow,#f3c969)}.state-indicator.ready_for_review{background:var(--green,#75d6a0)}.task-content,.repository,.title{display:block;min-width:0}.repository{color:var(--muted,#999);font-size:10px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style>
