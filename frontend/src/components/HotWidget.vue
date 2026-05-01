<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import type { WidgetConfig } from "@/types";
import { VueDraggable } from "vue-draggable-plus";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

defineProps<{ widget: WidgetConfig; isEditMode?: boolean }>();

interface HotItem {
  title: string;
  url: string;
  hot: string | number;
}

interface TabConfig {
  id: "weibo" | "news" | "bilibili";
  label: string;
  icon: string;
  activeClass: string;
  barClass: string;
  indexClass: string;
}

const tabs = ref<TabConfig[]>([
  {
    id: "weibo",
    label: "微博",
    icon: "🔥",
    activeClass: "text-white bg-white/15",
    barClass: "bg-white/60",
    indexClass: "text-white bg-white/15",
  },
  {
    id: "news",
    label: "中新网",
    icon: "🗞️",
    activeClass: "text-white bg-white/15",
    barClass: "bg-white/60",
    indexClass: "text-white bg-white/15",
  },
  {
    id: "bilibili",
    label: "B站",
    icon: "📺",
    activeClass: "text-white bg-white/15",
    barClass: "bg-white/60",
    indexClass: "text-white bg-white/15",
  },
]);

// 缓存不同 Tab 的数据，避免来回切换时重复请求
const cache = ref<Record<string, { data: HotItem[]; ts: number }>>({});
const CACHE_TTL = 60 * 1000; // 仅做短时前端缓存，实际新鲜度交给后端缓存
const HOT_POLL_INTERVAL_MS = 5 * 60 * 1000;

const activeTab = ref<"weibo" | "news" | "bilibili">("weibo");
const list = ref<HotItem[]>([]);
const loading = ref(false);
const HOT_FETCH_TIMEOUT_MS = 8000;
let activeRequestId = 0;
let activeController: AbortController | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// 获取数据 (带缓存优化)
const fetchHot = async (type: "weibo" | "news" | "bilibili", force = false) => {
  activeController?.abort();
  activeController = null;
  activeTab.value = type;
  const requestId = ++activeRequestId;

  const now = Date.now();
  if (!force && cache.value[type] && now - cache.value[type].ts < CACHE_TTL) {
    list.value = cache.value[type].data;
    return;
  }

  loading.value = true;
  if (cache.value[type]) {
    // 即使过期也先显示旧数据，避免空白
    list.value = cache.value[type].data;
  } else {
    list.value = [];
  }

  const controller = new AbortController();
  activeController = controller;
  const timeoutTimer = setTimeout(() => controller.abort(), HOT_FETCH_TIMEOUT_MS);

  try {
    const url = `/api/hot?type=${encodeURIComponent(type)}${force ? "&force=1" : ""}`;
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (requestId !== activeRequestId) return;
    const data = Array.isArray(payload.data) ? payload.data : [];
    list.value = data;
    cache.value[type] = { data, ts: Date.now() };
  } catch (error) {
    if (requestId !== activeRequestId) return;
    console.error(`加载 ${type} 失败`, error);
    if (list.value.length === 0) {
      list.value = [
        {
          title: controller.signal.aborted ? "请求超时，请重试" : "加载失败，请重试",
          url: "#",
          hot: "",
        },
      ];
    }
  } finally {
    clearTimeout(timeoutTimer);
    if (requestId === activeRequestId) {
      loading.value = false;
    }
    if (activeController === controller) {
      activeController = null;
    }
  }
};

const startPolling = () => {
  if (pollTimer || document.visibilityState === "hidden") return;
  pollTimer = setInterval(() => {
    fetchHot(activeTab.value);
  }, HOT_POLL_INTERVAL_MS);
};

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

useResumeRefresh({
  onHidden: () => {
    stopPolling();
  },
  onVisible: () => {
    void fetchHot(activeTab.value, true);
    startPolling();
  },
  onOnline: () => {
    void fetchHot(activeTab.value, true);
    startPolling();
  },
});

onMounted(() => {
  void fetchHot("weibo");
  startPolling();
});

onUnmounted(() => {
  activeController?.abort();
  stopPolling();
});

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
    class="w-full h-full rounded-2xl backdrop-blur border border-white/10 overflow-hidden flex flex-col text-white relative transition-shadow"
    :style="{
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget.opacity ?? 0.35))})`,
      color: '#fff',
    }"
  >
    <VueDraggable
      v-model="tabs"
      class="flex border-b border-white/10 bg-white/10 select-none"
      :animation="150"
      :disabled="isEditMode"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="fetchHot(tab.id, activeTab === tab.id)"
        class="flex-1 py-2.5 text-xs font-bold transition-all flex items-center justify-center gap-1.5 relative overflow-hidden cursor-move"
        :class="
          activeTab === tab.id
            ? tab.activeClass
            : 'text-white/60 hover:bg-white/10 hover:text-white'
        "
      >
        <span class="text-sm">{{ tab.icon }}</span>
        <span>{{ tab.label }}</span>
        <div
          v-if="activeTab === tab.id"
          class="absolute bottom-0 left-0 right-0 h-0.5"
          :class="tab.barClass"
        ></div>
      </button>
    </VueDraggable>

    <div class="flex-1 overflow-hidden relative">
      <div class="h-full overflow-y-auto custom-scrollbar p-0" @wheel="handleScrollIsolation">
        <div
          v-if="loading && list.length === 0"
          class="p-8 text-center text-white/60 text-xs animate-pulse"
        >
          加载中...
        </div>
        <div v-else class="flex flex-col py-1">
          <a
            v-for="(item, index) in list"
            :key="index"
            :href="item.url"
            target="_blank"
            class="block px-3 py-1 hover:bg-white/10 transition-colors group/item flex items-start gap-2"
          >
            <span
              class="text-xs font-bold min-w-[1.25rem] h-5 flex items-center justify-center rounded mt-0.5 transition-colors"
              :class="
                index < 3
                  ? tabs.find((t) => t.id === activeTab)?.indexClass
                  : 'text-white/60 bg-white/10'
              "
            >
              {{ index + 1 }}
            </span>
            <div class="flex-1 min-w-0">
              <div
                class="text-sm text-white/80 group-hover/item:text-white transition-colors line-clamp-2 leading-relaxed"
              >
                {{ item.title }}
              </div>
              <div v-if="item.hot" class="text-xs text-white/50 mt-0.5">{{ item.hot }}</div>
            </div>
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
}
</style>
