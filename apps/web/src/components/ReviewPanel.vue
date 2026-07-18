<script setup lang="ts">
import { computed } from "vue";
import { reviewResultSchema, type AgentRun, type FindingSelectionMode, type ReviewFinding } from "@local-pair-review/shared";
import { displayFindingsForRun } from "./review-display";

const props = defineProps<{ run: AgentRun | null; findings: ReviewFinding[]; reviewerLabel: string; busy?: boolean; readOnly?: boolean; stale?: boolean }>();
const emit = defineEmits<{
  updateFinding: [id: string, changes: { selected?: boolean; dismissed?: boolean; userNote?: string | null }];
  selectMode: [mode: FindingSelectionMode];
  jumpToFinding: [finding: ReviewFinding];
}>();
const displayFindings = computed(() => displayFindingsForRun(props.run, props.findings));
const counts = computed(() => ({
  P0: displayFindings.value.filter((item) => item.severity === "P0").length,
  P1: displayFindings.value.filter((item) => item.severity === "P1").length,
  P2: displayFindings.value.filter((item) => item.severity === "P2").length,
}));
const result = computed(() => {
  const parsed = reviewResultSchema.safeParse(props.run?.structuredOutput);
  return parsed.success ? parsed.data : null;
});
</script>

<template>
  <section class="panel review-panel">
    <header class="panel-header">
      <h2 class="panel-title">{{ reviewerLabel }} Review</h2>
      <span v-if="run" :class="['badge', run.reviewParseStatus === 'failed' ? 'failed' : run.status === 'completed' ? 'completed' : 'reviewing']">
        {{ run.reviewParseStatus === 'failed' ? 'parse failed' : run.status }}
      </span>
    </header>
    <template v-if="run">
      <div class="review-toolbar">
        <div class="severity-counts"><span class="badge p0">P0 {{ counts.P0 }}</span><span class="badge p1">P1 {{ counts.P1 }}</span><span class="badge p2">P2 {{ counts.P2 }}</span></div>
        <div v-if="!readOnly" class="button-row">
          <button class="text-action" @click="emit('selectMode', 'P0')">P0</button>
          <button class="text-action" @click="emit('selectMode', 'P0_P1')">P0+P1</button>
          <button class="text-action" @click="emit('selectMode', 'all')">All</button>
          <button class="text-action" @click="emit('selectMode', 'none')">None</button>
        </div>
      </div>
      <div v-if="result" class="review-result">
        <span :class="['badge', result.verdict === 'pass' ? 'completed' : 'waiting']">{{ result.verdict.replaceAll('_', ' ') }}</span>
        <p>{{ result.summary }}</p>
      </div>
      <div v-if="stale" class="stale-review"><strong>Snapshot changed during review.</strong> Findings are preserved, but confirm the current diff before sending feedback.</div>
      <div v-if="run.reviewParseStatus === 'failed'" class="parse-warning">Structured output could not be parsed. The raw reviewer response remains available in the {{ reviewerLabel }} panel.</div>
      <div v-if="displayFindings.length" class="finding-list">
        <article v-for="finding in displayFindings" :key="finding.id" :class="['finding', { dismissed: finding.dismissed }]">
          <div class="finding-top">
            <label class="finding-check"><input type="checkbox" :checked="finding.selected" :disabled="readOnly || finding.dismissed || busy" @change="emit('updateFinding', finding.id, { selected: ($event.target as HTMLInputElement).checked })"><span :class="['badge', finding.severity.toLowerCase()]">{{ finding.severity }}</span></label>
            <button class="location mono" @click="emit('jumpToFinding', finding)">{{ finding.file ?? "general" }}<template v-if="finding.startLine">:{{ finding.startLine }}</template></button>
          </div>
          <h3>{{ finding.title }}</h3>
          <p>{{ finding.description }}</p>
          <div class="suggestion"><strong>Suggested</strong>{{ finding.suggestion }}</div>
          <input class="note-input" :value="finding.userNote ?? ''" :disabled="readOnly" placeholder="Add a human note…" @change="emit('updateFinding', finding.id, { userNote: ($event.target as HTMLInputElement).value || null })">
          <button v-if="!readOnly" class="dismiss-action" @click="emit('updateFinding', finding.id, { dismissed: !finding.dismissed, selected: false })">{{ finding.dismissed ? "Restore" : "Dismiss" }}</button>
        </article>
      </div>
      <div v-else-if="run.status === 'completed' && run.reviewParseStatus !== 'failed'" class="empty-state"><strong>No findings</strong><span>{{ reviewerLabel }} did not report actionable issues.</span></div>
      <div v-else class="empty-state"><strong>Review in progress</strong><span>Findings will appear after structured output is parsed.</span></div>
    </template>
    <div v-else class="empty-state"><strong>No review yet</strong><span>Start a read-only {{ reviewerLabel }} review when development is ready.</span></div>
  </section>
</template>

<style scoped>
.review-toolbar { min-height:44px; display:flex; align-items:center; justify-content:space-between; padding:0 14px; border-bottom:1px solid var(--border); }
.review-result{display:flex;align-items:flex-start;gap:9px;padding:11px 14px;border-bottom:1px solid var(--border);background:#10141a}.review-result p{margin:0;color:#c3cad5;font-size:11px;line-height:1.5}.stale-review{padding:10px 14px;color:#e9cf8b;background:rgba(243,201,105,.07);border-bottom:1px solid rgba(243,201,105,.2);font-size:10px}.stale-review strong{margin-right:4px}
.severity-counts,.button-row{display:flex;gap:6px}.text-action{border:0;background:none;color:var(--muted);cursor:pointer;font-size:9px;padding:4px}.text-action:hover{color:var(--text)}
.parse-warning{padding:10px 14px;color:#ffc1c5;background:rgba(255,107,117,.07);border-bottom:1px solid rgba(255,107,117,.2);font-size:11px}.finding-list{max-height:540px;overflow:auto}.finding{position:relative;padding:14px;border-bottom:1px solid var(--border)}.finding:last-child{border:0}.finding.dismissed{opacity:.45}.finding-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.finding-check{display:flex;align-items:center;gap:8px}.location{border:0;background:none;color:var(--blue);font-size:9px;cursor:pointer}.finding h3{margin:10px 0 6px;font-size:12px}.finding p,.suggestion{color:#aeb7c5;font-size:11px;line-height:1.55}.suggestion{padding:8px 9px;border-left:2px solid #4e596a;background:#11151b}.suggestion strong{display:block;color:var(--faint);font-size:8px;text-transform:uppercase;margin-bottom:3px}.note-input{width:calc(100% - 55px);margin-top:9px;border:1px solid var(--border);border-radius:5px;color:#cbd2dd;background:#0f1218;padding:7px 8px;font-size:10px}.dismiss-action{position:absolute;right:14px;bottom:18px;border:0;background:none;color:var(--faint);font-size:9px;cursor:pointer}
</style>
