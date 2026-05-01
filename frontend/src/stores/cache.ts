import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./auth";
import { useWidgetsStore } from "./widgets";
import { useGroupsStore } from "./groups";
import { useConfigStore } from "./config";
import {
  stripWidgetUiState,
  stripForceNetworkMode,
  normalizeVersion,
} from "@/utils/storeHelpers";
import type { AppConfig, WidgetConfig, NavGroup, RssFeed, RssCategory } from "@/types";

const CACHE_KEY = "flat-nas-data-cache";
const CACHE_WRITE_GUARD_MS = 15000;
const SERVER_SNAPSHOT_RETRY_COUNT = 3;
const SERVER_SNAPSHOT_RETRY_DELAY_MS = 1000;
const SERVER_SNAPSHOT_TIMEOUT_MS = 60000;
const DEFAULT_MARKETPLACE_LIST_URL = "http://qdnas.icu:23111/";
const DEV_MARKETPLACE_LIST_URL = "http://localhost:5174/";
const LEGACY_DEFAULT_MARKETPLACE_LIST_URL = "https://qdnas.icu:23111/";

export const useCacheStore = defineStore("cache", () => {
  const auth = useAuthStore();
  const widgetsStore = useWidgetsStore();
  const groupsStore = useGroupsStore();
  const configStore = useConfigStore();

  const cacheLoadedAt = ref<number | null>(null);
  const hasServerSnapshot = ref(false);
  const deferredSaveRequested = ref(false);
  let isFetchingData = false;
  let isLoadingSnapshot = false;
  let serverSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const getHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth.token) {
      headers["Authorization"] = `Bearer ${auth.token}`;
    }
    return headers;
  };

  const saveToCache = (data: Record<string, unknown>) => {
    try {
      const authMode = ((data.systemConfig as Record<string, unknown> | undefined)?.authMode ??
        configStore.systemConfig.authMode) === "single"
        ? "single"
        : "multi";
      const cacheWidgets = Array.isArray(data.widgets)
        ? (data.widgets as WidgetConfig[]).map((widget) => stripWidgetUiState(widget))
        : data.widgets;
      const cacheData = {
        groups: data.groups,
        widgets: cacheWidgets,
        appConfig: stripForceNetworkMode(
          (data.appConfig || undefined) as Record<string, unknown> | undefined,
        ),
        rssFeeds: data.rssFeeds,
        rssCategories: data.rssCategories,
        systemConfig: data.systemConfig,
        username: authMode === "single" ? "admin" : data.username || auth.username,
        version: data.version,
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
    } catch (e) {
      console.warn("Cache save failed", e);
    }
  };

  const loadFromCache = (
    rssFeedsRef: ReturnType<typeof ref<RssFeed[]>>,
    rssCategoriesRef: ReturnType<typeof ref<RssCategory[]>>,
    dataVersionRef: ReturnType<typeof ref<number>>,
  ): boolean => {
    try {
      const json = localStorage.getItem(CACHE_KEY);
      if (!json) return false;
      const cache = JSON.parse(json);

      const cachedUser = cache.username || "";
      const currentUser = auth.username || "";
      const isMatch = cachedUser === currentUser || (currentUser === "" && cachedUser === "admin");
      if (!isMatch) return false;

      if (cache.groups) groupsStore.groups = cache.groups;
      if (cache.widgets) {
        widgetsStore.applyServerWidgets(
          widgetsStore.normalizeIncomingWidgets(cache.widgets as WidgetConfig[], auth.isLogged),
          auth.isLogged,
          widgetsStore.layoutEditInProgress,
        );
      }
      if (cache.appConfig) {
        const mergedConfig = { ...configStore.appConfig, ...cache.appConfig } as AppConfig & {
          fixedWallpaper?: boolean;
          forceNetworkMode?: unknown;
        };
        if (mergedConfig.fixedWallpaper === true) {
          mergedConfig.pcRotation = false;
          mergedConfig.mobileRotation = false;
        }
        delete mergedConfig.fixedWallpaper;
        delete mergedConfig.forceNetworkMode;
        configStore.appConfig = mergedConfig;
      }
      if (
        !configStore.appConfig.marketplaceListUrl ||
        configStore.appConfig.marketplaceListUrl === DEV_MARKETPLACE_LIST_URL ||
        configStore.appConfig.marketplaceListUrl === LEGACY_DEFAULT_MARKETPLACE_LIST_URL
      ) {
        configStore.appConfig.marketplaceListUrl = DEFAULT_MARKETPLACE_LIST_URL;
      }
      if (Array.isArray(cache.rssFeeds)) rssFeedsRef.value = cache.rssFeeds;
      if (Array.isArray(cache.rssCategories)) rssCategoriesRef.value = cache.rssCategories;
      if (cache.systemConfig) configStore.systemConfig = cache.systemConfig;
      if (typeof cache.version !== "undefined") {
        dataVersionRef.value = normalizeVersion(cache.version);
      }
      return true;
    } catch (e) {
      console.warn("Cache load failed", e);
      return false;
    }
  };

  const isCacheWriteGuardActive = () => {
    if (hasServerSnapshot.value) return false;
    if (cacheLoadedAt.value === null) return false;
    return Date.now() - cacheLoadedAt.value < CACHE_WRITE_GUARD_MS;
  };

  const markServerSnapshotReady = () => {
    hasServerSnapshot.value = true;
    cacheLoadedAt.value = null;
  };

  const isServerSnapshotReady = computed(() => hasServerSnapshot.value);
  const isClientReady = computed(() => hasServerSnapshot.value || cacheLoadedAt.value !== null);

  const fetchWithTimeout = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs = SERVER_SNAPSHOT_TIMEOUT_MS,
  ) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  };

  const loadServerSnapshot = async (
    handleDataUpdate: (data: Record<string, unknown>) => void,
    updateLayout: () => void,
    markDirty: () => void,
  ) => {
    if (isLoadingSnapshot) return;
    isLoadingSnapshot = true;
    try {
      const res = await fetchWithTimeout("/api/data", { headers: getHeaders() });
      if (res.status === 304) {
        if (!isClientReady.value) {
          const reloadRes = await fetchWithTimeout("/api/data", {
            headers: getHeaders(),
            cache: "reload",
          });
          if (!reloadRes.ok) throw new Error(`Init reload failed with status ${reloadRes.status}`);
          const reloadData = await reloadRes.json();
          if (reloadData.systemConfig) configStore.systemConfig = reloadData.systemConfig;
          handleDataUpdate(reloadData);
        }
        updateLayout();
        markServerSnapshotReady();
        return;
      }
      if (!res.ok) throw new Error(`Init failed with status ${res.status}`);
      const data = await res.json();
      if (data.systemConfig) configStore.systemConfig = data.systemConfig;
      handleDataUpdate(data);
      updateLayout();
      markServerSnapshotReady();
    } finally {
      isLoadingSnapshot = false;
    }
  };

  return {
    cacheLoadedAt,
    hasServerSnapshot,
    deferredSaveRequested,
    isFetchingData,
    isLoadingSnapshot,
    serverSnapshotRetryTimer,
    saveToCache,
    loadFromCache,
    isCacheWriteGuardActive,
    markServerSnapshotReady,
    isServerSnapshotReady,
    isClientReady,
    loadServerSnapshot,
    fetchWithTimeout,
    getHeaders,
    DEFAULT_MARKETPLACE_LIST_URL,
    DEV_MARKETPLACE_LIST_URL,
    LEGACY_DEFAULT_MARKETPLACE_LIST_URL,
  };
});
