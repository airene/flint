<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { HealthResponse } from "@local-pair-review/shared";

const health = ref<"checking" | "healthy" | "unavailable">("checking");

onMounted(async () => {
  try {
    const response = await fetch("/api/health");
    const body = await response.json() as HealthResponse;
    health.value = response.ok && body.status === "ok" ? "healthy" : "unavailable";
  } catch {
    health.value = "unavailable";
  }
});
</script>

<template>
  <main>
    <h1>Local Pair Review</h1>
    <p aria-live="polite">Server health: {{ health }}</p>
  </main>
</template>
