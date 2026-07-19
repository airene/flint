<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ApprovalDecision, ApprovalRequest } from "@local-pair-review/shared";
import { approvalCardDisplay, type ApprovalCardDecision } from "./approval-card";

const props = defineProps<{ request: ApprovalRequest; error?: string | null }>();
const emit = defineEmits<{ decide: [decision: ApprovalCardDecision] }>();

const resolving = ref(false);
const denyReason = ref("");
const display = computed(() => approvalCardDisplay(props.request, { resolving: resolving.value, error: props.error }));

watch(() => props.error, (error) => {
  if (error) resolving.value = false;
});
watch(() => props.request.status, (status) => {
  if (status !== "pending") resolving.value = false;
});

function decide(decision: ApprovalDecision): void {
  if (!display.value.canDecide) return;
  resolving.value = true;
  emit("decide", {
    decision: display.value.lockedDecision ?? decision,
    reason: display.value.lockedDecision ? requestReason() : decision === "deny" ? denyReason.value.trim() || null : null,
  });
}

function requestReason(): string | null { return props.request.reason; }
</script>

<template>
  <article :class="['approval-card', display.state]" aria-live="polite">
    <header>
      <strong>Approval required</strong>
      <span class="badge">{{ display.state }}</span>
    </header>
    <p class="tool-name">{{ request.toolName }}</p>
    <p class="summary">{{ request.actionSummary }}</p>
    <p class="directory">{{ request.workingDirectory }}</p>
    <p v-if="(display.state === 'denied' || display.state === 'retry') && display.reason" class="deny-reason">Reason: {{ display.reason }}</p>
    <p v-if="display.state === 'expired'">This request expired when its run ended.</p>
    <p v-if="display.error" class="error">{{ display.error }}</p>
    <template v-if="display.canDecide">
      <label v-if="!display.lockedDecision" class="deny-reason-input">Reason (optional)<input v-model="denyReason" :disabled="resolving" placeholder="Why deny this request?"></label>
      <div class="actions">
        <button v-if="display.lockedDecision !== 'deny'" class="button" type="button" :disabled="resolving" @click="decide('allow_once')">{{ display.state === 'retry' ? 'Retry allow once' : 'Allow once' }}</button>
        <button v-if="display.lockedDecision !== 'allow_once'" class="button ghost" type="button" :disabled="resolving" @click="decide('deny')">{{ display.state === 'retry' ? 'Retry deny' : 'Deny' }}</button>
      </div>
    </template>
  </article>
</template>

<style scoped>
.approval-card{padding:12px 14px;border:1px solid var(--border);border-radius:6px;background:var(--block-bg);font-size:11px}.approval-card header,.actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.badge{text-transform:capitalize}.tool-name{margin:10px 0 4px;font-weight:600}.summary,.directory,.deny-reason,.error{margin:4px 0;color:var(--text-body);line-height:1.5}.directory{font-family:var(--mono);font-size:10px}.deny-reason-input{display:grid;gap:4px;margin-top:10px;color:var(--muted);font-size:10px}.deny-reason-input input{padding:7px 8px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text)}.actions{justify-content:flex-start;margin-top:10px}.error{color:var(--red-ink)}.expired{opacity:.7}
</style>
