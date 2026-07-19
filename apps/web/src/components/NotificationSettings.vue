<script setup lang="ts">
import { computed, ref } from "vue";
import type { BrowserNotificationController, NotificationPermissionState } from "../realtime/browser-notifications";
import type { NotificationSettings } from "../stores/notification-settings";

const props = defineProps<{
  controller: BrowserNotificationController;
  settings: NotificationSettings;
}>();

const permission = ref<NotificationPermissionState>(props.controller.permission);
const enabled = computed({
  get: () => props.settings.isEnabled(),
  set: (value: boolean) => props.settings.setEnabled(value),
});

async function requestPermission(): Promise<void> {
  permission.value = await props.controller.requestPermissionFromUserAction();
}
</script>

<template>
  <section class="panel notification-settings" aria-label="Browser notifications">
    <div>
      <h2>Browser notifications</h2>
      <p>Alert when a Developer or Reviewer run completes while this task is open in a background tab.</p>
    </div>
    <label class="notification-toggle">
      <input v-model="enabled" type="checkbox">
      <span>Notify for completed runs</span>
    </label>
    <div class="notification-permission">
      <span>Permission: {{ permission }}</span>
      <button v-if="permission === 'default'" type="button" class="button" @click="requestPermission">Enable browser notifications</button>
      <small v-else-if="permission === 'denied'">Notifications are blocked in this browser.</small>
      <small v-else>Browser notifications are allowed.</small>
    </div>
  </section>
</template>

<style scoped>
.notification-settings{display:grid;gap:12px;padding:15px}.notification-settings h2{margin:0 0 5px;font-size:13px}.notification-settings p{margin:0;color:var(--muted);font-size:11px;line-height:1.5}.notification-toggle{display:flex;align-items:center;gap:8px;color:var(--text-body);font-size:11px}.notification-permission{display:flex;flex-wrap:wrap;align-items:center;gap:9px;color:var(--faint);font-size:9px}.notification-permission small{color:var(--muted)}
</style>
