<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { GitFileDiffResponse, GitFileStatus, ReviewFinding } from "@local-pair-review/shared";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/min/vs/editor/editor.main.css";

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } }).MonacoEnvironment ??= {
  getWorker: () => new EditorWorker(),
};

const props = defineProps<{
  files: GitFileStatus[];
  selectedPath: string | null;
  diff: GitFileDiffResponse | null;
  findings: ReviewFinding[];
  loading?: boolean;
}>();
const emit = defineEmits<{ select: [path: string]; refresh: [] }>();
const editorHost = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let decorations: monaco.editor.IEditorDecorationsCollection | null = null;

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
  const currentFindings = props.findings.filter((finding) => finding.file === props.selectedPath && finding.startLine);
  decorations = editor.getModifiedEditor().createDecorationsCollection(currentFindings.map((finding) => ({
    range: new monaco.Range(finding.startLine!, 1, finding.endLine ?? finding.startLine!, 1),
    options: { isWholeLine: true, className: `finding-line finding-${finding.severity.toLowerCase()}`, hoverMessage: { value: `**${finding.severity} · ${finding.title}**\n\n${finding.description}` } },
  })));
}

async function mountEditor(): Promise<void> {
  await nextTick();
  if (!editorHost.value || editor) return;
  editor = monaco.editor.createDiffEditor(editorHost.value, {
    theme: "vs-dark", automaticLayout: true, readOnly: true, renderSideBySide: true,
    minimap: { enabled: false }, fontSize: 11, lineHeight: 19, scrollBeyondLastLine: false,
    originalEditable: false, renderOverviewRuler: false, padding: { top: 10 },
  });
  renderDiff();
}

onMounted(mountEditor);
watch(() => [props.diff, props.findings], renderDiff, { deep: true });
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
    <div class="diff-layout">
      <aside class="file-list scroll-area">
        <button v-for="file in files" :key="file.path" :class="['file-row', { active: file.path === selectedPath }]" @click="emit('select', file.path)">
          <span :class="['file-status', file.status]">{{ file.status.slice(0, 1).toUpperCase() }}</span>
          <span class="truncate">{{ file.path }}</span>
          <span v-if="file.binary" class="binary-tag">BIN</span>
        </button>
        <div v-if="!files.length" class="empty-state"><span>No working tree changes.</span></div>
      </aside>
      <div class="editor-wrap">
        <div v-if="diff?.file.binary" class="empty-state editor-empty"><strong>Binary file</strong><span>Content preview is unavailable; the file remains part of the snapshot.</span></div>
        <div v-else-if="!selectedPath" class="empty-state editor-empty"><strong>Select a file</strong><span>Original and working-tree content will appear side by side.</span></div>
        <div ref="editorHost" :class="['monaco-host', { hidden: diff?.file.binary || !selectedPath }]" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.diff-panel{overflow:hidden;display:flex;flex-direction:column;height:100%;min-height:520px}.diff-layout{flex:1;min-height:0;display:grid;grid-template-columns:220px minmax(0,1fr)}.file-list{border-right:1px solid var(--border);background:#10141a}.file-row{width:100%;min-height:34px;display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:7px;padding:0 9px;border:0;border-bottom:1px solid #1e232c;color:#9fa9b8;background:transparent;text-align:left;cursor:pointer;font-size:10px}.file-row:hover,.file-row.active{color:var(--text);background:#1a2029}.file-row.active{box-shadow:inset 2px 0 var(--accent)}.file-status{font-size:9px;font-weight:800;color:var(--yellow)}.file-status.added,.file-status.untracked{color:var(--green)}.file-status.deleted{color:var(--red)}.binary-tag{color:var(--faint);font-size:7px}.editor-wrap{position:relative;min-width:0;background:#0e1116}.monaco-host{position:absolute;inset:0}.monaco-host.hidden{visibility:hidden}.editor-empty{position:absolute;inset:0;display:grid;place-content:center;z-index:2}.editor-empty span{display:block;margin-top:5px}.diff-panel :deep(.finding-line){background:rgba(243,201,105,.1)}.diff-panel :deep(.finding-p0){background:rgba(255,107,117,.15)}.diff-panel :deep(.finding-p2){background:rgba(112,167,255,.08)}
</style>
