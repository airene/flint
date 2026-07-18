<script setup lang="ts">
defineProps<{ message: string | null }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div v-if="message" class="error-banner" role="alert">
    <span>{{ message }}</span>
    <button class="button ghost" type="button" aria-label="Dismiss error" @click="$emit('dismiss')">×</button>
  </div>
</template>
