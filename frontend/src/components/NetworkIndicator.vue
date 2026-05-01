<template>
  <div class="network-indicator" :class="statusClass" :title="statusTooltip">
    <div class="indicator-dot" />
    <span class="indicator-text">{{ statusLabel }}</span>
    <span v-if="offlineQueueCount > 0" class="indicator-badge" :title="`${offlineQueueCount} 条待同步`">
      {{ offlineQueueCount }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useMainStore } from "@/stores/main";

const store = useMainStore();
const offlineQueueCount = computed(() => store.offlineQueueCount);

// Expose isHttpPollingActive from sync store
const isHttpPollingActive = computed(() => {
  try {
    return store.isHttpPollingActive;
  } catch { return false; }
});

const networkMode = computed(() => {
  if (store.offlineQueueCount > 0) return "offline";
  if (store.isConnected) return "online";
  // WS connecting or established: not truly offline
  const wsStatus = store.status;
  const wsConnectingOrOpen = wsStatus === "CONNECTING" || wsStatus === "OPEN";
  if (isHttpPollingActive.value || !store.isLogged) return "degraded";
  if (wsConnectingOrOpen) return "degraded";
  // Authed, WS down and no HTTP polling: truly offline
  return "offline";
});

const statusClass = computed(() => ({
  "mode--online": networkMode.value === "online",
  "mode--degraded": networkMode.value === "degraded",
  "mode--offline": networkMode.value === "offline",
}));

const statusLabel = computed(() => {
  if (store.offlineQueueCount > 0) return "队列中";
  if (store.isConnected) return "在线";
  const wsStatus = store.status;
  const wsConnectingOrOpen = wsStatus === "CONNECTING" || wsStatus === "OPEN";
  if (isHttpPollingActive.value || !store.isLogged) return "降级在线";
  if (wsConnectingOrOpen) return "降级在线";
  return "离线";
});

const statusTooltip = computed(() => {
  if (store.offlineQueueCount > 0) return `${store.offlineQueueCount} 条离线数据待同步`;
  if (store.isConnected) return "WebSocket 已连接";
  const wsStatus = store.status;
  const wsConnectingOrOpen = wsStatus === "CONNECTING" || wsStatus === "OPEN";
  if (isHttpPollingActive.value || !store.isLogged) return "WebSocket 断开，HTTP 通道可用";
  if (wsConnectingOrOpen) return "WebSocket 连接中...";
  return "网络不可用";
});
</script>

<style scoped>
.network-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s ease;
  user-select: none;
}

.indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background-color 0.2s ease;
}

.indicator-text {
  white-space: nowrap;
}

.indicator-badge {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 10px;
  min-width: 16px;
  text-align: center;
}

/* Online - Green */
.mode--online {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.mode--online .indicator-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}

/* Degraded - Yellow/Orange */
.mode--degraded {
  background: rgba(245, 158, 11, 0.15);
  color: #d97706;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.mode--degraded .indicator-dot {
  background: #f59e0b;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.5);
  animation: pulse-dot 1.5s ease-in-out infinite;
}

/* Offline - Red */
.mode--offline {
  background: rgba(239, 68, 68, 0.15);
  color: #dc2626;
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.mode--offline .indicator-dot {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
  animation: pulse-dot 1s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}
</style>
