<script setup lang="ts">
import { ref, onMounted, computed, watch, onBeforeUnmount } from "vue";
import { useMainStore } from "../stores/main";
import { VueDraggable } from "vue-draggable-plus";
import { cacheImage, getCachedImage } from "@/utils/imageCache";
import { v4 as uuidv4 } from "uuid";
import { acquireObjectUrl, releaseObjectUrl } from "@/utils/objectUrlRuntime";
import OverlayMotion from "@/components/base/OverlayMotion.vue";

const props = defineProps<{
  show: boolean;
  title?: string;
}>();

const emit = defineEmits(["update:show", "select"]);
const store = useMainStore();

/** GET / multipart：只带 Bearer，不设 Content-Type（避免破坏 FormData） */
const authHeadersOnly = (): Record<string, string> => {
  const h: Record<string, string> = {};
  const t = store.token || localStorage.getItem("flat-nas-token");
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
};

const activeTab = ref<"pc" | "mobile" | "api">("pc");
const wallpapers = computed<string[]>({
  get: () => store.wallpaperListPc,
  set: (val) => {
    store.wallpaperListPc = [...val];
  },
});
const mobileWallpapers = computed<string[]>({
  get: () => store.wallpaperListMobile,
  set: (val) => {
    store.wallpaperListMobile = [...val];
  },
});
const loading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const wallpaperPreviewErrors = ref<Record<string, string>>({});
let removeErrorTimer: ReturnType<typeof setTimeout> | null = null;

// Confirm Modal State
const showConfirmModal = ref(false);
const confirmMessage = ref("");
const confirmAction = ref<() => void>(() => {});

const closeConfirmModal = () => {
  showConfirmModal.value = false;
};

const handleConfirm = () => {
  confirmAction.value();
  closeConfirmModal();
};

const DEFAULT_WALLPAPER = "default-wallpaper.svg";

const fetchWallpapers = async () => {
  loading.value = true;
  try {
    await store.fetchWallpaperLists();
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
};

const stripTransientQueryParams = (url: string) => {
  if (!url) return "";
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.delete("t");
    parsed.searchParams.delete("v");
    if (/^https?:\/\//.test(url)) {
      return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.replace(/([?&])(t|v)=\d+/g, "$1").replace(/[?&]$/, "");
  }
};

const getWallpaperPath = (name: string, type: "pc" | "mobile") => {
  if (name === DEFAULT_WALLPAPER) {
    return `/${DEFAULT_WALLPAPER}`;
  }
  const base =
    type === "pc"
      ? store.appConfig.wallpaperPcImageBase || "/backgrounds"
      : store.appConfig.wallpaperMobileImageBase || "/mobile_backgrounds";
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${encodeURIComponent(name)}`;
};

const getWallpaperDisplayUrl = (name: string, type: "pc" | "mobile") =>
  store.getAssetUrl(getWallpaperPath(name, type));

const selectWallpaper = (name: string, type: "pc" | "mobile") => {
  if (setWallpaper(name, type)) {
    const url = getWallpaperDisplayUrl(name, type);
    emit("select", { url, type });
    emit("update:show", false);
  }
};

const setWallpaper = (name: string, type: "pc" | "mobile") => {
  const url = getWallpaperPath(name, type);
  if (type === "pc") {
    store.appConfig.background = url;
  } else {
    store.appConfig.mobileBackground = url;
  }
  return true;
};

const prependWallpaperToList = (name: string, type: "pc" | "mobile") => {
  if (!name || name === DEFAULT_WALLPAPER) return;
  const currentList = type === "pc" ? wallpapers.value : mobileWallpapers.value;
  const nextList = [
    DEFAULT_WALLPAPER,
    name,
    ...currentList.filter((item) => item !== DEFAULT_WALLPAPER && item !== name),
  ];
  if (type === "pc") {
    wallpapers.value = nextList;
    store.appConfig.pcWallpaperOrder = nextList;
  } else {
    mobileWallpapers.value = nextList;
    store.appConfig.mobileWallpaperOrder = nextList;
  }
};

const inferImageExtension = (blob: Blob, urlHint: string) => {
  const mime = (blob.type || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("avif")) return "avif";

  const normalizedHint = stripTransientQueryParams(urlHint);
  const matched = normalizedHint.match(/\.([a-zA-Z0-9]+)$/);
  if (matched?.[1]) {
    return matched[1].toLowerCase();
  }
  return "jpg";
};

const getWallpaperErrorKey = (name: string, type: "pc" | "mobile") => `${type}:${name}`;

const getWallpaperPreviewError = (name: string, type: "pc" | "mobile") =>
  wallpaperPreviewErrors.value[getWallpaperErrorKey(name, type)] || "";

const clearWallpaperPreviewError = (name: string, type: "pc" | "mobile") => {
  const key = getWallpaperErrorKey(name, type);
  if (!wallpaperPreviewErrors.value[key]) return;
  const next = { ...wallpaperPreviewErrors.value };
  delete next[key];
  wallpaperPreviewErrors.value = next;
};

const handleWallpaperPreviewError = (
  name: string,
  type: "pc" | "mobile",
  event: Event,
) => {
  const img = event.target as HTMLImageElement | null;
  const attemptedUrl = img?.currentSrc || img?.src || getWallpaperDisplayUrl(name, type);
  wallpaperPreviewErrors.value = {
    ...wallpaperPreviewErrors.value,
    [getWallpaperErrorKey(name, type)]: attemptedUrl,
  };
  
  if (name !== DEFAULT_WALLPAPER) {
    if (removeErrorTimer) clearTimeout(removeErrorTimer);
    removeErrorTimer = setTimeout(() => {
      const list = type === "pc" ? wallpapers.value : mobileWallpapers.value;
      const index = list.indexOf(name);
      if (index > -1) {
        list.splice(index, 1);
        if (type === "pc") {
          wallpapers.value = [...wallpapers.value];
          store.appConfig.pcWallpaperOrder = [...wallpapers.value];
        } else {
          mobileWallpapers.value = [...mobileWallpapers.value];
          store.appConfig.mobileWallpaperOrder = [...mobileWallpapers.value];
        }
        store.markDirty();
      }
      removeErrorTimer = null;
    }, 1000);
  }
};

const draggableList = computed({
  get() {
    const list = activeTab.value === "pc" ? [...wallpapers.value] : [...mobileWallpapers.value];
    const currentBg =
      activeTab.value === "pc" ? store.appConfig.background : store.appConfig.mobileBackground;

    const type: "pc" | "mobile" = activeTab.value === "pc" ? "pc" : "mobile";
    const normalizedCurrentBg = stripTransientQueryParams(currentBg || "");
    const index = list.findIndex((name) => getWallpaperPath(name, type) === normalizedCurrentBg);
    if (index > -1) {
      const [item] = list.splice(index, 1);
      if (item) list.unshift(item);
    }
    return list;
  },
  set(val) {
    if (activeTab.value === "pc") {
      wallpapers.value = val;
      store.appConfig.pcWallpaperOrder = val;
    } else {
      mobileWallpapers.value = val;
      store.appConfig.mobileWallpaperOrder = val;
    }

    const first = val[0];
    if (first) {
      const type: "pc" | "mobile" = activeTab.value === "pc" ? "pc" : "mobile";
      const currentBg =
        type === "pc" ? store.appConfig.background : store.appConfig.mobileBackground;
      const firstUrl = getWallpaperPath(first, type);

      if (firstUrl !== stripTransientQueryParams(currentBg || "")) {
        setWallpaper(first, type);
      }
    }
  },
});

const triggerUpload = () => {
  fileInput.value?.click();
};

const pendingFiles = ref<File[]>([]);

const handleUpload = (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;

  pendingFiles.value = Array.from(input.files);

  // Check file size
  const hasLargeFile = pendingFiles.value.some((f) => f.size > 10 * 1024 * 1024);

  if (hasLargeFile) {
    confirmMessage.value = "检测到文件超过 10MB，可能导致内存占用过高，是否继续上传？";
    confirmAction.value = executeUpload;
    showConfirmModal.value = true;
  } else {
    executeUpload();
  }

  // Clear input so same file can be selected again
  input.value = "";
};

const executeUpload = async () => {
  if (pendingFiles.value.length === 0) return;

  uploading.value = true;
  const formData = new FormData();
  pendingFiles.value.forEach((file) => {
    formData.append("files", file);
  });

  // Determine endpoint based on active tab
  const endpoint =
    activeTab.value === "pc"
      ? store.appConfig.wallpaperApiPcUpload || "/api/backgrounds/upload"
      : store.appConfig.wallpaperApiMobileUpload || "/api/mobile_backgrounds/upload";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: authHeadersOnly(),
      body: formData,
    });

    if (res.ok) {
      await fetchWallpapers();
      store.refreshResources(); // 刷新资源版本号，更新图片缓存
    } else {
      alert("上传失败");
    }
  } catch (e) {
    console.error(e);
    alert("上传出错");
  } finally {
    uploading.value = false;
    pendingFiles.value = [];
  }
};

const handleDelete = (name: string, type: "pc" | "mobile") => {
  if (name === DEFAULT_WALLPAPER) {
    alert("默认壁纸无法删除");
    return;
  }
  confirmMessage.value = "确定要删除这张壁纸吗？";
  confirmAction.value = () => executeDelete(name, type);
  showConfirmModal.value = true;
};

const executeDelete = async (name: string, type: "pc" | "mobile") => {
  // Check if active wallpaper is being deleted
  const url = getWallpaperPath(name, type);
  const currentBg = stripTransientQueryParams(
    type === "pc" ? store.appConfig.background : store.appConfig.mobileBackground,
  );

  if (url === currentBg) {
    // Reset to default
    const defaultUrl = getWallpaperPath(DEFAULT_WALLPAPER, type);
    if (type === "pc") store.appConfig.background = defaultUrl;
    else store.appConfig.mobileBackground = defaultUrl;
  }

  const base =
    type === "pc"
      ? store.appConfig.wallpaperApiPcDeleteBase || "/api/backgrounds"
      : store.appConfig.wallpaperApiMobileDeleteBase || "/api/mobile_backgrounds";
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const endpoint = `${trimmed}/${encodeURIComponent(name)}`;

  try {
    const res = await fetch(endpoint, {
      method: "DELETE",
      headers: store.getHeaders(),
    });

    if (res.ok) {
      await fetchWallpapers();
      store.refreshResources();
    } else {
      alert("删除失败");
    }
  } catch (e) {
    console.error(e);
  }
};

// Rotation Logic Helpers
const currentRotationEnabled = computed({
  get: () =>
    activeTab.value === "pc" ? store.appConfig.pcRotation : store.appConfig.mobileRotation,
  set: (val) => {
    if (activeTab.value === "pc") store.appConfig.pcRotation = val;
    else store.appConfig.mobileRotation = val;
  },
});

const currentRotationInterval = computed({
  get: () =>
    activeTab.value === "pc"
      ? (store.appConfig.pcRotationInterval ?? 30)
      : (store.appConfig.mobileRotationInterval ?? 30),
  set: (val) => {
    if (activeTab.value === "pc") store.appConfig.pcRotationInterval = val;
    else store.appConfig.mobileRotationInterval = val;
  },
});

const currentRotationMode = computed({
  get: () =>
    activeTab.value === "pc"
      ? (store.appConfig.pcRotationMode ?? "random")
      : (store.appConfig.mobileRotationMode ?? "random"),
  set: (val) => {
    if (activeTab.value === "pc") store.appConfig.pcRotationMode = val;
    else store.appConfig.mobileRotationMode = val;
  },
});

const isWallpaperLocked = computed(
  () => !store.appConfig.pcRotation && !store.appConfig.mobileRotation,
);

const toggleRotation = () => {
  currentRotationEnabled.value = !currentRotationEnabled.value;
};

const togglePlayMode = () => {
  currentRotationMode.value = currentRotationMode.value === "random" ? "sequential" : "random";
};

const stopAndLockRotation = () => {
  store.appConfig.pcRotation = false;
  store.appConfig.mobileRotation = false;
};

const lockButtonLabel = computed(() =>
  isWallpaperLocked.value ? "已锁定" : "停止并锁定",
);

const customApiUrl = ref("");
const currentGeneratorUrl = ref("");
const resolvingUrl = ref(false);
const previewBlob = ref<Blob | null>(null);
const previewResolvedUrl = ref("");
const previewDisplayUrl = ref("");
const previewSourceUrl = ref("");
const previewRequestId = ref(0);
const previewObjectUrl = ref("");
const previewKey = "wallpaper-preview";

const presetApis = [
  {
    name: "Bing 每日壁纸",
    url: "https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN",
    autoUpdate: true,
  },
  { name: "随机风景 (Picsum)", url: "https://picsum.photos/1920/1080", autoUpdate: false },
  { name: "随机二次元 (PC)", url: "https://www.loliapi.com/acg/pc/", autoUpdate: false },
  { name: "随机二次元 (PE)", url: "https://www.loliapi.com/acg/pe/", autoUpdate: false },
];

const setPreviewUrl = (url: string) => {
  if (previewObjectUrl.value) {
    releaseObjectUrl(previewKey, true);
    previewObjectUrl.value = "";
  }
  previewDisplayUrl.value = url;
  if (url.startsWith("blob:")) {
    previewObjectUrl.value = url;
  }
};

const setPreviewBlob = (blob: Blob) => {
  const url = acquireObjectUrl(previewKey, blob);
  previewBlob.value = blob;
  setPreviewUrl(url);
};

const cleanupPreview = () => {
  if (previewObjectUrl.value) {
    releaseObjectUrl(previewKey, true);
    previewObjectUrl.value = "";
  }
  previewBlob.value = null;
  previewResolvedUrl.value = "";
  previewDisplayUrl.value = "";
};

watch(customApiUrl, (nextUrl) => {
  const normalized = nextUrl.trim();
  if (!normalized) {
    currentGeneratorUrl.value = "";
    previewSourceUrl.value = "";
    cleanupPreview();
    return;
  }
  if (normalized !== previewSourceUrl.value) {
    currentGeneratorUrl.value = "";
    cleanupPreview();
  }
});

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      fetchWallpapers();
      return;
    }
    cleanupPreview();
  },
);

const fetchPreviewImage = async (url: string, options?: { forceRefresh?: boolean }) => {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return;
  const forceRefresh = !!options?.forceRefresh;
  const cleanSourceUrl = stripTransientQueryParams(normalizedUrl);
  const requestUrl = forceRefresh
    ? `${cleanSourceUrl}${cleanSourceUrl.includes("?") ? "&" : "?"}v=${Date.now()}`
    : cleanSourceUrl;
  currentGeneratorUrl.value = normalizedUrl;
  previewSourceUrl.value = normalizedUrl;
  const requestId = ++previewRequestId.value;
  resolvingUrl.value = true;
  cleanupPreview();

  try {
    if (!forceRefresh) {
      const cachedBlob = await getCachedImage(cleanSourceUrl);
      if (requestId !== previewRequestId.value) return;
      if (cachedBlob) {
        previewResolvedUrl.value = cleanSourceUrl;
        setPreviewBlob(cachedBlob);
        resolvingUrl.value = false;
        return;
      }
    }
  } catch (e) {
    console.warn("Cache lookup failed", e);
  }

  // 2. Try Proxy (Preferred for consistency)
  try {
    const uuid = uuidv4();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(
      `/api/wallpaper/proxy?url=${encodeURIComponent(requestUrl)}&uuid=${uuid}`,
      {
        signal: controller.signal,
        headers: authHeadersOnly(),
      },
    );
    clearTimeout(timeoutId);

    if (requestId !== previewRequestId.value) return;
    if (res.ok) {
      const blob = await res.blob();
      await cacheImage(cleanSourceUrl, blob, res.headers.get("ETag") || undefined);
      previewResolvedUrl.value = requestUrl;
      setPreviewBlob(blob);
      resolvingUrl.value = false;
      return;
    }
  } catch (e) {
    console.warn("Proxy fetch failed, falling back to direct URL", e);
  }

  // 3. Fallback to Direct URL (Resolve Redirects)
  try {
    const res = await fetch("/api/wallpaper/resolve", {
      method: "POST",
      headers: store.getHeaders(),
      body: JSON.stringify({ url: requestUrl }),
    });
    if (requestId !== previewRequestId.value) return;
    const resolvedUrl = res.ok ? (await res.json()).url : requestUrl;
    previewResolvedUrl.value = resolvedUrl;
    try {
      const proxyRes = await fetch(
        `/api/wallpaper/proxy?url=${encodeURIComponent(resolvedUrl)}&uuid=${requestId}`,
        { headers: authHeadersOnly() },
      );
      if (requestId !== previewRequestId.value) return;
      if (proxyRes.ok) {
        const blob = await proxyRes.blob();
        setPreviewBlob(blob);
        return;
      }
    } catch (e) {
      console.warn("Resolve proxy fetch failed, using URL preview", e);
    }
    previewBlob.value = null;
    setPreviewUrl(resolvedUrl);
  } catch {
    if (requestId !== previewRequestId.value) return;
    previewBlob.value = null;
    previewResolvedUrl.value = requestUrl;
    setPreviewUrl(requestUrl);
  } finally {
    if (requestId === previewRequestId.value) {
      resolvingUrl.value = false;
    }
  }
};

const usePreset = async (url: string) => {
  customApiUrl.value = url;
  await fetchPreviewImage(url);
};

const handleRefresh = () => {
  const url = customApiUrl.value.trim() || currentGeneratorUrl.value;
  if (url) {
    fetchPreviewImage(stripTransientQueryParams(url), { forceRefresh: true });
  }
};

const applyingApi = ref(false);

const applyCustomApi = async (type: "pc" | "mobile", apply: boolean = true) => {
  const sourceUrl = customApiUrl.value.trim() || currentGeneratorUrl.value;
  if (!sourceUrl) return;

  applyingApi.value = true;
  try {
    let backgroundPath = "";
    let uploadedFilename = "";

    const getPreviewBlob = async () => {
      if (resolvingUrl.value) {
        for (let i = 0; i < 20 && resolvingUrl.value; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const tryDirectFetch = async (url: string) => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) return null;
          const blob = await res.blob();
          setPreviewBlob(blob);
          return blob;
        } catch {
          return null;
        }
      };
      if (previewBlob.value) return previewBlob.value;
      if (!previewResolvedUrl.value && !previewDisplayUrl.value && sourceUrl) {
        await fetchPreviewImage(sourceUrl);
      }
      if (previewBlob.value) return previewBlob.value;
      const urlToFetch =
        previewResolvedUrl.value ||
        stripTransientQueryParams(currentGeneratorUrl.value) ||
        stripTransientQueryParams(sourceUrl);
      if (urlToFetch) {
        const proxyRes = await fetch(
          `/api/wallpaper/proxy?url=${encodeURIComponent(urlToFetch)}&uuid=apply`,
          { headers: authHeadersOnly() },
        );
        if (proxyRes.ok) {
          const blob = await proxyRes.blob();
          previewResolvedUrl.value = urlToFetch;
          setPreviewBlob(blob);
          return blob;
        }
        const directBlob = await tryDirectFetch(urlToFetch);
        if (directBlob) return directBlob;
      }
      if (urlToFetch && urlToFetch.startsWith("http")) {
        const separator = urlToFetch.includes("?") ? "&" : "?";
        const timestampedUrl = `${urlToFetch}${separator}v=${Date.now()}`;
        const res = await fetch("/api/wallpaper/resolve", {
          method: "POST",
          headers: store.getHeaders(),
          body: JSON.stringify({ url: timestampedUrl }),
        });
        if (res.ok) {
          const data = await res.json();
          previewResolvedUrl.value = data.url;
          const proxyRes = await fetch(
            `/api/wallpaper/proxy?url=${encodeURIComponent(data.url)}&uuid=apply-resolve`,
            { headers: authHeadersOnly() },
          );
          if (proxyRes.ok) {
            const blob = await proxyRes.blob();
            setPreviewBlob(blob);
            return blob;
          }
          const directBlob = await tryDirectFetch(data.url);
          if (directBlob) return directBlob;
        }
      }
      if (customApiUrl.value.startsWith("blob:")) {
        const blob = await fetch(customApiUrl.value).then((r) => r.blob());
        setPreviewBlob(blob);
        return blob;
      }
      return null;
    };

    const blob = await getPreviewBlob();

    if (blob) {
      if (apply && type === "pc") {
        document.body.style.backgroundImage = `url(${previewDisplayUrl.value || sourceUrl})`;
      }

      const formData = new FormData();
      // Generate filename based on type and timestamp
      const ext = inferImageExtension(
        blob,
        previewResolvedUrl.value || currentGeneratorUrl.value || sourceUrl,
      );
      const filename = `blob_${Date.now()}.${ext}`;
      formData.append("files", blob, filename);
      
      const endpoint = type === "pc" 
        ? (store.appConfig.wallpaperApiPcUpload || "/api/backgrounds/upload")
        : (store.appConfig.wallpaperApiMobileUpload || "/api/mobile_backgrounds/upload");

      const uploadRes = await fetch(endpoint, {
        method: "POST",
        headers: authHeadersOnly(),
        body: formData,
      });
      
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        if (uploadData.success && uploadData.files && uploadData.files.length > 0) {
          backgroundPath = uploadData.files[0].path;
          uploadedFilename = uploadData.files[0].filename || "";
        } else {
          throw new Error("Upload failed: No path returned");
        }
      } else {
        throw new Error("Upload failed: " + uploadRes.statusText);
      }
    } else {
      throw new Error("No preview image available");
    }

    // Now apply configuration
    if (apply) {
      const preset = presetApis.find(
        (p) => p.url === currentGeneratorUrl.value || p.url === sourceUrl,
      );
      const enableScheduler = preset ? preset.autoUpdate : false;
      const urlToSave = enableScheduler ? (currentGeneratorUrl.value || sourceUrl) : backgroundPath;

      const config = {
        type: "api" as const,
        url: urlToSave,
        enabled: !!enableScheduler,
        lastUpdated: Date.now(),
      };

      if (type === "pc") {
        store.appConfig.background = backgroundPath; // Use the server path
        store.appConfig.wallpaperConfig = config;
      } else { 
        store.appConfig.mobileBackground = backgroundPath;
        store.appConfig.mobileWallpaperConfig = config;
      }
      if (uploadedFilename) {
        prependWallpaperToList(uploadedFilename, type);
      }
      store.refreshResources();
      store.markDirty();
      alert("设置成功");
    } else {
      if (uploadedFilename) {
        prependWallpaperToList(uploadedFilename, type);
      }
      await fetchWallpapers();
      if (uploadedFilename) {
        prependWallpaperToList(uploadedFilename, type);
      }
      store.refreshResources();
      activeTab.value = type;
      alert(type === "pc" ? "已保存到 PC 壁纸库" : "已保存到手机壁纸库");
    }
  } catch (e) {
    console.error(e);
    alert("请求出错，请检查网络");
    // Fallback logic as requested: "Failure -> Default icon"
    if (type === "pc") {
      store.appConfig.background = `/${DEFAULT_WALLPAPER}`;
    }
  } finally {
    applyingApi.value = false;
  }
};

onMounted(() => {
  fetchWallpapers();
  if (store.appConfig.background?.startsWith("http")) {
    previewSourceUrl.value = store.appConfig.background;
    customApiUrl.value = store.appConfig.background;
    previewResolvedUrl.value = store.appConfig.background;
    setPreviewUrl(store.appConfig.background);
  }
});

onBeforeUnmount(() => {
  if (removeErrorTimer) {
    clearTimeout(removeErrorTimer);
    removeErrorTimer = null;
  }
  cleanupPreview();
});
</script>

<template>
  <OverlayMotion
    :show="show"
    :z-index="100"
    close-on-overlay
    overlay-class="bg-black/50 backdrop-blur-sm"
    panel-class="w-full md:max-w-5xl h-full md:h-[85vh]"
    @close="$emit('update:show', false)"
  >
    <div class="bg-white md:rounded-2xl shadow-2xl w-full h-full flex flex-col overflow-hidden">
        <!-- Header -->
        <div
          class="px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:px-6 md:py-4 border-b border-gray-100 flex justify-between items-center bg-white"
        >
          <div class="flex items-center gap-4">
            <h3 class="text-lg font-bold text-gray-800">
              {{ title || "壁纸库" }}
            </h3>

            <div class="flex items-center bg-gray-100 rounded-lg p-1">
              <button
                @click="activeTab = 'pc'"
                class="px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2"
                :class="
                  activeTab === 'pc'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                "
              >
                PC 壁纸
                <span class="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[10px]">{{
                  wallpapers.length
                }}</span>
              </button>
              <button
                @click="activeTab = 'mobile'"
                class="px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2"
                :class="
                  activeTab === 'mobile'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                "
              >
                手机壁纸
                <span class="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[10px]">{{
                  mobileWallpapers.length
                }}</span>
              </button>
              <button
                @click="activeTab = 'api'"
                class="px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2"
                :class="
                  activeTab === 'api'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                "
              >
                API 接口
              </button>
            </div>
          </div>

          <button
            @click="$emit('update:show', false)"
            class="w-8 h-8 rounded-full bg-red-100 hover:bg-red-200 flex items-center justify-center text-red-500 hover:text-red-900 transition-colors"
          >
            ✕
          </button>
        </div>

        <!-- Toolbar -->
        <div
          class="px-4 py-3 md:px-6 bg-white border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 md:gap-0"
        >
          <div class="text-xs text-gray-400 hidden md:block">请拖动选择</div>
          <div class="flex flex-wrap gap-2 md:gap-3 items-center w-full md:w-auto">
            <!-- Rotation Controls -->
            <div
              class="flex items-center gap-2 mr-2 bg-gray-50 p-1 rounded-lg border border-gray-100"
            >
              <button
                @click="togglePlayMode"
                class="px-2 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1"
                :class="
                  currentRotationMode === 'random'
                    ? 'text-purple-600 bg-purple-50'
                    : 'text-blue-600 bg-blue-50'
                "
                :title="
                  currentRotationMode === 'random'
                    ? '播放方式：随机（仅轮播开启后生效）'
                    : '播放方式：顺序（仅轮播开启后生效）'
                "
              >
                <span>{{ currentRotationMode === "random" ? "随机" : "顺播" }}</span>
              </button>
              <div class="h-4 w-px bg-gray-300"></div>
              <div class="flex items-center gap-1 px-1">
                <button
                  @click="toggleRotation"
                  class="text-xs font-medium transition-colors flex items-center gap-1 px-2 py-1 rounded"
                  :class="
                    currentRotationEnabled
                      ? 'bg-green-100 text-green-700'
                      : 'text-gray-600 hover:bg-white'
                  "
                >
                  <span>{{ currentRotationEnabled ? "轮播中" : "开启轮播" }}</span>
                </button>
                <input
                  v-if="!currentRotationEnabled"
                  type="number"
                  v-model="currentRotationInterval"
                  min="5"
                  class="w-10 text-xs border border-gray-200 rounded px-1 py-0.5 text-center outline-none focus:border-blue-500"
                  title="轮播间隔(分钟)"
                />
                <span v-if="!currentRotationEnabled" class="text-[10px] text-gray-400">分</span>
              </div>
            </div>

            <!-- Lock Wallpaper Button -->
            <button
              @click="stopAndLockRotation"
              class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1 shadow-sm"
              :class="
                isWallpaperLocked
                  ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-blue-200'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              "
              title="锁定当前壁纸（会停止 PC 与手机端自动轮播）"
            >
              <span>{{ lockButtonLabel }}</span>
            </button>

            <div
              v-if="activeTab === 'pc'"
              class="flex items-center gap-2 mr-2 bg-gray-50 p-1 rounded-lg border border-gray-100"
            >
              <div class="flex items-center gap-1 px-1">
                <span class="text-[13px] text-gray-500">模糊</span>
                <input
                  type="range"
                  v-model.number="store.appConfig.backgroundBlur"
                  min="0"
                  max="20"
                  step="1"
                  class="w-16 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  title="模糊半径"
                />
              </div>
              <div class="w-px h-3 bg-gray-300"></div>
              <div class="flex items-center gap-1 px-1">
                <span class="text-[13px] text-gray-500">遮罩</span>
                <input
                  type="range"
                  v-model.number="store.appConfig.backgroundMask"
                  min="0"
                  max="1"
                  step="0.1"
                  class="w-16 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  title="遮罩浓度"
                />
              </div>
            </div>

            <div
              v-if="activeTab === 'mobile'"
              class="flex items-center gap-2 mr-2 bg-gray-50 p-1 rounded-lg border border-gray-100"
            >
              <div class="flex items-center gap-1 px-1">
                <span class="text-[13px] text-gray-500">模糊</span>
                <input
                  type="range"
                  v-model.number="store.appConfig.mobileBackgroundBlur"
                  min="0"
                  max="20"
                  step="1"
                  class="w-16 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  title="模糊半径"
                />
              </div>
              <div class="w-px h-3 bg-gray-300"></div>
              <div class="flex items-center gap-1 px-1">
                <span class="text-[13px] text-gray-500">遮罩</span>
                <input
                  type="range"
                  v-model.number="store.appConfig.mobileBackgroundMask"
                  min="0"
                  max="1"
                  step="0.1"
                  class="w-16 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  title="遮罩浓度"
                />
              </div>
            </div>

            <button
              v-if="activeTab === 'mobile'"
              @click="
                store.appConfig.enableMobileWallpaper = !store.appConfig.enableMobileWallpaper
              "
              class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1 shadow-sm"
              :class="
                store.appConfig.enableMobileWallpaper
                  ? 'bg-green-500 text-white hover:bg-green-600 shadow-green-200'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              "
              title="开启后，手机端将优先使用手机壁纸；关闭后，手机端将使用 PC 端壁纸"
            >
              <span>{{
                store.appConfig.enableMobileWallpaper ? "已启用手机壁纸" : "启用手机壁纸"
              }}</span>
            </button>

            <button
              @click="fetchWallpapers"
              class="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors flex items-center gap-1"
            >
              刷新
            </button>
            <button
              @click="triggerUpload"
              class="px-4 py-1.5 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm shadow-blue-200 transition-all flex items-center gap-1"
              :disabled="uploading"
            >
              <span v-if="uploading">上传中...</span>
              <span v-else>上传壁纸</span>
            </button>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              multiple
              class="hidden"
              @change="handleUpload"
            />
          </div>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto p-6 bg-gray-50">
          <!-- Resolving/Loading overlay for API tab -->
          <div
            v-if="resolvingUrl"
            class="absolute inset-x-0 top-[120px] bottom-0 z-50 bg-white/60 backdrop-blur-[2px] flex flex-col items-center justify-center text-blue-600 gap-3"
          >
            <div
              class="w-10 h-10 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin"
            ></div>
            <span class="text-sm font-bold bg-white/80 px-4 py-1.5 rounded-full shadow-sm"
              >正在通过代理获取并优化壁纸一致性...</span
            >
          </div>

          <div
            v-if="loading"
            class="h-full flex flex-col items-center justify-center text-gray-400"
          >
            <div
              class="w-8 h-8 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-2"
            ></div>
            <span class="text-xs">加载中...</span>
          </div>

          <div
            v-else-if="
              (activeTab === 'pc' && wallpapers.length === 0) ||
              (activeTab === 'mobile' && mobileWallpapers.length === 0)
            "
            class="h-full flex flex-col items-center justify-center text-gray-400"
          >
            <span class="text-4xl mb-2">🖼️</span>
            <span class="text-sm">暂无壁纸，请先上传</span>
          </div>

          <VueDraggable
            v-else-if="activeTab !== 'api'"
            v-model="draggableList"
            class="grid gap-2 md:gap-4"
            :class="
              activeTab === 'pc'
                ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
                : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4'
            "
            :animation="150"
            :forceFallback="true"
          >
            <div
              v-for="(img, index) in draggableList"
              :key="img"
              class="group relative rounded-xl overflow-hidden cursor-grab border-2 border-transparent hover:border-blue-500 transition-all shadow-sm hover:shadow-md bg-white"
              :class="activeTab === 'pc' ? 'aspect-video' : 'aspect-[9/16]'"
            >
              <img
                :src="getWallpaperDisplayUrl(img, activeTab === 'pc' ? 'pc' : 'mobile')"
                v-show="!getWallpaperPreviewError(img, activeTab === 'pc' ? 'pc' : 'mobile')"
                class="w-full h-full object-cover transition-all duration-300 group-hover:scale-110"
                decoding="async"
                @load="clearWallpaperPreviewError(img, activeTab === 'pc' ? 'pc' : 'mobile')"
                @error="handleWallpaperPreviewError(img, activeTab === 'pc' ? 'pc' : 'mobile', $event)"
              />
              <div
                v-if="getWallpaperPreviewError(img, activeTab === 'pc' ? 'pc' : 'mobile')"
                class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center bg-red-50 text-red-500 border-2 border-red-200 border-dashed"
              >
                <span class="text-2xl">⚠️</span>
                <span class="text-xs font-medium">图片已失效</span>
                <span class="text-[10px] opacity-70">将自动移除</span>
                <div class="w-4 h-4 border-2 border-red-300 border-t-red-500 rounded-full animate-spin"></div>
              </div>

              <!-- Mask Overlay for index 0 (Removed for better preview clarity) -->
              <!-- <div
              v-if="index === 0"
              class="absolute inset-0 transition-all duration-300 pointer-events-none"
              :style="{
                backgroundColor: `rgba(0,0,0,${
                  activeTab === 'pc'
                    ? (store.appConfig.backgroundMask ?? 0)
                    : (store.appConfig.mobileBackgroundMask ?? 0)
                })`,
              }"
            ></div> -->

              <!-- Current Wallpaper Badge -->
              <div
                v-if="index === 0"
                class="absolute top-2 left-2 bg-green-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-sm z-10 flex items-center gap-1"
              >
                <span>默认壁纸</span>
              </div>

              <!-- Hover Overlay -->
              <div
                class="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors"
              ></div>

              <!-- Set as Default Overlay -->
              <div
                class="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-lg font-bold opacity-0 group-hover:opacity-100 transition-opacity z-10"
                @click="selectWallpaper(img, activeTab === 'pc' ? 'pc' : 'mobile')"
              >
                设为默认壁纸
              </div>

              <!-- Delete Button -->
              <button
                @click.stop="handleDelete(img, activeTab === 'pc' ? 'pc' : 'mobile')"
                class="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 shadow-sm z-20"
                title="删除"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </VueDraggable>

          <!-- API Management -->
          <div v-if="activeTab === 'api'" class="space-y-6 p-1">
            <div class="bg-blue-50 text-blue-800 p-4 rounded-xl text-sm leading-relaxed">
              <ul class="list-disc list-inside space-y-1">
                <li>在此处可以直接输入图片的 URL 地址，或使用第三方随机壁纸 API。</li>
                <li>
                  支持 <b>JSON 格式 API</b>（如 Unsplash/Bing），系统会自动解析并提取图片链接。
                </li>
                <li>支持 <b>局域网/自建 API</b>（如 http://192.168.x.x），不再受内网访问限制。</li>
              </ul>
              <div class="mt-2 text-xs opacity-80">
                设置后，每次刷新页面可能会根据 API 返回不同的图片（取决于 API 行为）。
              </div>
            </div>

            <div class="border border-gray-200 rounded-xl bg-white p-6 shadow-sm">
              <h4 class="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
                <span>🔗</span> 自定义壁纸接口
              </h4>

              <div class="space-y-4">
                <!-- Preview Area -->
                <div v-if="customApiUrl" class="grid grid-cols-2 gap-4">
                  <!-- PC Preview -->
                  <div class="space-y-2">
                    <div class="text-[10px] text-gray-500 text-center font-bold">PC 端预览</div>
                    <div
                      class="relative h-48 w-full rounded-lg overflow-hidden border border-gray-200 bg-gray-100 group"
                    >
                      <img
                        v-if="previewDisplayUrl"
                        :src="previewDisplayUrl"
                        class="w-full h-full object-cover transition-all duration-700"
                        :style="{
                          filter: `blur(${store.appConfig.backgroundBlur}px)`,
                        }"
                      />
                      <div
                        v-else
                        class="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
                      >
                        点击上方预设或刷新按钮获取预览
                      </div>
                      <!-- Mask Preview -->
                      <div
                        class="absolute inset-0 pointer-events-none transition-all duration-300"
                        :style="{
                          backgroundColor: `rgba(0,0,0,${store.appConfig.backgroundMask})`,
                        }"
                      ></div>
                    </div>

                    <!-- PC Controls -->
                    <div
                      class="bg-gray-50 p-2 rounded-lg border border-gray-100 flex items-center justify-center gap-4"
                    >
                      <div class="flex items-center gap-1">
                        <span class="text-[10px] text-gray-500">模糊</span>
                        <input
                          type="range"
                          v-model.number="store.appConfig.backgroundBlur"
                          min="0"
                          max="20"
                          step="1"
                          class="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                      <div class="w-px h-3 bg-gray-300"></div>
                      <div class="flex items-center gap-1">
                        <span class="text-[10px] text-gray-500">遮罩</span>
                        <input
                          type="range"
                          v-model.number="store.appConfig.backgroundMask"
                          min="0"
                          max="1"
                          step="0.1"
                          class="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                      <div class="w-px h-3 bg-gray-300"></div>
                      <button
                        @click="applyCustomApi('pc', false)"
                        class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        :disabled="!customApiUrl || applyingApi || resolvingUrl"
                        title="下载到 PC 壁纸库"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          class="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <!-- Mobile Preview -->
                  <div class="space-y-2">
                    <div class="text-[10px] text-gray-500 text-center font-bold">手机端预览</div>
                    <div
                      class="relative h-48 w-full flex justify-center rounded-lg border border-gray-200 bg-gray-100 overflow-hidden"
                    >
                      <!-- Inner Container for aspect ratio -->
                      <div class="relative h-full aspect-[9/16]">
                        <img
                          v-if="previewDisplayUrl"
                          :src="previewDisplayUrl"
                          class="w-full h-full object-cover transition-all duration-700"
                          :style="{
                            filter: `blur(${store.appConfig.mobileBackgroundBlur}px)`,
                          }"
                        />
                        <div
                          v-else
                          class="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
                        >
                          点击上方预设或刷新按钮获取预览
                        </div>
                        <!-- Mask Preview -->
                        <div
                          class="absolute inset-0 pointer-events-none transition-all duration-300"
                          :style="{
                            backgroundColor: `rgba(0,0,0,${store.appConfig.mobileBackgroundMask})`,
                          }"
                        ></div>
                      </div>
                    </div>

                    <!-- Mobile Controls -->
                    <div
                      class="bg-gray-50 p-2 rounded-lg border border-gray-100 flex items-center justify-center gap-4"
                    >
                      <div class="flex items-center gap-1">
                        <span class="text-[10px] text-gray-500">模糊</span>
                        <input
                          type="range"
                          v-model.number="store.appConfig.mobileBackgroundBlur"
                          min="0"
                          max="20"
                          step="1"
                          class="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                      <div class="w-px h-3 bg-gray-300"></div>
                      <div class="flex items-center gap-1">
                        <span class="text-[10px] text-gray-500">遮罩</span>
                        <input
                          type="range"
                          v-model.number="store.appConfig.mobileBackgroundMask"
                          min="0"
                          max="1"
                          step="0.1"
                          class="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>
                      <div class="w-px h-3 bg-gray-300"></div>
                      <button
                        @click="applyCustomApi('mobile', false)"
                        class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        :disabled="!customApiUrl || applyingApi || resolvingUrl"
                        title="下载到 手机壁纸库"
                      >
                        <span
                          v-if="applyingApi"
                          class="block w-4 h-4 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin"
                        ></span>
                        <svg
                          v-else
                          xmlns="http://www.w3.org/2000/svg"
                          class="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label class="block text-xs font-medium text-gray-600 mb-2"
                    >图片 URL / API 地址</label
                  >
                  <div class="flex gap-2">
                    <input
                      v-model="customApiUrl"
                      class="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all"
                      placeholder="https://example.com/image.jpg 或 随机图片API"
                    />
                    <button
                      @click="handleRefresh"
                      class="px-3 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg border border-gray-200 transition-colors disabled:opacity-50"
                      title="刷新预览 (追加时间戳)"
                      :disabled="resolvingUrl"
                    >
                      <span v-if="resolvingUrl" class="inline-block animate-spin">🔄</span>
                      <span v-else>🔄</span>
                    </button>
                  </div>
                </div>

                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="api in presetApis"
                    :key="api.name"
                    @click="usePreset(api.url)"
                    class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs rounded-lg transition-colors"
                  >
                    {{ api.name }}
                  </button>
                </div>

                <div class="pt-4 flex items-center gap-3 border-t border-gray-100 mt-4">
                  <button
                    @click="applyCustomApi('pc')"
                    class="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
                    :disabled="!customApiUrl || applyingApi || resolvingUrl"
                    :class="!customApiUrl || applyingApi || resolvingUrl ? 'opacity-50 cursor-not-allowed' : ''"
                  >
                    <span
                      v-if="applyingApi"
                      class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                    ></span>
                    {{ applyingApi ? "保存中..." : "应用到 PC 壁纸" }}
                  </button>
                  <button
                    @click="applyCustomApi('mobile')"
                    class="flex-1 px-4 py-2.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-bold rounded-lg shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
                    :disabled="!customApiUrl || applyingApi || resolvingUrl"
                    :class="!customApiUrl || applyingApi || resolvingUrl ? 'opacity-50 cursor-not-allowed' : ''"
                  >
                    <span
                      v-if="applyingApi"
                      class="w-4 h-4 border-2 border-gray-400 border-t-gray-600 rounded-full animate-spin"
                    ></span>
                    {{ applyingApi ? "保存中..." : "应用到 手机壁纸" }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
    </div>
  </OverlayMotion>
  <!-- Custom Confirm Modal -->
  <OverlayMotion
    :show="showConfirmModal"
    :z-index="200"
    close-on-overlay
    overlay-class="bg-black/60 backdrop-blur-sm p-4"
    panel-class="max-w-sm"
    @close="closeConfirmModal"
  >
      <div class="bg-white rounded-xl shadow-2xl w-full p-6">
        <div class="flex items-start gap-4 mb-4">
          <div class="p-2 bg-yellow-100 rounded-full text-yellow-600 shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-bold text-gray-900 mb-2">提示</h3>
            <p class="text-sm text-gray-600 leading-relaxed">{{ confirmMessage }}</p>
          </div>
        </div>
        <div class="flex justify-end gap-3">
          <button
            @click="closeConfirmModal"
            class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            取消
          </button>
          <button
            @click="handleConfirm"
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            确定
          </button>
        </div>
      </div>
  </OverlayMotion>
</template>
