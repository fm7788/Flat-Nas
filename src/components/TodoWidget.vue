<script setup lang="ts">
/* eslint-disable vue/no-mutating-props */
import { ref, watch, onMounted } from "vue";
import { useStorage, useDebounceFn } from "@vueuse/core";
import type { WidgetConfig } from "@/types";
import { useMainStore } from "../stores/main";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();
const newItem = ref("");
const saveStatus = ref<"saved" | "saving" | "unsaved">("saved");

const pushUpdate = useDebounceFn(() => {
  if (!store.isLogged) return;
  store.socket.emit("todo:update", {
    token: store.token || localStorage.getItem("flat-nas-token"),
    widgetId: props.widget.id,
    content: props.widget.data,
  });
}, 100);

const persistSave = useDebounceFn(async () => {
  if (!store.isLogged) return;
  saveStatus.value = "saving";
  await store.saveWidget();
  setTimeout(() => {
    saveStatus.value = "saved";
  }, 500);
}, 500);

// 本地持久化备份：防止网络断开时数据丢失
const localBackup = useStorage<TodoItem[]>(`flatnas-todo-backup-${props.widget.id}`, []);

watch(
  () => props.widget.data,
  (newVal) => {
    if (newVal) localBackup.value = newVal;
    // Removed auto-save here to prevent loop with backend updates
  },
  { deep: true },
);

onMounted(() => {
  // 如果服务端数据为空，但本地有备份，则恢复备份
  if ((!props.widget.data || props.widget.data.length === 0) && localBackup.value.length > 0) {
    props.widget.data = localBackup.value;
  }
});

const handleSave = () => {
  saveStatus.value = "unsaved";
  persistSave();
};

const add = () => {
  if (!newItem.value) return;
  if (!props.widget.data) props.widget.data = [];
  props.widget.data.push({ id: Date.now().toString(), text: newItem.value, done: false });
  newItem.value = "";
  pushUpdate();
  handleSave();
};

const remove = (index: number | string) => {
  const targetIndex = typeof index === "string" ? Number(index) : index;
  if (Number.isNaN(targetIndex)) return;
  props.widget.data.splice(targetIndex, 1);
  pushUpdate();
  handleSave();
};

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
        <span>✅ 待办</span>
        <span
          v-if="saveStatus !== 'saved'"
          class="text-[10px] font-normal text-white/60 transition-opacity"
        >
          {{ saveStatus === "saving" ? "..." : "•" }}
        </span>
      </div>
      <span class="text-[10px] text-white/60"
        >{{ widget.data?.filter((i: TodoItem) => !i.done).length || 0 }} 待完成</span
      >
    </div>

    <div class="flex-1 overflow-y-auto space-y-1 scrollbar-hide" @wheel="handleScrollIsolation">
      <div v-for="(item, idx) in widget.data" :key="item.id" class="flex items-start gap-2 group">
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
      <div v-if="!widget.data?.length" class="text-xs text-white/50 text-center py-2">
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
