<script setup lang="ts">
import { useI18n } from "vue-i18n";

defineProps<{ message: string | null }>();
defineEmits<{ dismiss: [] }>();
const { t } = useI18n();
</script>

<template>
  <div v-if="message" class="error-banner" role="alert">
    <span>{{ message }}</span>
    <button class="button ghost" type="button" :aria-label="t('errors.dismiss')" @click="$emit('dismiss')">×</button>
  </div>
</template>
