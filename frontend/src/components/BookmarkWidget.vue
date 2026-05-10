<script setup lang="ts">
/* eslint-disable vue/no-mutating-props */
import { ref, nextTick, watch, onMounted, computed } from "vue";
import { useStorage } from "@vueuse/core";
import type { WidgetConfig, BookmarkItem, BookmarkCategory } from "@/types";
import { useMainStore } from "../stores/main";
import { isInternalDomain, processSecurityUrl } from "../utils/security";
import { parseBookmarks } from "../utils/bookmark";
import OverlayMotion from "@/components/base/OverlayMotion.vue";
import { VueDraggable } from "vue-draggable-plus";

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();

const searchQuery = ref("");

const filteredData = computed(() => {
  if (!searchQuery.value) return props.widget.data || [];
  const query = searchQuery.value.toLowerCase();

  return (props.widget.data || [])
    .map((cat: BookmarkCategory) => {
      const catMatches = cat.title.toLowerCase().includes(query);
      const children = Array.isArray(cat.children) ? cat.children : [];
      const matchingChildren = children.filter((item: BookmarkCategory | BookmarkItem) => {
        if ("url" in item) {
          return item.title.toLowerCase().includes(query) || item.url.toLowerCase().includes(query);
        }
        return item.title.toLowerCase().includes(query);
      });

      if (catMatches || matchingChildren.length > 0) {
        return {
          ...cat,
          children: catMatches ? children : matchingChildren,
        };
      }
      return null;
    })
    .filter((cat: BookmarkCategory | null) => cat !== null) as BookmarkCategory[];
});

// Local Backup
const localBackup = useStorage<BookmarkCategory[]>(
  `flatnas-bookmark-backup-${props.widget.id}`,
  [],
);

watch(
  () => props.widget.data,
  (newVal) => {
    if (newVal && newVal.length > 0) localBackup.value = newVal;
  },
  { deep: true },
);

onMounted(() => {
  if ((!props.widget.data || props.widget.data.length === 0) && localBackup.value.length > 0) {
    props.widget.data = localBackup.value;
  }
});

const activeCategoryId = ref<string | null>(null);
const activeCategory = ref<BookmarkCategory | null>(null);
const popupPos = ref({ x: 0, y: 0 });
const editingLinkId = ref<string | null>(null);
const newTitle = ref("");
const newUrl = ref("");
const newIcon = ref("");
const isFetching = ref(false);
const isAddingCategory = ref(false);
const newCategoryTitle = ref("");
const categoryInputRef = ref<HTMLInputElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 导入书签
const triggerImport = () => {
  fileInputRef.value?.click();
};

const handleFileUpload = (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const content = e.target?.result as string;
    try {
      const newItems = parseBookmarks(content);
      if (newItems.length > 0) {
        if (!props.widget.data) props.widget.data = [];

        // 分离文件夹和独立的书签
        const folders: BookmarkCategory[] = [];
        const links: BookmarkItem[] = [];

        for (const item of newItems) {
          if ("url" in item) {
            links.push(item as BookmarkItem);
          } else {
            folders.push(item as BookmarkCategory);
          }
        }

        // 1. 文件夹直接添加到根目录
        (props.widget.data as BookmarkCategory[]).push(...folders);

        // 2. 独立书签添加到“默认收藏”
        if (links.length > 0) {
          let defaultCat = (props.widget.data as BookmarkCategory[]).find(
            (c) => c.title === "默认收藏",
          );
          if (!defaultCat) {
            defaultCat = {
              id: Date.now().toString() + "_default",
              title: "默认收藏",
              collapsed: false,
              children: [],
            };
            (props.widget.data as BookmarkCategory[]).push(defaultCat);
          }
          defaultCat.children.push(...links);
        }

        alert(`成功导入 ${newItems.length} 个书签`);
        store.markDirty();
        await store.saveSingleWidget(props.widget.id, {
          data: props.widget.data,
          enable: props.widget.enable,
        });
      } else {
        alert("未找到可导入的书签");
      }
    } catch (error) {
      console.error("Import failed", error);
      alert("导入失败，请检查文件格式");
    }
  };
  reader.readAsText(file);
  // Reset input so the same file can be selected again if needed
  if (event.target) (event.target as HTMLInputElement).value = "";
};

// 添加分类
const addCategory = () => {
  isAddingCategory.value = true;
  newCategoryTitle.value = "";
  nextTick(() => {
    categoryInputRef.value?.focus();
  });
};

const confirmAddCategory = async () => {
  if (newCategoryTitle.value) {
    if (!props.widget.data) props.widget.data = [];
    props.widget.data.push({
      id: Date.now().toString(),
      title: newCategoryTitle.value,
      collapsed: false,
      children: [],
    });
    isAddingCategory.value = false;
    store.markDirty();
    const success = await store.saveSingleWidget(props.widget.id, {
      data: props.widget.data,
      enable: props.widget.enable,
    });
    if (!success) {
      alert("添加分类失败，请重试");
      props.widget.data.pop();
      await store.fetchData();
    }
  }
};

const cancelAddCategory = () => {
  isAddingCategory.value = false;
};

// 自动获取标题和图标
const autoFetchIcon = async () => {
  if (!newUrl.value) return;
  isFetching.value = true;

  try {
    const res = await fetch(`/api/fetch-meta?url=${encodeURIComponent(newUrl.value)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) newTitle.value = data.title;
      if (data.icon) {
        newIcon.value = data.icon;
      } else {
        newIcon.value = `https://www.favicon.vip/get.php?url=${encodeURIComponent(newUrl.value)}`;
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    isFetching.value = false;
  }
};

const startAdd = (e: MouseEvent, cat: BookmarkCategory) => {
  activeCategoryId.value = cat.id;
  activeCategory.value = cat;

  // Calculate position (simple boundary check)
  const width = 320;
  const height = 300;
  const x = Math.min(e.clientX, window.innerWidth - width - 20);
  const y = Math.min(e.clientY + 10, window.innerHeight - height - 20);
  popupPos.value = { x: Math.max(10, x), y: Math.max(10, y) };

  editingLinkId.value = null;
  newTitle.value = "";
  newUrl.value = "";
  newIcon.value = "";
};

const startEdit = (e: MouseEvent, cat: BookmarkCategory, link: BookmarkItem) => {
  activeCategoryId.value = cat.id;
  activeCategory.value = cat;

  const width = 320;
  const height = 300;
  const x = Math.min(e.clientX, window.innerWidth - width - 20);
  const y = Math.min(e.clientY + 10, window.innerHeight - height - 20);
  popupPos.value = { x: Math.max(10, x), y: Math.max(10, y) };

  editingLinkId.value = link.id;
  newTitle.value = link.title;
  newUrl.value = link.url;
  newIcon.value = link.icon || "";
};

const confirmSubmit = async () => {
  const cat = activeCategory.value;
  if (!cat) return;

  if (newTitle.value && newUrl.value) {
    let finalUrl = newUrl.value;
    if (!finalUrl.startsWith("http")) finalUrl = "https://" + finalUrl;

    if (!newIcon.value) {
      try {
        newIcon.value = `https://www.favicon.vip/get.php?url=${encodeURIComponent(finalUrl)}`;
      } catch {
        // ignore
      }
    }

    if (editingLinkId.value) {
      const target = cat.children.find(
        (l: BookmarkItem | BookmarkCategory) => l.id === editingLinkId.value,
      );
      if (target && "url" in target) {
        target.title = newTitle.value;
        target.url = finalUrl;
        target.icon = newIcon.value;
      }
    } else {
      cat.children.push({
        id: Date.now().toString(),
        title: newTitle.value,
        url: finalUrl,
        icon: newIcon.value,
      });
    }

    activeCategoryId.value = null;
    activeCategory.value = null;
    editingLinkId.value = null;
    store.markDirty();
    await store.saveSingleWidget(props.widget.id, {
      data: props.widget.data,
      enable: props.widget.enable,
    });
  }
};

const cancelEdit = () => {
  activeCategory.value = null;
  activeCategoryId.value = null;
  editingLinkId.value = null;
};

const toggleCategory = async (cat: BookmarkCategory) => {
  cat.collapsed = !cat.collapsed;
  store.markDirty();
  await store.saveSingleWidget(props.widget.id, {
    data: props.widget.data,
    enable: props.widget.enable,
  });
};

const onBookmarkDragEnd = async () => {
  store.markDirty();
  await store.saveSingleWidget(props.widget.id, {
    data: props.widget.data,
    enable: props.widget.enable,
  });
};

const isBookmarkDraggable = computed(() => store.isLogged);

const deleteItem = async (catId: string, linkId?: string) => {
  if (!props.widget.data) return;

  const catIndex = props.widget.data.findIndex((c: BookmarkCategory) => c.id === catId);
  if (catIndex === -1) return;

  if (linkId) {
    if (!confirm("确定删除这个书签吗？")) return;
    const childIndex = props.widget.data[catIndex].children.findIndex(
      (c: BookmarkItem | BookmarkCategory) => c.id === linkId,
    );
    if (childIndex > -1) {
      props.widget.data[catIndex].children.splice(childIndex, 1);
    }
  } else {
    props.widget.data.splice(catIndex, 1);
  }
  store.markDirty();
  const success = await store.saveSingleWidget(props.widget.id, {
    data: props.widget.data,
    enable: props.widget.enable,
  });
  if (!success) {
    alert("删除失败，请重试");
    await store.fetchData();
  }
};

const openUrl = (url: string) => {
  if (!url) return;

  // Security Rule: Intercept unlogged users
  if (!store.isLogged) {
    if (isInternalDomain(url)) {
      alert("为了您的安全，未登录状态下禁止访问内网资源");
      return;
    }
    const targetUrl = processSecurityUrl(url);
    window.location.href = targetUrl;
    return;
  }

  window.open(url, "_blank");
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
    class="w-full h-full rounded-2xl backdrop-blur border border-white/10 overflow-hidden flex flex-col text-white relative transition-shadow group"
    :style="{
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget.opacity ?? 0.35))})`,
      color: '#fff',
    }"
  >
    <div
      class="px-4 py-3 border-b border-white/10 flex justify-between items-center bg-white/10 shrink-0"
    >
      <div class="font-bold text-sm flex items-center gap-2 text-white">
        📑 收藏夹
      </div>
      <div class="flex-1 mx-4">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索书签..."
          class="w-full text-xs px-2 py-1 rounded-md border border-white/20 focus:outline-none focus:border-white/40 bg-white/10 text-white placeholder-white/50"
        />
      </div>
      <div
        v-if="store.isLogged"
        class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <input
          type="file"
          ref="fileInputRef"
          accept=".html,.htm,text/html"
          class="hidden"
          @change="handleFileUpload"
        />
        <button
          @click="triggerImport"
          class="text-xs bg-white/10 text-white/70 px-2 py-0.5 rounded hover:bg-white/20"
          title="导入浏览器收藏夹HTML"
        >
          导入
        </button>
        <button
          @click="addCategory"
          class="text-xs bg-white/10 text-white/70 px-2 py-0.5 rounded hover:bg-white/20"
        >
          + 分类
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-hide" @wheel="handleScrollIsolation">
      <div
        v-if="isAddingCategory"
        class="mb-4 p-3 bg-white/5 rounded-xl border border-white/10 animate-fade-in min-w-0 w-full"
      >
        <div class="text-xs font-bold text-white/80 mb-2">添加新分类</div>
        <div class="flex gap-2 items-center">
          <input
            ref="categoryInputRef"
            v-model="newCategoryTitle"
            placeholder="分类名称"
            class="min-w-0 flex-1 text-sm px-3 py-2 rounded-lg border bg-white/10 text-white placeholder-white/50 focus:outline-none focus:border-white/40"
            @keyup.enter="confirmAddCategory"
          />
          <button
            @click="confirmAddCategory"
            class="text-white text-xs px-4 py-2 rounded-lg hover:bg-white/30 whitespace-nowrap bg-white/20"
          >
            确定
          </button>
          <button
            @click="cancelAddCategory"
            class="text-white/70 text-xs px-4 py-2 rounded-lg hover:bg-white/20 whitespace-nowrap bg-white/10"
          >
            取消
          </button>
        </div>
      </div>

      <div v-for="cat in filteredData" :key="cat.id">
        <div class="flex items-center justify-between mb-2 group/cat border-b border-white/10 pb-1">
          <span
            class="font-bold text-sm flex items-center gap-1 cursor-pointer select-none text-white/70"
            @click="toggleCategory(cat)"
          >
            <span
              class="transform transition-transform text-xs"
              :class="cat.collapsed ? '-rotate-90' : ''"
              >▼</span
            >
            {{ cat.title }}
          </span>
          <div
            v-if="store.isLogged"
            class="flex gap-2 opacity-0 group-hover/cat:opacity-100 transition-opacity"
          >
            <button
              @click="startAdd($event, cat)"
              class="text-white/70 hover:text-white text-xs font-bold"
            >
              + 添加
            </button>
            <button
              @click.stop="deleteItem(cat.id)"
              class="text-white/50 hover:text-white/80 text-xs"
            >
              删除分类
            </button>
          </div>
        </div>

        <div v-if="!cat.collapsed" class="flex flex-col gap-1">
          <VueDraggable
            v-model="cat.children"
            :animation="150"
            :group="{ name: 'bookmarks', pull: true, put: true }"
            handle=".drag-handle"
            @end="onBookmarkDragEnd"
            :disabled="!isBookmarkDraggable"
          >
            <div
              v-for="link in cat.children"
              :key="link.id"
              class="flex items-center gap-2 px-2 py-1.5 hover:bg-white/10 rounded-lg cursor-pointer transition-all group/link border border-transparent hover:border-white/10"
              :class="{ 'cursor-grab': store.isLogged, 'dragging': false }"
              @click.stop="openUrl('url' in link ? (link as BookmarkItem).url : '')"
              :title="`${link.title}\n${'url' in link ? (link as BookmarkItem).url : ''}`"
            >
              <div
                v-if="store.isLogged"
                class="drag-handle w-3 h-5 flex items-center justify-center shrink-0 cursor-grab text-white/30 hover:text-white/60"
              >
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                  <circle cx="7" cy="4" r="1.5"/>
                  <circle cx="13" cy="4" r="1.5"/>
                  <circle cx="7" cy="10" r="1.5"/>
                  <circle cx="13" cy="10" r="1.5"/>
                  <circle cx="7" cy="16" r="1.5"/>
                  <circle cx="13" cy="16" r="1.5"/>
                </svg>
              </div>
              <div
                class="w-5 h-5 rounded bg-white/10 flex items-center justify-center shrink-0 overflow-hidden border border-white/10"
              >
                <img
                  :src="store.getAssetUrl('url' in link ? (link as BookmarkItem).icon || '' : '')"
                  class="w-4 h-4 object-cover"
                  @error="('url' in link) && ((link as BookmarkItem).icon = 'https://www.favicon.vip/get.php?url=unknown')"
                />
              </div>

              <div class="min-w-0 flex-1">
                <span
                  class="block font-medium text-xs truncate text-white/80 group-hover:text-white leading-5"
                  >{{ link.title }}</span
                >
              </div>

              <div
                v-if="store.isLogged && 'url' in link"
                class="flex gap-0.5 ml-auto pl-1 opacity-0 group-hover/link:opacity-100 transition-opacity"
              >
                <button
                  @click.stop="startEdit($event, cat, link as BookmarkItem)"
                  class="text-white/60 hover:text-white px-1 py-0.5 text-xs"
                  title="编辑"
                >
                  ✎
                </button>
                <button
                  @click.stop="deleteItem(cat.id, link.id)"
                  class="text-white/50 hover:text-white/80 px-1 py-0.5 text-xs"
                  title="删除"
                >
                  ×
                </button>
              </div>
            </div>
          </VueDraggable>

          <div
            v-if="(cat.children || []).length === 0 && activeCategoryId !== cat.id"
            class="text-sm text-white/50 py-2 px-4 border border-dashed border-white/10 rounded-lg select-none"
          >
            (空文件夹)
          </div>
        </div>
      </div>
    </div>
  </div>
  <OverlayMotion
    :show="!!activeCategory"
    :z-index="9999"
    variant="popover"
    panel-class="fixed p-4 bg-black/60 backdrop-blur rounded-xl border border-white/10 shadow-xl text-white w-[320px]"
    :panel-style="{ top: popupPos.y + 'px', left: popupPos.x + 'px' }"
  >
    <div>
      <div class="text-xs font-bold text-white/80 mb-2">
        {{ editingLinkId ? "编辑书签" : "添加新书签" }}
      </div>
      <div class="grid grid-cols-1 gap-3 mb-3">
        <div class="flex gap-2">
          <input
            v-model="newUrl"
            placeholder="网址 (例如: www.example.com)"
            class="flex-1 text-sm px-3 py-2 rounded-lg border bg-white/10 text-white placeholder-white/50 focus:bg-white/10 outline-none transition-all"
            @blur="autoFetchIcon"
          />
          <button
            @click="autoFetchIcon"
            :disabled="isFetching"
            class="px-3 bg-white/10 text-white/80 text-xs rounded-lg font-bold hover:bg-white/20 transition-colors flex items-center gap-1"
            title="自动获取标题和图标"
          >
            <span
              v-if="isFetching"
              class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
            ></span>
            {{ isFetching ? "获取中" : "⚡" }}
          </button>
        </div>
        <input
          v-model="newTitle"
          placeholder="标题 (自动获取)"
          class="w-full text-sm px-3 py-2 rounded-lg border bg-white/10 text-white placeholder-white/50 focus:bg-white/10 outline-none transition-all"
        />
        <div class="flex gap-2 items-center">
          <div
            class="w-8 h-8 rounded bg-white/10 flex items-center justify-center border border-white/10 overflow-hidden shrink-0"
          >
            <img
              v-if="newIcon"
              :src="store.getAssetUrl(newIcon)"
              class="w-full h-full object-cover"
            />
            <span v-else class="text-xs text-white/40">icon</span>
          </div>
          <input
            v-model="newIcon"
            placeholder="图标地址 (自动获取)"
            class="flex-1 text-sm px-3 py-2 rounded-lg border bg-white/10 text-white placeholder-white/50 focus:bg-white/10 outline-none transition-all"
          />
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-white/10 pt-3">
        <button
          @click="cancelEdit"
          class="text-sm text-white/70 hover:bg-white/10 px-3 py-1.5 rounded transition-colors"
        >
          取消
        </button>
        <button
          @click="confirmSubmit"
          class="text-sm bg-white/20 text-white px-4 py-1.5 rounded hover:bg-white/30 shadow-md transition-all"
        >
          {{ editingLinkId ? "保存" : "添加" }}
        </button>
      </div>
    </div>
  </OverlayMotion>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
</style>
