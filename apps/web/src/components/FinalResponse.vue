<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { looksLikeMarkdown } from "./final-response";

const props = defineProps<{ content: string }>();
const isMarkdown = computed(() => looksLikeMarkdown(props.content));
const renderedHtml = computed(() => {
  if (!isMarkdown.value) return "";
  const html = marked.parse(props.content, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
});
</script>

<template>
  <div v-if="isMarkdown" class="final-response-markdown" v-html="renderedHtml" />
  <p v-else class="final-response-plain">{{ content }}</p>
</template>

<style scoped>
.final-response-plain,.final-response-markdown{margin:0;color:var(--text-body);font-size:12px;line-height:1.55;overflow-wrap:anywhere;word-break:break-word}.final-response-plain{white-space:pre-wrap}
.final-response-markdown :deep(> :first-child){margin-top:0}.final-response-markdown :deep(> :last-child){margin-bottom:0}.final-response-markdown :deep(h1),.final-response-markdown :deep(h2),.final-response-markdown :deep(h3),.final-response-markdown :deep(h4){margin:14px 0 6px;color:var(--text);line-height:1.3}.final-response-markdown :deep(h1){font-size:17px}.final-response-markdown :deep(h2){font-size:15px}.final-response-markdown :deep(h3),.final-response-markdown :deep(h4){font-size:13px}.final-response-markdown :deep(p),.final-response-markdown :deep(ul),.final-response-markdown :deep(ol),.final-response-markdown :deep(blockquote),.final-response-markdown :deep(pre),.final-response-markdown :deep(table){margin:0 0 10px}.final-response-markdown :deep(ul),.final-response-markdown :deep(ol){padding-left:21px}.final-response-markdown :deep(blockquote){padding-left:10px;border-left:2px solid var(--yellow);color:var(--muted)}.final-response-markdown :deep(code){padding:1px 4px;border-radius:4px;background:var(--surface-active);font-family:"SFMono-Regular",Consolas,monospace;font-size:.9em}.final-response-markdown :deep(pre){overflow:auto;padding:10px;border:1px solid var(--border-soft);border-radius:6px;background:var(--code-bg)}.final-response-markdown :deep(pre code){padding:0;background:transparent}.final-response-markdown :deep(table){width:100%;border-collapse:collapse}.final-response-markdown :deep(th),.final-response-markdown :deep(td){padding:5px 7px;border:1px solid var(--border);text-align:left}.final-response-markdown :deep(a){color:var(--accent-ink)}.final-response-markdown :deep(img){max-width:100%;height:auto}
</style>
