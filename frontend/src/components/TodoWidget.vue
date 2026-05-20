<script setup lang="ts">
/* eslint-disable vue/no-mutating-props */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useStorage, useDebounceFn } from "@vueuse/core";
import type { WidgetConfig } from "@/types";
import { useMainStore } from "../stores/main";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();
const newItem = ref("");
const saveStatus = ref<"saved" | "saving" | "unsaved">("saved");
// LAN 判定只是一种"偏好"。在隧道/反代场景下 socket 可能实际断开，
// 此时仍需要保留 HTTP 轮询兜底，避免 Todo 永久不同步。
const shouldUseSocket = computed(() => store.isLanModeInited && store.effectiveIsLan && store.isConnected);
const TODO_POLL_INTERVAL_MS = 10000;
const TODO_POLL_TIMEOUT_MS = 8000;
const TODO_LOCAL_CHANGE_GRACE_MS = 8000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollController: AbortController | null = null;
let lastLocalMutationAt = 0;

const normalizeTodoItems = (value: unknown): TodoItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Partial<TodoItem>;
      return {
        id: typeof candidate.id === "string" ? candidate.id : Date.now().toString(),
        text: typeof candidate.text === "string" ? candidate.text : "",
        done: Boolean(candidate.done),
      };
    })
    .filter((item): item is TodoItem => item !== null);
};

const todoItems = computed(() => normalizeTodoItems(props.widget.data));

const stopPolling = () => {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollController) {
    pollController.abort();
    pollController = null;
  }
};

const scheduleNextPoll = () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (!store.isLogged || shouldUseSocket.value || document.visibilityState === "hidden") return;
  pollTimer = setTimeout(() => {
    void pollRemote();
  }, TODO_POLL_INTERVAL_MS);
};

const pollRemote = async (force = false) => {
  if (!store.isLogged) return;
  if (shouldUseSocket.value && !force) {
    stopPolling();
    return;
  }
  if (!force) {
    if (saveStatus.value !== "saved") {
      scheduleNextPoll();
      return;
    }
    if (Date.now() - lastLocalMutationAt < TODO_LOCAL_CHANGE_GRACE_MS) {
      scheduleNextPoll();
      return;
    }
  }

  pollController?.abort();
  const controller = new AbortController();
  pollController = controller;
  const timeoutTimer = setTimeout(() => controller.abort(), TODO_POLL_TIMEOUT_MS);

  try {
    const res = await fetch(`/api/widgets/${encodeURIComponent(props.widget.id)}`, {
      headers: store.getHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(res.statusText);
    const payload = (await res.json()) as { success?: boolean; data?: unknown };
    if (!payload.success) throw new Error("todo payload invalid");
    const nextItems = normalizeTodoItems(payload.data);
    const currentItems = normalizeTodoItems(props.widget.data);
    if (JSON.stringify(currentItems) !== JSON.stringify(nextItems)) {
      props.widget.data = nextItems;
    }
  } catch {
    // Ignore transient polling failures and try again next cycle.
  } finally {
    clearTimeout(timeoutTimer);
    if (pollController === controller) {
      pollController = null;
    }
    scheduleNextPoll();
  }
};

const pushUpdate = useDebounceFn(() => {
  if (!store.isLogged || !shouldUseSocket.value) return;
  store.wsSend({
    type: "todo_update",
    payload: {
      token: store.token || localStorage.getItem("flat-nas-token"),
      widgetId: props.widget.id,
      content: props.widget.data,
    },
  });
}, 100);

const persistSave = useDebounceFn(async () => {
  if (!store.isLogged) return;
  saveStatus.value = "saving";
  try {
    const ok = await store.saveSingleWidget(props.widget.id, {
      data: props.widget.data,
      enable: props.widget.enable,
    });
    if (ok) {
      pushUpdate();
    }
  } finally {
    saveStatus.value = "saved";
    scheduleNextPoll();
  }
}, 500);

// 本地持久化备份：防止网络断开时数据丢失
const localBackup = useStorage<TodoItem[]>(`flatnas-todo-backup-${props.widget.id}`, []);
// 记录最后一次清空操作的时间戳，用于区分"主动清空"和"数据丢失"
const lastClearedAt = useStorage<number>(`flatnas-todo-last-cleared-${props.widget.id}`, 0);

watch(
  () => props.widget.data,
  (newVal) => {
    const isRecentLocalChange = Date.now() - lastLocalMutationAt < 2000;
    
    // 只有当新值是有效数据时才更新备份
    if (Array.isArray(newVal) && newVal.length > 0) {
      localBackup.value = newVal;
    }
    // 如果是用户主动清空（在最近2秒内有过本地操作），记录清空时间戳
    // 这样下次刷新页面时就不会错误恢复了
    if (isRecentLocalChange && (!Array.isArray(newVal) || newVal.length === 0)) {
      localBackup.value = [];
      lastClearedAt.value = Date.now();
    }
    // Removed auto-save here to prevent loop with backend updates
  },
  { deep: true },
);

onMounted(() => {
  const isEmptyData = !Array.isArray(props.widget.data) || props.widget.data.length === 0;
  const hasBackup = localBackup.value.length > 0;
  const isRecentClear = Date.now() - lastClearedAt.value < 60000; // 1分钟内的清空操作

  // 只有当：1.数据为空 2.有备份 3.不是最近的主动清空，才恢复备份
  if (isEmptyData && hasBackup && !isRecentClear) {
    props.widget.data = localBackup.value;
    // 立即保存，确保恢复的数据同步到服务端
    persistSave();
  }
  if (store.isLogged && !shouldUseSocket.value) {
    void pollRemote(true);
  }
});

onUnmounted(() => {
  stopPolling();
});

const handleSave = () => {
  lastLocalMutationAt = Date.now();
  saveStatus.value = "unsaved";
  persistSave();
};

const add = () => {
  if (!newItem.value) return;
  if (!Array.isArray(props.widget.data)) props.widget.data = [];
  props.widget.data.push({ id: Date.now().toString(), text: newItem.value, done: false });
  newItem.value = "";
  handleSave();
};

const remove = (index: number | string) => {
  const targetIndex = typeof index === "string" ? Number(index) : index;
  if (Number.isNaN(targetIndex)) return;
  if (!Array.isArray(props.widget.data)) return;
  props.widget.data.splice(targetIndex, 1);
  handleSave();
};

useResumeRefresh({
  enabled: () => store.isLogged,
  onHidden: () => {
    stopPolling();
  },
  onVisible: () => {
    if (!shouldUseSocket.value) {
      void pollRemote(true);
    }
  },
  onOnline: () => {
    if (!shouldUseSocket.value) {
      void pollRemote(true);
    }
  },
});

watch(
  [() => store.isLogged, shouldUseSocket],
  ([isLogged, useSocket]) => {
    if (!isLogged) {
      stopPolling();
      return;
    }
    if (useSocket) {
      stopPolling();
      return;
    }
    void pollRemote(true);
  },
);

const handleScrollIsolation = (e: WheelEvent) => {
  const el = e.currentTarget as HTMLDivElement;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const delta = e.deltaY;

  const isAtTop = scrollTop <= 0;
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

  if ((isAtTop && delta < 0) || (isAtBottom && delta > 0)) {
    e.preventDefault();
    e.stopPropagation();
  }
};
</script>

<template>
  <div
    class="w-full h-full rounded-2xl backdrop-blur border border-white/10 overflow-hidden flex flex-col text-white p-3"
    :style="{
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget.opacity ?? 0.35))})`,
      color: '#fff',
    }"
  >
    <div class="font-bold text-white text-xs mb-2 flex justify-between items-center">
      <div class="flex items-center gap-2">
        <span>待办</span>
        <span
          v-if="saveStatus !== 'saved'"
          class="text-[10px] font-normal text-white/60 transition-opacity"
        >
          {{ saveStatus === "saving" ? "..." : "" }}
        </span>
      </div>
      <span class="text-[10px] text-white/60"
        >{{ todoItems.filter((i: TodoItem) => !i.done).length || 0 }} 待完成</span
      >
    </div>

    <div class="flex-1 overflow-y-auto space-y-1 scrollbar-hide" @wheel="handleScrollIsolation">
      <div v-for="(item, idx) in todoItems" :key="item.id" class="flex items-start gap-2 group">
        <input
          type="checkbox"
          v-model="item.done"
          @change="handleSave"
          class="rounded text-white focus:ring-0 cursor-pointer mt-0.5"
        />
        <span
          class="text-xs flex-1 break-all whitespace-normal leading-tight"
          :class="item.done ? 'line-through' : ''"
          :style="{ color: item.done ? '#9ca3af' : '#ffffff' }"
          >{{ item.text }}</span
        >
        <button
          @click="remove(idx)"
          class="text-xs text-white/50 hover:text-white/80 border border-white/10 rounded px-2 py-0.5 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
        >
          删除
        </button>
      </div>
      <div v-if="!todoItems.length" class="text-xs text-white/50 text-center py-2">
        无待办事项
      </div>
    </div>

    <div class="mt-2 pt-2 border-t border-white/10 flex gap-2">
      <input
        v-model="newItem"
        @keyup.enter="add"
        placeholder="添加待办..."
        class="flex-1 text-xs bg-white/10 border border-white/20 rounded px-2 py-1 outline-none focus:bg-white/10 focus:border-white/40 transition-colors text-white placeholder-white/50"
      />
      <button
        @click="add"
        class="bg-white/10 text-white text-xs px-3 py-1 rounded hover:bg-white/20 transition-colors whitespace-nowrap"
      >
        回车
      </button>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
</style>
