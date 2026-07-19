<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
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
  id?: string;
  modelValue: string;
  projectId: string;
  uploadImage: UploadImage;
  multiline?: boolean;
  disabled?: boolean;
  submitting?: boolean;
  imagesEnabled?: boolean;
  imageDisabledReason?: string;
  submitLabel?: string;
  placeholder?: string;
  ariaLabel?: string;
  rows?: number;
}>(), {
  multiline: true,
  disabled: false,
  submitting: false,
  imagesEnabled: true,
  imageDisabledReason: undefined,
  submitLabel: undefined,
  placeholder: undefined,
  ariaLabel: undefined,
  rows: 3,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [payload: ComposerSubmission];
}>();
const { t } = useI18n();

const attachments = ref<ComposerAttachment[]>([]);
const submissionLocked = ref(false);
let nextLocalId = 0;

const readyAttachmentIds = computed(() => attachments.value
  .filter((attachment) => attachment.status === "ready" && attachment.attachmentId)
  .map((attachment) => attachment.attachmentId!));
const hasBlockedAttachment = computed(() => attachments.value.some((attachment) => attachment.status !== "ready"));
const interactionDisabled = computed(() => props.disabled || props.submitting || submissionLocked.value);
const submitDisabled = computed(() => (
  props.disabled || props.submitting || submissionLocked.value || hasBlockedAttachment.value
));

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
    attachment.error = error instanceof Error ? error.message : t("attachments.uploadFailed");
  }
}

function addImages(files: File[]): void {
  if (!props.imagesEnabled || interactionDisabled.value) return;
  const slots = Math.max(0, 4 - attachments.value.length);
  for (const file of files.slice(0, slots)) {
    if (!file.type.startsWith("image/")) continue;
    const attachment: ComposerAttachment = {
      localId: `local-${nextLocalId++}`,
      name: file.name || t("attachments.pastedImage"),
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
  if (!attachment?.file || interactionDisabled.value || !props.imagesEnabled) return;
  void upload(attachment, attachment.file);
}

function submit(): void {
  if (submitDisabled.value) return;
  submissionLocked.value = true;
  emit("submit", { text: props.modelValue, attachmentIds: readyAttachmentIds.value });
  queueMicrotask(() => {
    // Consumers without a persistent submitting prop still receive a same-tick
    // duplicate-click fence. TaskView holds the lock for the full request.
    if (!props.submitting) submissionLocked.value = false;
  });
}

watch(() => props.projectId, () => {
  for (const attachment of attachments.value) revokePreview(attachment);
  attachments.value = [];
});
watch(() => props.submitting, (submitting, wasSubmitting) => {
  if (wasSubmitting && !submitting) submissionLocked.value = false;
});
onBeforeUnmount(() => { for (const attachment of attachments.value) revokePreview(attachment); });
</script>

<template>
  <section class="task-composer">
    <FileMentionInput
      :id="id" :model-value="modelValue" :project-id="projectId" :multiline="multiline" :rows="rows"
      :disabled="interactionDisabled" :placeholder="placeholder" :aria-label="ariaLabel" @update:model-value="emit('update:modelValue', $event)"
      @paste="onPaste" @submit="submit"
    />
    <AttachmentStrip :attachments="attachments" :disabled="interactionDisabled" @remove="remove" @retry="retry" />
    <div class="composer-actions">
      <div class="composer-attachment-status">
        <span v-if="!imagesEnabled" class="attachment-capability" role="status">{{ imageDisabledReason ?? t("attachments.unsupported") }}</span>
        <span class="attachment-count">{{ t("attachments.count", { count: attachments.length }) }}</span>
      </div>
      <button type="button" class="button-primary" :disabled="submitDisabled" @click="submit">{{ submitting ? t("common.sending") : submitLabel ?? t("common.send") }}</button>
    </div>
  </section>
</template>

<style scoped>
.task-composer{display:grid;gap:7px}.composer-actions,.composer-attachment-status{display:flex;align-items:center;gap:8px}.composer-actions{justify-content:space-between}.composer-attachment-status{min-width:0;color:var(--faint);font-size:10px}.attachment-capability{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachment-count{flex:none;white-space:nowrap}
</style>
