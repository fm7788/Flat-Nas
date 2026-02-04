<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import { useMainStore } from "../stores/main";
import type { RssFeed, WidgetConfig } from "@/types";

defineProps<{ widget: WidgetConfig }>();

const store = useMainStore();

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
}

// Cache structure: url -> { data: items, ts: timestamp }
const cache = ref<Record<string, { data: RssItem[]; ts: number }>>({});
const CACHE_TTL = 5 * 60 * 1000; // Cache 5 minutes for custom RSS

const activeFeedId = ref<string>("");
const list = ref<RssItem[]>([]);
const loading = ref(false);
const errorMsg = ref("");

// Get enabled feeds
const enabledFeeds = computed(() => store.rssFeeds.filter((f) => f.enable));

// Watch for feed changes to reset/update
watch(
  enabledFeeds,
  (newFeeds) => {
    if (newFeeds.length > 0) {
      // If current active feed is gone, switch to first
      if (!newFeeds.find((f) => f.id === activeFeedId.value)) {
        const first = newFeeds[0];
        if (first) {
          activeFeedId.value = first.id;
          fetchFeed(first);
        }
      }
    } else {
      activeFeedId.value = "";
      list.value = [];
    }
  },
  { deep: true },
);

const fetchFeed = async (feed: RssFeed, force = false) => {
  if (!feed) return;
  activeFeedId.value = feed.id;
  errorMsg.value = "";

  // Check cache
  const now = Date.now();
  const cached = cache.value[feed.url];
  if (!force && cached && now - cached.ts < CACHE_TTL) {
    list.value = cached.data;
    return;
  }

  loading.value = true;
  list.value = [];

  // Use Socket.IO
  store.socket.emit("rss:fetch", { url: feed.url });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onData = (payload: any) => {
    if (payload.url === feed.url) {
      const items = payload.data.items || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      list.value = items.map((item: any) => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        contentSnippet: item.contentSnippet,
      }));
      // Write cache
      cache.value[feed.url] = { data: list.value, ts: Date.now() };
      loading.value = false;
      cleanup();
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onError = (payload: any) => {
    if (payload.url === feed.url) {
      console.error(`Failed to load RSS: ${feed.title}`, payload.error);
      errorMsg.value = "加载失败";
      list.value = [];
      loading.value = false;
      cleanup();
    }
  };

  const cleanup = () => {
    store.socket.off("rss:data", onData);
    store.socket.off("rss:error", onError);
  };

  store.socket.on("rss:data", onData);
  store.socket.on("rss:error", onError);
};

onMounted(() => {
  const first = enabledFeeds.value[0];
  if (first) {
    activeFeedId.value = first.id;
    fetchFeed(first);
  }
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

const tabsRef = ref<HTMLDivElement | null>(null);

const handleHorizontalScroll = (e: WheelEvent) => {
  if (!tabsRef.value) return;
  if (e.deltaY !== 0) {
    tabsRef.value.scrollLeft += e.deltaY;
  }
};
</script>

<template>
  <div
    class="w-full h-full rounded-2xl backdrop-blur border border-white/10 overflow-hidden flex flex-col text-white relative transition-shadow"
    :style="{
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget?.opacity ?? 0.35))})`,
      color: '#fff',
    }"
  >
    <!-- Header / Tabs -->
    <div
      ref="tabsRef"
      @wheel.prevent="handleHorizontalScroll"
      class="flex border-b border-white/10 bg-white/10 select-none overflow-x-auto custom-scrollbar"
    >
      <div
        v-if="enabledFeeds.length === 0"
        class="w-full py-2.5 text-xs text-white/60 text-center"
      >
        暂无订阅源
      </div>
      <button
        v-for="feed in enabledFeeds"
        :key="feed.id"
        @click="fetchFeed(feed)"
        class="flex-shrink-0 px-4 py-2.5 text-xs font-bold transition-all flex items-center justify-center gap-1.5 relative whitespace-nowrap"
        :class="
          activeFeedId === feed.id
            ? 'text-white bg-white/15'
            : 'text-white/60 hover:bg-white/10 hover:text-white'
        "
      >
        <span>{{ feed.title }}</span>
        <div
          v-if="activeFeedId === feed.id"
          class="absolute bottom-0 left-0 right-0 h-0.5 bg-white/60"
        ></div>
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-hidden relative">
      <div class="h-full overflow-y-auto custom-scrollbar p-0" @wheel="handleScrollIsolation">
        <div
          v-if="enabledFeeds.length === 0"
          class="h-full flex flex-col items-center justify-center text-white/60 p-4 text-center"
        >
          <span class="text-2xl mb-2">📡</span>
          <span class="text-xs">请在设置中添加并启用 RSS 订阅源</span>
        </div>

        <div
          v-else-if="loading && list.length === 0"
          class="p-8 text-center text-white/60 text-xs animate-pulse"
        >
          加载中...
        </div>

        <div v-else-if="errorMsg" class="p-8 text-center text-white/70 text-xs">
          {{ errorMsg }}
          <button
            @click="fetchFeed(enabledFeeds.find((f) => f.id === activeFeedId)!, true)"
            class="block mx-auto mt-2 text-white/80 hover:text-white hover:underline"
          >
            重试
          </button>
        </div>

        <div v-else class="flex flex-col py-1">
          <a
            v-for="(item, index) in list"
            :key="index"
            :href="item.link"
            target="_blank"
            class="block px-3 py-2 hover:bg-white/10 transition-colors group/item border-b border-white/10 last:border-0"
          >
            <div
              class="text-sm text-white/80 group-hover/item:text-white transition-colors font-medium line-clamp-2 mb-1"
            >
              {{ item.title }}
            </div>
            <div class="flex justify-between items-center">
              <div
                v-if="item.contentSnippet"
                class="text-[10px] text-white/50 line-clamp-1 flex-1 mr-2"
              >
                {{ item.contentSnippet }}
              </div>
              <div v-if="item.pubDate" class="text-[10px] text-white/40 whitespace-nowrap">
                {{ new Date(item.pubDate).toLocaleDateString() }}
              </div>
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
  height: 4px;
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
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
