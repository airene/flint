<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AttachmentStrip, { type ComposerAttachment } from "./AttachmentStrip.vue";
import FileMentionInput from "./FileMentionInput.vue";

export interface UploadedAttachment {
  id: string;
}

export interface AttachmentUploadInput {
  projectId: string;
  file: File;
  onProgress: (percent: number) => void;
}

export type UploadImage = (input: AttachmentUploadInput) => Promise<UploadedAttachment>;

export interface ComposerSubmission {
  text: string;
  attachmentIds: string[];
}

const props = withDefaults(defineProps<{
  modelValue: string;
  projectId: string;
  uploadImage: UploadImage;
  multiline?: boolean;
  disabled?: boolean;
  imagesEnabled?: boolean;
  imageDisabledReason?: string;
  placeholder?: string;
  ariaLabel?: string;
  rows?: number;
}>(), {
  multiline: true,
  disabled: false,
  imagesEnabled: true,
  imageDisabledReason: "This provider does not support image attachments for this action.",
  placeholder: undefined,
  ariaLabel: undefined,
  rows: 3,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [payload: ComposerSubmission];
}>();

const attachments = ref<ComposerAttachment[]>([]);
let nextLocalId = 0;

const readyAttachmentIds = computed(() => attachments.value
  .filter((attachment) => attachment.status === "ready" && attachment.attachmentId)
  .map((attachment) => attachment.attachmentId!));

function revokePreview(attachment: ComposerAttachment): void {
  if (attachment.previewUrl.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
}

function remove(localId: string): void {
  const attachment = attachments.value.find((candidate) => candidate.localId === localId);
  if (attachment) revokePreview(attachment);
  attachments.value = attachments.value.filter((candidate) => candidate.localId !== localId);
}

async function upload(attachment: ComposerAttachment, file: File): Promise<void> {
  attachment.status = "uploading";
  attachment.error = undefined;
  attachment.progress = 0;
  try {
    const result = await props.uploadImage({
      projectId: props.projectId,
      file,
      onProgress: (percent) => { attachment.progress = Math.max(0, Math.min(100, Math.round(percent))); },
    });
    attachment.status = "ready";
    attachment.attachmentId = result.id;
    attachment.progress = 100;
  } catch (error) {
    attachment.status = "failed";
    attachment.error = error instanceof Error ? error.message : "Image upload failed.";
  }
}

function addImages(files: File[]): void {
  if (!props.imagesEnabled || props.disabled) return;
  const slots = Math.max(0, 4 - attachments.value.length);
  for (const file of files.slice(0, slots)) {
    if (!file.type.startsWith("image/")) continue;
    const attachment: ComposerAttachment = {
      localId: `local-${nextLocalId++}`,
      name: file.name || "Pasted image",
      previewUrl: URL.createObjectURL(file),
      status: "uploading",
      progress: 0,
      file,
    };
    attachments.value.push(attachment);
    void upload(attachment, file);
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  // Do not prevent the native paste: pasted text must continue into the editor.
  addImages(files);
}

function retry(localId: string): void {
  const attachment = attachments.value.find((candidate) => candidate.localId === localId);
  if (!attachment?.file || props.disabled || !props.imagesEnabled) return;
  void upload(attachment, attachment.file);
}

function submit(): void {
  if (props.disabled || attachments.value.some((attachment) => attachment.status === "uploading")) return;
  emit("submit", { text: props.modelValue, attachmentIds: readyAttachmentIds.value });
}

watch(() => props.projectId, () => {
  for (const attachment of attachments.value) revokePreview(attachment);
  attachments.value = [];
});
onBeforeUnmount(() => { for (const attachment of attachments.value) revokePreview(attachment); });
</script>

<template>
  <section class="task-composer">
    <FileMentionInput
      :model-value="modelValue" :project-id="projectId" :multiline="multiline" :rows="rows"
      :disabled="disabled" :placeholder="placeholder" :aria-label="ariaLabel" @update:model-value="emit('update:modelValue', $event)"
      @paste="onPaste" @submit="submit"
    />
    <p v-if="!imagesEnabled" class="attachment-capability" role="status">{{ imageDisabledReason }}</p>
    <AttachmentStrip :attachments="attachments" :disabled="disabled" @remove="remove" @retry="retry" />
    <div class="composer-actions">
      <span class="attachment-count">{{ attachments.length }}/4 images</span>
      <button type="button" class="button-primary" :disabled="disabled || attachments.some((attachment) => attachment.status === 'uploading')" @click="submit">Send</button>
    </div>
  </section>
</template>

<style scoped>
.task-composer{display:grid;gap:7px}.attachment-capability{margin:0;color:var(--faint);font-size:10px}.composer-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.attachment-count{color:var(--faint);font-size:10px}
</style>
