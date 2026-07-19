<script setup lang="ts">
export type ComposerAttachmentStatus = "uploading" | "ready" | "failed";

export interface ComposerAttachment {
  localId: string;
  name: string;
  previewUrl: string;
  status: ComposerAttachmentStatus;
  progress: number;
  attachmentId?: string;
  error?: string;
  file?: File;
}

defineProps<{
  attachments: ComposerAttachment[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  remove: [localId: string];
  retry: [localId: string];
}>();
</script>

<template>
  <ul v-if="attachments.length" class="attachment-strip" aria-label="Attached images">
    <li v-for="attachment in attachments" :key="attachment.localId" class="attachment-card">
      <img :src="attachment.previewUrl" :alt="attachment.name" class="attachment-preview">
      <div class="attachment-meta">
        <span class="attachment-name">{{ attachment.name }}</span>
        <span v-if="attachment.status === 'uploading'" class="attachment-status">Uploading {{ attachment.progress }}%</span>
        <span v-else-if="attachment.status === 'failed'" class="attachment-status attachment-error">{{ attachment.error ?? 'Upload failed.' }}</span>
        <span v-else class="attachment-status">Ready</span>
      </div>
      <button v-if="attachment.status === 'failed'" type="button" class="attachment-action" :disabled="disabled" @click="emit('retry', attachment.localId)">Retry</button>
      <button type="button" class="attachment-action" :disabled="disabled" :aria-label="`Remove ${attachment.name}`" @click="emit('remove', attachment.localId)">Remove</button>
    </li>
  </ul>
</template>

<style scoped>
.attachment-strip{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;padding:0;list-style:none}.attachment-card{display:grid;grid-template-columns:52px minmax(0,1fr);gap:5px;align-items:center;width:210px;padding:6px;border:1px solid var(--border-soft);border-radius:7px;background:var(--panel-raised)}.attachment-preview{grid-row:span 3;width:52px;height:52px;border-radius:4px;object-fit:cover;background:var(--surface-active)}.attachment-meta{display:grid;gap:2px;min-width:0}.attachment-name,.attachment-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.attachment-name{color:var(--text-body)}.attachment-status{color:var(--faint)}.attachment-error{color:var(--danger, #e88989)}.attachment-action{justify-self:start;padding:0;border:0;color:var(--accent);background:transparent;cursor:pointer;font:inherit;font-size:10px}.attachment-action:disabled{cursor:not-allowed;opacity:.6}
</style>
