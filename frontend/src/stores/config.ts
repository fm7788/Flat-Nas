import { ref, computed, watch } from "vue";
import { defineStore } from "pinia";
import { useStorage } from "@vueuse/core";
import type { AppConfig, SystemConfig } from "@/types";
import { resolveManagedUrl } from "@/utils/runtimeUrls";

const DEFAULT_MARKETPLACE_LIST_URL = "http://qdnas.icu:23111/";

export const useConfigStore = defineStore("config", () => {
  // Pure client-only states (NOT synced to server)
  const forceNetworkMode = useStorage<"auto" | "lan" | "wan" | "latency">(
    "flatnas-force-network-mode",
    "auto",
  );
  const isExpandedMode = ref(false);
  const activeMusicPlayer = ref<"mini-player" | "music-widget" | null>(null);
  const webPaginationActiveGroupId = ref("");
  const isLanModeInited = ref(false);
  const isLanMode = ref(false);
  const networkLatency = ref(0);
  const effectiveIsLan = ref(false);
  const ipFetchStatus = ref<"success" | "error" | "loading">("loading");
  const weatherNetworkStatus = ref<"online" | "degraded" | "offline">("online");
  const isPageUnloading = ref(false);
  const serverSyncLockCount = ref(0);

  // Version / update checking
  const currentVersion = "1.2.5-dev.2";
  const latestVersion = ref("");
  const dockerUpdateAvailable = ref(false);
  const updateCheckLastAt = useStorage<number>("flat-nas-update-check-last-at", 0);
  const UPDATE_CHECK_TTL = 30 * 60 * 1000;

  const hasUpdate = computed(() => {
    if (dockerUpdateAvailable.value) return true;
    if (!latestVersion.value) return false;
    const v1 = currentVersion.replace(/^v/, "");
    const v2 = latestVersion.value.replace(/^v/, "");
    return v1 !== v2;
  });

  // Resource version for cache busting
  const resourceVersion = useStorage("flat-nas-resource-version", Date.now());

  const refreshResources = () => {
    resourceVersion.value = Date.now();
  };

  const getAssetUrl = (url?: string) => {
    if (!url) return "";
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    const resolved = resolveManagedUrl(url);
    const connector = resolved.includes("?") ? "&" : "?";
    return `${resolved}${connector}t=${resourceVersion.value}`;
  };

  const appConfig = ref<AppConfig>({
    background: "/default-wallpaper.svg",
    mobileBackground: "/default-wallpaper.svg",
    solidBackgroundColor: "",
    enableMobileWallpaper: true,
    deviceMode: "auto",
    widgetAreaSize: 4,
    widgetAreaCols: 4,
    widgetAreaRows: 4,
    pcRotation: false,
    pcRotationInterval: 30,
    pcRotationMode: "random",
    mobileRotation: false,
    mobileRotationInterval: 30,
    mobileRotationMode: "random",
    backgroundBlur: 0,
    backgroundMask: 0,
    mobileBackgroundBlur: 0,
    mobileBackgroundMask: 0,
    daylightModeEnabled: false,
    daylightMask: 0.5,
    weatherEffectEnabled: false,
    customTitle: "我的导航",
    titleAlign: "left",
    titleSize: 48,
    titleColor: "#ffffff",
    cardLayout: "vertical",
    cardSize: 120,
    gridGap: 24,
    cardBgColor: "transparent",
    cardTitleColor: "#111827",
    cardBorderColor: "transparent",
    showCardBackground: true,
    iconShape: "rounded",
    searchEngines: [
      { id: "google", key: "google", label: "Google", urlTemplate: "https://www.google.com/search?q={q}" },
      { id: "bing", key: "bing", label: "Bing", urlTemplate: "https://cn.bing.com/search?q={q}" },
      { id: "baidu", key: "baidu", label: "百度", urlTemplate: "https://www.baidu.com/s?wd={q}" },
    ],
    defaultSearchEngine: "google",
    rememberLastEngine: true,
    groupTitleColor: "#ffffff",
    groupGap: 30,
    autoPlayMusic: false,
    showFooterStats: false,
    footerHtml: "",
    footerHeight: 0,
    footerWidth: 1280,
    footerMarginBottom: 0,
    footerFontSize: 12,
    wallpaperApiPcList: "/api/backgrounds",
    wallpaperApiPcUpload: "/api/backgrounds/upload",
    wallpaperApiPcDeleteBase: "/api/backgrounds",
    wallpaperPcImageBase: "/backgrounds",
    wallpaperApiMobileList: "/api/mobile_backgrounds",
    wallpaperApiMobileUpload: "/api/mobile_backgrounds/upload",
    wallpaperApiMobileDeleteBase: "/api/mobile_backgrounds",
    wallpaperMobileImageBase: "/mobile_backgrounds",
    mobileWallpaperOrder: [],
    sidebarViewMode: "bookmarks",
    webGroupPagination: false,
    webGroupPaginationDisableFlip: false,
    empireMode: false,
    customCss: "",
    customJs: "",
    customJsList: [],
    customJsDisclaimerAgreed: false,
    mouseHoverEffect: "scale",
    autoUltrawide: false,
    marketplaceListUrl: DEFAULT_MARKETPLACE_LIST_URL,
    networkRules: "",
    networkPresets: {
      tailscale: false,
      zerotier: false,
      frp: false,
      cloudflareTunnel: false,
      ngrok: false,
    },
    latencyThresholdMs: 200,
  });

  const systemConfig = ref<SystemConfig>({
    authMode: "single",
    enableDocker: false,
    dockerHost: "",
  });

  const lockServerSync = () => {
    serverSyncLockCount.value += 1;
  };
  const unlockServerSync = () => {
    serverSyncLockCount.value = Math.max(0, serverSyncLockCount.value - 1);
  };
  const isServerSyncLocked = computed(() => serverSyncLockCount.value > 0);

  const checkUpdate = async (force = false) => {
    try {
      const now = Date.now();
      const shouldCheckRemote =
        force ||
        !updateCheckLastAt.value ||
        now - updateCheckLastAt.value >= UPDATE_CHECK_TTL ||
        !latestVersion.value;

      if (shouldCheckRemote) {
        updateCheckLastAt.value = now;
        const res = await fetch("https://gitee.com/api/v5/repos/gjx0808/FlatNas/tags");
        if (res.ok) {
          const data = await res.json();
          if (data.length > 0) {
            latestVersion.value = data[0].name;
          }
        }
      }
    } catch (e) {
      console.error("Failed to check update", e);
    }

    if (!systemConfig.value.enableDocker) {
      dockerUpdateAvailable.value = false;
      return;
    }

    try {
      const res = await fetch("/api/docker-status");
      if (res.ok) {
        const data = await res.json();
        dockerUpdateAvailable.value = data.state === "ready" && Boolean(data.hasUpdate);
      }
    } catch {
      // ignore
    }
  };

  // localStorage persistence watches
  watch(
    () => appConfig.value.iconShape,
    (val) => {
      if (typeof val === "string") localStorage.setItem("flat-nas-icon-shape", val);
    },
  );
  watch(
    () => appConfig.value.cardBgColor,
    (val) => {
      if (typeof val === "string") localStorage.setItem("flat-nas-card-bg-color", val);
    },
  );

  watch(
    () => [appConfig.value.widgetAreaCols, appConfig.value.widgetAreaRows] as const,
    ([cols, rows]) => {
      const normalize = (v: unknown, fallback: number) => {
        const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
        return Math.min(16, Math.max(0.5, n));
      };
      const nextCols = normalize(cols, 4);
      const nextRows = normalize(rows, 4);
      if (nextCols !== cols) appConfig.value.widgetAreaCols = nextCols;
      if (nextRows !== rows) appConfig.value.widgetAreaRows = nextRows;
    },
    { immediate: true },
  );

  return {
    appConfig,
    systemConfig,
    forceNetworkMode,
    isExpandedMode,
    activeMusicPlayer,
    webPaginationActiveGroupId,
    isLanModeInited,
    isLanMode,
    networkLatency,
    effectiveIsLan,
    ipFetchStatus,
    weatherNetworkStatus,
    isPageUnloading,
    currentVersion,
    latestVersion,
    dockerUpdateAvailable,
    hasUpdate,
    updateCheckLastAt,
    resourceVersion,
    checkUpdate,
    refreshResources,
    getAssetUrl,
    lockServerSync,
    unlockServerSync,
    isServerSyncLocked,
  };
});
