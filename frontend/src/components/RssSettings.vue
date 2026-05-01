<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useMainStore } from "../stores/main";
import type { RssCategory, RssFeed, WidgetConfig } from "@/types";

const store = useMainStore();
const RSS_COLLAPSED_STORAGE_KEY = "flatnas-rss-settings-collapsed";

const rssWidget = computed(() => store.widgets.find((w: WidgetConfig) => w.type === "rss"));
const rssFeeds = computed(() => (Array.isArray(store.rssFeeds) ? store.rssFeeds : []));
const rssCategories = computed(() => (Array.isArray(store.rssCategories) ? store.rssCategories : []));
const rssCollapsed = ref(true);

const quickFeed = ref({
  title: "",
  url: "",
  category: "",
  enable: true,
  isPublic: true,
});

const importText = ref("");
const importCategory = ref("");
const importEnable = ref(true);
const importPublic = ref(true);
const newCategoryName = ref("");
const importFeedback = ref<{ type: "success" | "error" | "info"; text: string } | null>(null);
const importFetchingTitles = ref(false);

const ensureArrays = () => {
  if (!Array.isArray(store.rssFeeds)) {
    store.rssFeeds = [];
  }
  if (!Array.isArray(store.rssCategories)) {
    store.rssCategories = [];
  }
};

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeText = (value?: string) => (value || "").trim();

const normalizeUrl = (value: string) => value.trim();

const looksLikeUrl = (value: string) => {
  const trimmed = normalizeUrl(value);
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return /^(https?:\/\/|feed:\/\/|localhost(?::\d+)?(?:\/|$)|[\w.-]+\.[A-Za-z]{2,}(?:[/:?#]|$))/i.test(
    trimmed,
  );
};

const buildFallbackTitle = (value: string) => {
  const trimmed = normalizeUrl(value);
  if (!trimmed) {
    return "未命名订阅源";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "") || trimmed;
  } catch {
    return trimmed;
  }
};

const upsertCategory = (name: string) => {
  const normalized = normalizeText(name);
  if (!normalized) {
    return;
  }
  ensureArrays();
  const exists = rssCategories.value.some((category) => normalizeText(category.name) === normalized);
  if (!exists) {
    store.rssCategories = [
      ...rssCategories.value,
      {
        id: createId("rss-cat"),
        name: normalized,
        feeds: [],
      },
    ];
  }
};

const sanitizeFeed = (feed: RssFeed) => {
  feed.url = normalizeUrl(feed.url);
  feed.title = normalizeText(feed.title) || buildFallbackTitle(feed.url);
  feed.category = normalizeText(feed.category);
  feed.tags = Array.isArray(feed.tags)
    ? feed.tags.map((tag) => normalizeText(tag)).filter(Boolean)
    : [];
  if (feed.category) {
    upsertCategory(feed.category);
  }
};

const touchFeeds = () => {
  store.rssFeeds = [...rssFeeds.value];
  store.markDirty();
};

const addCategory = () => {
  const normalized = normalizeText(newCategoryName.value);
  if (!normalized) {
    return;
  }
  upsertCategory(normalized);
  newCategoryName.value = "";
  store.markDirty();
};

const removeCategory = (category: RssCategory) => {
  const normalized = normalizeText(category.name);
  if (!normalized) {
    return;
  }
  if (!confirm(`确定删除分类“${normalized}”吗？关联订阅源的分类将被清空。`)) {
    return;
  }
  store.rssCategories = rssCategories.value.filter((item) => item.id !== category.id);
  store.rssFeeds = rssFeeds.value.map((feed) =>
    normalizeText(feed.category) === normalized
      ? { ...feed, category: "" }
      : feed,
  );
  store.markDirty();
};

const addSingleFeed = () => {
  const url = normalizeUrl(quickFeed.value.url);
  if (!url) {
    importFeedback.value = { type: "error", text: "请填写 RSS 地址后再新增。" };
    return;
  }
  ensureArrays();
  const duplicate = rssFeeds.value.find((feed) => normalizeUrl(feed.url) === url);
  if (duplicate) {
    importFeedback.value = { type: "info", text: "该 RSS 地址已存在，未重复新增。" };
    return;
  }
  const category = normalizeText(quickFeed.value.category);
  if (category) {
    upsertCategory(category);
  }
  store.rssFeeds = [
    {
      id: createId("rss"),
      title: normalizeText(quickFeed.value.title) || buildFallbackTitle(url),
      url,
      category,
      tags: [],
      enable: quickFeed.value.enable,
      isPublic: quickFeed.value.isPublic,
    },
    ...rssFeeds.value,
  ];
  store.markDirty();
  quickFeed.value = {
    title: "",
    url: "",
    category: "",
    enable: true,
    isPublic: true,
  };
  importFeedback.value = { type: "success", text: "订阅源已新增。" };
};

const parseImportLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const lastPart = parts[parts.length - 1];
  if (parts.length >= 2 && looksLikeUrl(lastPart)) {
    const title = normalizeText(trimmed.slice(0, trimmed.lastIndexOf(lastPart)));
    if (title) {
      return {
        title,
        url: normalizeUrl(lastPart),
      };
    }
  }
  const pipeMatch = trimmed.match(/^(.*?)\s*\|\s*(\S+)$/);
  if (pipeMatch && looksLikeUrl(pipeMatch[2])) {
    return {
      title: normalizeText(pipeMatch[1]),
      url: normalizeUrl(pipeMatch[2]),
    };
  }
  const commaMatch = trimmed.match(/^(.*?)\s*[,，]\s*(\S+)$/);
  if (commaMatch && looksLikeUrl(commaMatch[2])) {
    return {
      title: normalizeText(commaMatch[1]),
      url: normalizeUrl(commaMatch[2]),
    };
  }
  if (looksLikeUrl(trimmed)) {
    return {
      title: "",
      url: normalizeUrl(trimmed),
    };
  }
  return null;
};

const fetchRemoteFeedTitle = async (url: string) => {
  const res = await fetch(`/api/rss/meta?url=${encodeURIComponent(url)}`, {
    cache: "no-store",
  });
  const payload = (await res.json()) as {
    success?: boolean;
    data?: { title?: string };
  };
  if (!res.ok || !payload.success) {
    throw new Error("Failed to fetch feed title");
  }
  return normalizeText(payload.data?.title);
};

const importFeeds = async () => {
  const lines = importText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    importFeedback.value = { type: "error", text: "请先粘贴要导入的 RSS 文本。" };
    return;
  }

  ensureArrays();
  const nextFeeds = [...rssFeeds.value];
  const byUrl = new Map(nextFeeds.map((feed) => [normalizeUrl(feed.url), feed]));
  const defaultCategory = normalizeText(importCategory.value);
  const invalidLines: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const importedFeeds: RssFeed[] = [];

  for (const line of lines) {
    const parsed = parseImportLine(line);
    if (!parsed) {
      invalidLines.push(line);
      continue;
    }

    const existing = byUrl.get(parsed.url);
    if (existing) {
      let changed = false;
      if (parsed.title && normalizeText(existing.title) !== parsed.title) {
        existing.title = parsed.title;
        changed = true;
      }
      if (defaultCategory && normalizeText(existing.category) !== defaultCategory) {
        existing.category = defaultCategory;
        changed = true;
      }
      if (changed) {
        sanitizeFeed(existing);
        updated += 1;
        importedFeeds.push(existing);
      } else {
        skipped += 1;
        importedFeeds.push(existing);
      }
      continue;
    }

    const feed: RssFeed = {
      id: createId("rss"),
      title: parsed.title || buildFallbackTitle(parsed.url),
      url: parsed.url,
      category: defaultCategory,
      tags: [],
      enable: importEnable.value,
      isPublic: importPublic.value,
    };
    sanitizeFeed(feed);
    nextFeeds.push(feed);
    byUrl.set(feed.url, feed);
    created += 1;
    importedFeeds.push(feed);
  }

  if (defaultCategory) {
    upsertCategory(defaultCategory);
  }

  store.rssFeeds = nextFeeds;
  store.markDirty();

  const parts = [`新增 ${created} 条`, `更新 ${updated} 条`, `跳过 ${skipped} 条`];
  if (invalidLines.length > 0) {
    parts.push(`无效 ${invalidLines.length} 行`);
  }
  importFeedback.value = {
    type: invalidLines.length > 0 ? "info" : "success",
    text: parts.join("，"),
  };

  if (created > 0 || updated > 0) {
    importText.value = "";
  }

  if (importedFeeds.length === 0) {
    return;
  }

  importFetchingTitles.value = true;
  const titleResults = await Promise.allSettled(
    importedFeeds.map(async (feed) => {
      const remoteTitle = await fetchRemoteFeedTitle(feed.url);
      return {
        feed,
        remoteTitle,
      };
    }),
  );

  let titleUpdated = 0;
  for (const result of titleResults) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const { feed, remoteTitle } = result.value;
    if (remoteTitle && remoteTitle !== normalizeText(feed.title)) {
      feed.title = remoteTitle;
      titleUpdated += 1;
    }
  }

  if (titleUpdated > 0) {
    store.rssFeeds = [...nextFeeds];
    store.markDirty();
  }

  if (titleUpdated > 0) {
    importFeedback.value = {
      type: "success",
      text: `${parts.join("，")}，已自动更新 ${titleUpdated} 个真实标题`,
    };
  } else if (importedFeeds.length > 0) {
    importFeedback.value = {
      type: importFeedback.value?.type || "info",
      text: `${parts.join("，")}，未获取到新的远端标题`,
    };
  }
  importFetchingTitles.value = false;
};

const deleteFeed = (id: string) => {
  if (!confirm("确定删除此订阅源吗？")) {
    return;
  }
  store.rssFeeds = rssFeeds.value.filter((feed) => feed.id !== id);
  store.markDirty();
};

const toggleWidgetDirty = () => {
  store.markDirty();
};

onMounted(() => {
  if (typeof window === "undefined") {
    return;
  }
  const saved = window.localStorage.getItem(RSS_COLLAPSED_STORAGE_KEY);
  if (saved === "true" || saved === "false") {
    rssCollapsed.value = saved === "true";
  }
});

watch(rssCollapsed, (value) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(RSS_COLLAPSED_STORAGE_KEY, String(value));
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3 border-l-4 border-orange-500 pl-3">
      <div>
        <h4 class="text-lg font-bold text-gray-800">RSS 订阅管理</h4>
        <p class="mt-1 text-xs text-gray-400">支持批量导入、列表编辑、删除和云端同步。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="flex items-center gap-1 rounded-full border border-green-100 bg-green-50 px-2 py-1 text-[10px] text-green-600"
        >
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"></span>
          云端同步已开启
        </span>
        <button
          class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          @click="rssCollapsed = !rssCollapsed"
        >
          {{ rssCollapsed ? "展开" : "收起" }}
        </button>
      </div>
    </div>

    <div v-show="!rssCollapsed" class="space-y-6">
      <section
        v-if="rssWidget"
        class="flex flex-col gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 md:flex-row md:items-center md:justify-between"
      >
        <div class="flex items-center gap-4">
          <div class="flex h-10 w-10 items-center justify-center rounded-full bg-white text-xl shadow-sm">📡</div>
          <div>
            <h5 class="font-bold text-gray-700">RSS 阅读器组件</h5>
            <p class="text-xs text-gray-400">桌面组件总开关</p>
          </div>
        </div>
        <div class="flex items-center gap-6">
          <label class="flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-500">
            <input
              v-model="rssWidget.isPublic"
              type="checkbox"
              class="accent-blue-500"
              @change="toggleWidgetDirty"
            />
            公开
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-500">
            <input
              v-model="rssWidget.enable"
              type="checkbox"
              class="accent-green-500"
              @change="toggleWidgetDirty"
            />
            启用
          </label>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr,0.9fr]">
        <section class="space-y-4 rounded-xl border border-orange-100 bg-orange-50/80 p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h5 class="text-sm font-bold text-orange-800">快速新增</h5>
              <p class="mt-1 text-xs text-orange-700/70">适合补一两个订阅源，标题可留空自动生成。</p>
            </div>
            <span class="text-[11px] text-orange-700/70">共 {{ rssFeeds.length }} 个订阅源</span>
          </div>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
            <input
              v-model="quickFeed.title"
              class="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
              placeholder="标题（可选）"
            />
            <input
              v-model="quickFeed.url"
              class="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 md:col-span-2"
              placeholder="RSS 地址，例如 https://example.com/feed"
              @keyup.enter="addSingleFeed"
            />
          </div>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-[1fr,auto,auto,auto]">
            <input
              v-model="quickFeed.category"
              list="rss-categories"
              class="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
              placeholder="分类（可选）"
            />
            <label class="flex items-center gap-2 text-xs text-gray-600">
              <input v-model="quickFeed.enable" type="checkbox" class="accent-orange-500" />
              启用
            </label>
            <label class="flex items-center gap-2 text-xs text-gray-600">
              <input v-model="quickFeed.isPublic" type="checkbox" class="accent-blue-500" />
              公开
            </label>
            <button
              class="rounded-lg bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600"
              @click="addSingleFeed"
            >
              新增
            </button>
          </div>
        </section>

        <section class="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <div>
            <h5 class="text-sm font-bold text-gray-800">批量导入</h5>
            <p class="mt-1 text-xs text-gray-400">
              支持每行一个 URL，或每行一条 `标题 URL`、`标题,URL`、`标题 | URL`。
            </p>
          </div>

          <textarea
            v-model="importText"
            class="min-h-[156px] w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
            placeholder="示例：&#10;36氪 https://www.36kr.com/feed&#10;少数派,https://sspai.com/feed&#10;酷壳 | https://coolshell.cn/feed&#10;https://example.com/rss.xml"
          ></textarea>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-[1fr,auto,auto]">
            <input
              v-model="importCategory"
              list="rss-categories"
              class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
              placeholder="导入后统一归类到某个分类（可选）"
            />
            <label class="flex items-center gap-2 text-xs text-gray-600">
              <input v-model="importEnable" type="checkbox" class="accent-orange-500" />
              默认启用
            </label>
            <label class="flex items-center gap-2 text-xs text-gray-600">
              <input v-model="importPublic" type="checkbox" class="accent-blue-500" />
              默认公开
            </label>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <div
              v-if="importFeedback"
              :class="
                importFeedback.type === 'error'
                  ? 'border-red-100 bg-red-50 text-red-600'
                  : importFeedback.type === 'success'
                    ? 'border-green-100 bg-green-50 text-green-600'
                    : 'border-blue-100 bg-blue-50 text-blue-600'
              "
              class="rounded-lg border px-3 py-2 text-xs"
            >
              {{ importFeedback.text }}
            </div>
            <div
              v-else-if="importFetchingTitles"
              class="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-600"
            >
              正在抓取远端真实标题...
            </div>
            <div class="ml-auto flex items-center gap-2">
              <button
                class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                @click="importText = ''"
              >
                清空
              </button>
              <button
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-bold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="importFetchingTitles"
                @click="importFeeds"
              >
                {{ importFetchingTitles ? "抓取标题中..." : "导入订阅源" }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h5 class="text-sm font-bold text-gray-800">分类</h5>
            <p class="mt-1 text-xs text-gray-400">分类会作为订阅源的下拉候选项，可随时删除。</p>
          </div>
          <div class="flex w-full gap-2 md:w-auto">
            <input
              v-model="newCategoryName"
              class="min-w-[220px] flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
              placeholder="新增分类"
              @keyup.enter="addCategory"
            />
            <button
              class="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-600 hover:bg-orange-100"
              @click="addCategory"
            >
              添加分类
            </button>
          </div>
        </div>

        <div v-if="rssCategories.length > 0" class="flex flex-wrap gap-2">
          <span
            v-for="category in rssCategories"
            :key="category.id"
            class="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-600"
          >
            {{ category.name }}
            <button class="text-red-500 hover:text-red-600" @click="removeCategory(category)">删除</button>
          </span>
        </div>
        <div
          v-else
          class="rounded-lg border border-dashed border-gray-200 px-4 py-5 text-center text-sm text-gray-400"
        >
          还没有分类，导入或新增时填写分类会自动补充到这里。
        </div>
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h5 class="text-sm font-bold text-gray-800">订阅源列表</h5>
            <p class="mt-1 text-xs text-gray-400">直接修改后会自动参与保存；分类输入框支持现有分类提示。</p>
          </div>
        </div>

        <div
          v-if="rssFeeds.length === 0"
          class="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400"
        >
          还没有订阅源，先在上方快速新增或批量导入。
        </div>

        <div v-else class="space-y-3">
          <article
            v-for="feed in rssFeeds"
            :key="feed.id"
            class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
          >
            <div class="grid grid-cols-1 gap-3 xl:grid-cols-[0.9fr,1.6fr,0.7fr,auto]">
              <input
                v-model="feed.title"
                class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="标题"
                @blur="sanitizeFeed(feed); touchFeeds()"
              />
              <input
                v-model="feed.url"
                class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="RSS 地址"
                @blur="sanitizeFeed(feed); touchFeeds()"
              />
              <input
                v-model="feed.category"
                list="rss-categories"
                class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="分类"
                @blur="sanitizeFeed(feed); touchFeeds()"
              />
              <button
                class="rounded-lg border border-red-200 px-3 py-2 text-sm font-bold text-red-500 hover:bg-red-50"
                @click="deleteFeed(feed.id)"
              >
                删除
              </button>
            </div>

            <div class="mt-3 flex max-w-full flex-wrap items-center justify-between gap-3">
              <div class="max-w-full truncate text-xs text-gray-400">{{ feed.url }}</div>
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    v-model="feed.enable"
                    type="checkbox"
                    class="accent-orange-500"
                    @change="touchFeeds"
                  />
                  启用
                </label>
                <label class="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    v-model="feed.isPublic"
                    type="checkbox"
                    class="accent-blue-500"
                    @change="touchFeeds"
                  />
                  公开
                </label>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>

    <datalist id="rss-categories">
      <option v-for="category in rssCategories" :key="category.id" :value="category.name"></option>
    </datalist>
  </div>
</template>
