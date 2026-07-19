<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { apiEndpoints } from "../api/endpoints";
import { activeFileMention, replaceFileMention, type ActiveFileMention } from "./file-mention";

const props = withDefaults(defineProps<{
  modelValue: string;
  projectId: string;
  multiline?: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}>(), {
  multiline: false,
  id: undefined,
  ariaLabel: undefined,
  placeholder: undefined,
  disabled: false,
  rows: 3,
});
const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [];
  paste: [event: ClipboardEvent];
}>();
const { t } = useI18n();

const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const open = ref(false);
const loading = ref(false);
const failed = ref(false);
const files = ref<string[]>([]);
const selectedIndex = ref(0);
const listboxId = `file-mentions-${useId().replaceAll(":", "")}`;
let mention: ActiveFileMention | null = null;
let composing = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;
let requestGeneration = 0;
let blurTimer: ReturnType<typeof setTimeout> | null = null;

function stopRequest(): void {
  requestGeneration += 1;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  abortController?.abort();
  abortController = null;
}

function closeMenu(): void {
  stopRequest();
  open.value = false;
  loading.value = false;
  failed.value = false;
  files.value = [];
  selectedIndex.value = 0;
  mention = null;
}

function search(query: string): void {
  stopRequest();
  const generation = requestGeneration;
  loading.value = true;
  failed.value = false;
  files.value = [];
  selectedIndex.value = 0;
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const controller = new AbortController();
    abortController = controller;
    try {
      const result = await apiEndpoints.listProjectFiles(props.projectId, { q: query, limit: 50 }, controller.signal);
      if (generation !== requestGeneration || controller.signal.aborted) return;
      files.value = result.files;
      selectedIndex.value = 0;
      loading.value = false;
    } catch {
      if (generation !== requestGeneration || controller.signal.aborted) return;
      loading.value = false;
      failed.value = true;
      files.value = [];
    } finally {
      if (abortController === controller) abortController = null;
    }
  }, 150);
}

function refreshMention(value = props.modelValue, caret = control.value?.selectionStart ?? value.length): void {
  const next = activeFileMention(value, caret);
  if (!next) {
    closeMenu();
    return;
  }
  mention = next;
  open.value = true;
  search(next.query);
}

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  emit("update:modelValue", target.value);
  if (!composing) refreshMention(target.value, target.selectionStart ?? target.value.length);
}

function onPaste(event: ClipboardEvent): void {
  emit("paste", event);
}

function selectFile(path: string): void {
  const caret = control.value?.selectionStart ?? props.modelValue.length;
  const current = activeFileMention(props.modelValue, caret) ?? mention;
  if (!current) return;
  const replacement = replaceFileMention(props.modelValue, current, path);
  emit("update:modelValue", replacement.value);
  closeMenu();
  void nextTick(() => {
    control.value?.focus();
    control.value?.setSelectionRange(replacement.caret, replacement.caret);
  });
}

function exactKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function onKeydown(event: KeyboardEvent): void {
  if (composing || event.isComposing) return;
  if (open.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (files.value.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex.value = (selectedIndex.value + 1) % files.value.length;
      return;
    }
    if (files.value.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex.value = (selectedIndex.value - 1 + files.value.length) % files.value.length;
      return;
    }
    if (exactKey(event) && event.key === "Enter") {
      event.preventDefault();
      if (files.value.length > 0) selectFile(files.value[selectedIndex.value]!);
      return;
    }
    if (files.value.length > 0 && exactKey(event) && event.key === "Tab") {
      event.preventDefault();
      selectFile(files.value[selectedIndex.value]!);
      return;
    }
  }
  if (!props.multiline && event.key === "Enter" && exactKey(event)) {
    event.preventDefault();
    emit("submit");
  }
}

function onCaretKeyup(event: KeyboardEvent): void {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) refreshMention();
}

function onBlur(): void {
  blurTimer = setTimeout(closeMenu, 0);
}

function onCompositionEnd(): void {
  composing = false;
  refreshMention();
}

function onCompositionStart(): void {
  composing = true;
}

watch(() => props.projectId, closeMenu);
watch(() => props.modelValue, (value) => { if (!value.includes("@")) closeMenu(); });
onBeforeUnmount(() => {
  if (blurTimer) clearTimeout(blurTimer);
  closeMenu();
});
</script>

<template>
  <div class="file-mention-input" :class="{ multiline }">
    <textarea
      v-if="multiline"
      :id="id" ref="control" class="textarea file-mention-control" :value="modelValue"
      :rows="rows" :disabled="disabled" :placeholder="placeholder" :aria-label="ariaLabel"
      aria-autocomplete="list" :aria-expanded="open" :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="open && files.length ? `${listboxId}-${selectedIndex}` : undefined"
      @input="onInput" @paste="onPaste" @keydown="onKeydown" @keyup="onCaretKeyup" @click="refreshMention()" @blur="onBlur"
      @compositionstart="onCompositionStart" @compositionend="onCompositionEnd"
    />
    <input
      v-else
      :id="id" ref="control" type="text" class="input file-mention-control" :value="modelValue"
      :disabled="disabled" :placeholder="placeholder" :aria-label="ariaLabel"
      aria-autocomplete="list" :aria-expanded="open" :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="open && files.length ? `${listboxId}-${selectedIndex}` : undefined"
      @input="onInput" @paste="onPaste" @keydown="onKeydown" @keyup="onCaretKeyup" @click="refreshMention()" @blur="onBlur"
      @compositionstart="onCompositionStart" @compositionend="onCompositionEnd"
    >
    <div v-if="open" :id="listboxId" class="file-mention-menu" role="listbox" :aria-label="t('composer.repositoryFiles')">
      <div v-if="loading" class="file-mention-status" role="status">{{ t("composer.loadingFiles") }}</div>
      <div v-else-if="failed" class="file-mention-status" role="status">{{ t("composer.filesUnavailable") }}</div>
      <div v-else-if="files.length === 0" class="file-mention-status" role="status">{{ t("composer.noFiles") }}</div>
      <button
        v-for="(path, index) in files" v-else :id="`${listboxId}-${index}`" :key="path"
        type="button" role="option" class="file-mention-option" :class="{ selected: index === selectedIndex }"
        :aria-selected="index === selectedIndex" tabindex="-1" @mousedown.prevent @click="selectFile(path)"
      >{{ path }}</button>
    </div>
  </div>
</template>

<style scoped>
.file-mention-input{position:relative;width:100%;min-width:0}.file-mention-control{width:100%}.file-mention-input.multiline .file-mention-control{min-height:0}.file-mention-menu{position:absolute;z-index:80;top:calc(100% + 5px);left:0;width:100%;max-height:240px;overflow:auto;border:1px solid var(--border-bright);border-radius:7px;background:var(--panel-raised);box-shadow:0 14px 35px rgba(0,0,0,.28)}.file-mention-option{display:block;width:100%;min-height:32px;padding:7px 10px;border:0;border-bottom:1px solid var(--border-soft);color:var(--text-body);background:transparent;cursor:pointer;font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:10px;text-align:left}.file-mention-option:last-child{border-bottom:0}.file-mention-option:hover,.file-mention-option.selected{color:var(--text);background:var(--surface-active)}.file-mention-status{padding:10px;color:var(--faint);font-size:10px}
</style>
