<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import type { GitFileDiffResponse, GitFileStatus, ReviewFinding } from "@local-pair-review/shared";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/min/vs/editor/editor.main.css";
import { useThemeStore } from "../stores/theme";

const { theme } = storeToRefs(useThemeStore());
const monacoTheme = (): string => (theme.value === "light" ? "vs" : "vs-dark");

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } }).MonacoEnvironment ??= {
  getWorker: () => new EditorWorker(),
};

const props = defineProps<{
  files: GitFileStatus[];
  selectedPath: string | null;
  diff: GitFileDiffResponse | null;
  findings: ReviewFinding[];
  loading?: boolean;
  repositoryError?: string | null;
  diffError?: string | null;
}>();
const emit = defineEmits<{ select: [path: string]; refresh: [] }>();
const editorHost = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let decorations: monaco.editor.IEditorDecorationsCollection | null = null;
// Path awaiting a "jump to first difference" once Monaco finishes computing the diff.
let pendingRevealPath: string | null = null;
let lastDiffPath: string | null = null;

function language(path: string | null): string {
  const extension = path?.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", vue: "html", json: "json", css: "css", md: "markdown", py: "python", rs: "rust", go: "go" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

function renderDiff(): void {
  if (!editor) return;
  decorations?.clear();
  decorations = null;
  editor.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
  if (!props.diff || props.diff.file.binary) return;
  originalModel = monaco.editor.createModel(props.diff.originalText ?? "", language(props.selectedPath));
  modifiedModel = monaco.editor.createModel(props.diff.modifiedText ?? "", language(props.selectedPath));
  editor.setModel({ original: originalModel, modified: modifiedModel });
  // Only jump to the first change when the selected file actually changes, so refreshing
  // findings or diff content for the same file preserves the current scroll position.
  if (props.selectedPath !== lastDiffPath) {
    lastDiffPath = props.selectedPath;
    pendingRevealPath = props.selectedPath;
  }
  const currentFindings = props.findings.filter((finding) => finding.file === props.selectedPath && finding.startLine);
  decorations = editor.getModifiedEditor().createDecorationsCollection(currentFindings.map((finding) => ({
    range: new monaco.Range(finding.startLine!, 1, finding.endLine ?? finding.startLine!, 1),
    options: { isWholeLine: true, className: `finding-line finding-${finding.severity.toLowerCase()}`, hoverMessage: { value: `**${finding.severity} · ${finding.title}**\n\n${finding.description}` } },
  })));
}

function revealFirstDiff(): void {
  if (!editor || pendingRevealPath === null || pendingRevealPath !== props.selectedPath) return;
  const changes = editor.getLineChanges();
  const first = changes?.[0];
  if (!first) return; // diff not computed yet, or no line changes; wait for the next update
  pendingRevealPath = null;
  if (first.modifiedEndLineNumber > 0) {
    editor.getModifiedEditor().revealLineNearTop(first.modifiedStartLineNumber);
  } else {
    editor.getOriginalEditor().revealLineNearTop(Math.max(1, first.originalStartLineNumber));
  }
}

async function mountEditor(): Promise<void> {
  await nextTick();
  if (!editorHost.value || editor) return;
  editor = monaco.editor.createDiffEditor(editorHost.value, {
    theme: monacoTheme(), automaticLayout: true, readOnly: true, renderSideBySide: true,
    minimap: { enabled: false }, fontSize: 11, lineHeight: 19, scrollBeyondLastLine: false,
    originalEditable: false, renderOverviewRuler: false, padding: { top: 10 },
  });
  // Monaco computes the diff asynchronously; reveal the first change once it is ready.
  editor.onDidUpdateDiff(revealFirstDiff);
  renderDiff();
}

onMounted(mountEditor);
watch(() => [props.diff, props.findings], renderDiff, { deep: true });
// Monaco is a global editor namespace; setTheme swaps every editor's theme live.
watch(theme, () => monaco.editor.setTheme(monacoTheme()));
onBeforeUnmount(() => {
  decorations?.clear();
  editor?.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  editor?.dispose();
});
</script>

<template>
  <section class="panel diff-panel">
    <header class="panel-header">
      <h2 class="panel-title">Git Diff <span class="badge">{{ files.length }} files</span></h2>
      <button class="button ghost" type="button" :disabled="loading" @click="emit('refresh')">↻ Refresh</button>
    </header>
    <div v-if="repositoryError" class="empty-state repository-unavailable">
      <strong>Repository unavailable</strong>
      <span>Task history remains available. {{ repositoryError }}</span>
    </div>
    <div v-else class="diff-layout">
      <aside class="file-list scroll-area">
        <button v-for="file in files" :key="file.path" :class="['file-row', { active: file.path === selectedPath }]" @click="emit('select', file.path)">
          <span :class="['file-status', file.status]">{{ file.status.slice(0, 1).toUpperCase() }}</span>
          <span class="truncate">{{ file.path }}</span>
          <span v-if="file.binary" class="binary-tag">BIN</span>
        </button>
        <div v-if="!files.length" class="empty-state"><span>No working tree changes.</span></div>
      </aside>
      <div class="editor-wrap">
        <div v-if="diffError" class="empty-state editor-empty"><strong>Diff unavailable</strong><span>{{ diffError }}</span></div>
        <div v-else-if="diff?.file.binary" class="empty-state editor-empty"><strong>Binary file</strong><span>Content preview is unavailable; the file remains part of the snapshot.</span></div>
        <div v-else-if="!selectedPath" class="empty-state editor-empty"><strong>Select a file</strong><span>Original and working-tree content will appear side by side.</span></div>
        <div ref="editorHost" :class="['monaco-host', { hidden: diffError || diff?.file.binary || !selectedPath }]" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.diff-panel{overflow:hidden;display:flex;flex-direction:column;height:100%;min-height:520px}.repository-unavailable{flex:1;display:grid;place-content:center;padding:24px;text-align:center}.repository-unavailable span{display:block;max-width:560px;margin-top:6px}.diff-layout{flex:1;min-height:0;display:grid;grid-template-columns:220px minmax(0,1fr)}.file-list{border-right:1px solid var(--border);background:var(--block-bg)}.file-row{width:100%;min-height:34px;display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:7px;padding:0 9px;border:0;border-bottom:1px solid var(--border-soft);color:var(--muted);background:transparent;text-align:left;cursor:pointer;font-size:10px}.file-row:hover,.file-row.active{color:var(--text);background:var(--surface-active)}.file-row.active{box-shadow:inset 2px 0 var(--accent)}.file-status{font-size:9px;font-weight:800;color:var(--yellow)}.file-status.added,.file-status.untracked{color:var(--green)}.file-status.deleted{color:var(--red)}.binary-tag{color:var(--faint);font-size:7px}.editor-wrap{position:relative;min-width:0;background:var(--code-bg)}.monaco-host{position:absolute;inset:0}.monaco-host.hidden{visibility:hidden}.editor-empty{position:absolute;inset:0;display:grid;place-content:center;z-index:2}.editor-empty span{display:block;margin-top:5px}.diff-panel :deep(.finding-line){background:rgba(243,201,105,.1)}.diff-panel :deep(.finding-p0){background:rgba(255,107,117,.15)}.diff-panel :deep(.finding-p2){background:rgba(112,167,255,.08)}
</style>
