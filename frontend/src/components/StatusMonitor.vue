<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick } from "vue";
import type { WidgetConfig } from "@/types";
import {
  initObjectUrlRuntime,
  subscribeObjectUrlRuntime,
  type ObjectUrlRuntimeSnapshot,
} from "@/utils/objectUrlRuntime";
import { useStorage, useWindowSize } from "@vueuse/core";

defineProps<{ widget: WidgetConfig }>();
const runtimeStats = ref<ObjectUrlRuntimeSnapshot | null>(null);
let runtimeOff: (() => void) | null = null;
const panelRef = ref<HTMLElement | null>(null);
const { width: windowWidth, height: windowHeight } = useWindowSize();
const position = useStorage("flatnas-status-monitor-position", { x: 0, y: 0 });
const positionReady = useStorage("flatnas-status-monitor-position-ready", false);
const isDragging = ref(false);
const dragStart = ref({ x: 0, y: 0 });
const pointerStart = ref({ x: 0, y: 0 });

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let v = value;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${Math.min(100, Math.max(0, value)).toFixed(0)}%`;
};

const sparkline = (values: number[]) => {
  if (!values.length) return "";
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fullBar = bars[bars.length - 1] || "█";
  if (min === max) return fullBar.repeat(Math.min(values.length, 30));
  const slice = values.slice(-30);
  return slice
    .map((v) => {
      const ratio = (v - min) / (max - min);
      const idx = Math.min(bars.length - 1, Math.floor(ratio * bars.length));
      return bars[idx] || fullBar;
    })
    .join("");
};

const lastSample = computed(() => {
  const list = runtimeStats.value?.samples || [];
  return list.length ? list[list.length - 1] : null;
});

const heapPercent = computed(() => {
  if (!lastSample.value) return "0%";
  const value = (lastSample.value.used / lastSample.value.limit) * 100;
  return formatPercent(value);
});

const clampPosition = (x: number, y: number) => {
  const rect = panelRef.value?.getBoundingClientRect();
  const w = rect?.width ?? 220;
  const h = rect?.height ?? 140;
  const maxX = Math.max(0, windowWidth.value - w);
  const maxY = Math.max(0, windowHeight.value - h);
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
  };
};

const setDefaultPosition = () => {
  const rect = panelRef.value?.getBoundingClientRect();
  const w = rect?.width ?? 220;
  const h = rect?.height ?? 140;
  const x = Math.max(0, windowWidth.value - w - 24);
  const y = Math.max(0, windowHeight.value - h - 96);
  const next = clampPosition(x, y);
  position.value = next;
  positionReady.value = true;
};

const onPointerMove = (e: PointerEvent) => {
  if (!isDragging.value) return;
  const dx = e.clientX - pointerStart.value.x;
  const dy = e.clientY - pointerStart.value.y;
  const next = clampPosition(dragStart.value.x + dx, dragStart.value.y + dy);
  position.value = next;
};

const onPointerUp = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
};

const onPointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return;
  isDragging.value = true;
  dragStart.value = { x: position.value.x, y: position.value.y };
  pointerStart.value = { x: e.clientX, y: e.clientY };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
};

onMounted(() => {
  initObjectUrlRuntime();
  runtimeOff = subscribeObjectUrlRuntime((snapshot) => {
    runtimeStats.value = snapshot;
  });
  void nextTick(() => {
    if (!positionReady.value) setDefaultPosition();
    else position.value = clampPosition(position.value.x, position.value.y);
  });
});

onBeforeUnmount(() => {
  runtimeOff?.();
  runtimeOff = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
});
</script>

<template>
  <div
    ref="panelRef"
    class="fixed z-[100] p-3 rounded-2xl backdrop-blur border border-white/10 flex flex-col gap-1 text-white text-[11px] select-none cursor-move shadow-lg"
    :style="{
      left: position.x + 'px',
      top: position.y + 'px',
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget.opacity ?? 0.65))})`,
      color: widget.textColor || '#fff',
    }"
    @pointerdown="onPointerDown"
  >
    <template v-if="runtimeStats">
      <div class="flex items-center justify-between gap-3">
        <span>对象URL</span>
        <span>{{ runtimeStats.objectUrlCount }} · {{ formatBytes(runtimeStats.objectUrlBytes) }}</span>
      </div>
      <div class="flex items-center justify-between gap-3 text-white/80">
        <span>受管</span>
        <span>{{ runtimeStats.managedCount }} · {{ formatBytes(runtimeStats.managedBytes) }}</span>
      </div>
      <div class="flex items-center justify-between gap-3 text-white/80">
        <span>未托管</span>
        <span>{{ runtimeStats.unmanagedCount }} · {{ formatBytes(runtimeStats.unmanagedBytes) }}</span>
      </div>
      <div class="flex items-center justify-between gap-3 text-white/70">
        <span>键/闲置</span>
        <span>{{ runtimeStats.keyCount }} · {{ runtimeStats.idleManagedCount }}</span>
      </div>
      <div class="flex items-center justify-between gap-3">
        <span>JS 堆</span>
        <span v-if="lastSample"
          >{{ formatBytes(lastSample.used) }} / {{ formatBytes(lastSample.total) }} ·
          {{ heapPercent }}</span
        >
        <span v-else>不可用</span>
      </div>
      <div class="mt-1 text-white/70">
        {{ sparkline(runtimeStats.samples.map((s) => s.used)) }}
      </div>
    </template>
    <div v-else class="text-white/70">加载中</div>
  </div>
</template>
