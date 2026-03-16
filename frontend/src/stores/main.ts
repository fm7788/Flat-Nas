import { ref, computed, watch } from "vue";
import { defineStore } from "pinia";
import { useStorage } from "@vueuse/core";
import io from "socket.io-client";
import pako from "pako";
import type {
  NavItem,
  NavGroup,
  AppConfig,
  WidgetConfig,
  MarketplaceItem,
  RssFeed,
  RssCategory,
  LuckyStunData,
} from "@/types";

interface BackupData {
  username?: string;
  items?: NavItem[];
  groups?: NavGroup[];
  widgets?: WidgetConfig[];
  appConfig?: AppConfig;
  rssFeeds?: RssFeed[];
  rssCategories?: RssCategory[];
  systemConfig?: Record<string, unknown>;
  version?: number;
  [key: string]: unknown;
}

export const useMainStore = defineStore("main", () => {
  // 使用 polling 优先可在反向代理/未正确配置 WebSocket 时仍能连接（Docker 等环境）
  const socket = io({
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
  });
  const isConnected = ref(false);
  let socketListenersBound = false;
  let visibilityVersionCheckBound = false;
  let isInitializing = false;
  let isFirstConnect = true;
  const NETWORK_HEARTBEAT_INTERVAL = 10000;
  const NETWORK_HEARTBEAT_TIMEOUT = 20000;
  const NETWORK_HEARTBEAT_CHECK_INTERVAL = 3000;
  // 白名单（latency）模式下降低心跳频率，减少请求，仍保证 300ms 内延迟可正常维持
  const NETWORK_HEARTBEAT_INTERVAL_LATENCY = 30000;
  const NETWORK_HEARTBEAT_TIMEOUT_LATENCY = 60000;
  const NETWORK_HEARTBEAT_CHECK_INTERVAL_LATENCY = 10000;
  let networkHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let networkHeartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastNetworkHeartbeatAt = 0;
  let isNetworkSyncActive = true;
  let isApplyingServerData = false;
  const DEFAULT_MARKETPLACE_LIST_URL = "http://qdnas.icu:23111/";
  const LEGACY_DEFAULT_MARKETPLACE_LIST_URL = "https://qdnas.icu:23111/";
  const DEV_MARKETPLACE_LIST_URL = "http://localhost:5174/";

  socket.on("connect", async () => {
    // #region agent log
    fetch("http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b0ccc3" },
      body: JSON.stringify({
        sessionId: "b0ccc3",
        location: "main.ts:socket connect",
        message: "socket_connected",
        data: { socketId: socket.id },
        hypothesisId: "H1",
        timestamp: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    console.log("Socket connected:", socket.id);
    isConnected.value = true;
    startNetworkHeartbeat();

    // Skip the mode check on first connection (initial load)
    // The init() function will handle the initial state and config fetching
    if (isFirstConnect) {
      isFirstConnect = false;
      return;
    }

    // Check if system config changed while we were disconnected
    // This handles the case where user switches mode in one tab while another is briefly offline
    const oldMode = systemConfig.value.authMode;
    await fetchSystemConfig();

    // 增加防抖，避免因网络抖动或配置同步延迟导致的频繁刷新
    if (systemConfig.value.authMode !== oldMode) {
      console.log(`Auth mode changed from ${oldMode} to ${systemConfig.value.authMode}, re-initializing...`);
      // 延迟 500ms 再次确认，防止误判
      setTimeout(async () => {
        await fetchSystemConfig(); // fetch again to be sure
        // 只有当再次确认后模式确实改变了，才执行重置操作
        if (systemConfig.value.authMode !== oldMode) {
          if (isLogged.value) {
            logout();
          } else {
            init();
          }
        }
      }, 500);
    }
  });
  socket.on("disconnect", () => {
    console.log("Socket disconnected");
    isConnected.value = false;
    stopNetworkHeartbeat();
  });

  socket.on("connect_error", (err: unknown) => {
    // #region agent log
    fetch("http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b0ccc3" },
      body: JSON.stringify({
        sessionId: "b0ccc3",
        location: "main.ts:socket connect_error",
        message: "socket_connect_error",
        data: { err: String(err) },
        hypothesisId: "H1",
        timestamp: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    console.error("Socket connect error:", err);
  });

  // Lucky STUN Data
  const luckyStunData = ref<LuckyStunData | null>(null);
  socket.on("lucky:stun", (data: unknown) => {
    luckyStunData.value = data as LuckyStunData;
  });

  const fetchLuckyStunData = async () => {
    if (import.meta.env.MODE === "test") return;
    // Lazy load stun data only when needed or after app is idle
    try {
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
      const res = await fetch(new URL("/api/lucky/stun", base).toString());
      if (res.ok) {
        luckyStunData.value = await res.json();
      }
    } catch (e) {
      console.error("Failed to fetch lucky stun data", e);
    }
  };

  const fetchSystemConfig = async () => {
    if (import.meta.env.MODE === "test") return;
    try {
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
      const res = await fetch(new URL("/api/system-config", base).toString());
      if (res.ok) {
        systemConfig.value = await res.json();
      }
    } catch (e) {
      console.error("Failed to fetch system config", e);
    }
  };

  const updateSystemConfig = async (newConfig: Partial<typeof systemConfig.value>) => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;
      const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
      const res = await fetch(new URL("/api/system-config", base).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        systemConfig.value = await res.json();
        return true;
      }
      return false;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  const groups = ref<NavGroup[]>([]);
  const items = computed(() => groups.value.flatMap((g) => g.items));
  const rssFeeds = ref<RssFeed[]>([]);
  const rssCategories = ref<RssCategory[]>([]);
  const systemConfig = ref({ authMode: "single" }); // Default
  const dataVersion = ref(0);
  const pendingServerVersion = ref(0);

  // Auth State
  const token = ref(localStorage.getItem("flat-nas-token") || "");
  const username = ref(localStorage.getItem("flat-nas-username") || "");
  const isLogged = ref(!!token.value);
  const forceNetworkMode = useStorage<"auto" | "lan" | "wan" | "latency">(
    "flatnas-force-network-mode",
    "auto",
  );
  const password = ref(""); // Only used for password change, not auth
  const isExpandedMode = ref(false);
  const activeMusicPlayer = ref<"mini-player" | "music-widget" | null>(null);
  const webPaginationActiveGroupId = ref("");
  const isLanModeInited = ref(false);
  const isLanMode = ref(false);
  const networkLatency = ref(0);
  const effectiveIsLan = ref(false);
  const ipFetchStatus = ref<"success" | "error" | "loading">("loading");
  const weatherNetworkStatus = ref<"online" | "degraded" | "offline">("online");
  const WEATHER_STATUS_CACHE_MS = 10_000;
  const WEATHER_DEGRADED_HOLD_MS = 15_000;
  let weatherStatusLastDetectAt = 0;
  let weatherStatusLastResult: "online" | "degraded" | "offline" = "online";
  let weatherStatusDetectInFlight: Promise<"online" | "degraded" | "offline"> | null = null;
  let weatherDegradedUntil = 0;
  const isPageUnloading = ref(false);
  const serverSyncLockCount = ref(0);
  const lockServerSync = () => {
    serverSyncLockCount.value += 1;
  };
  const unlockServerSync = () => {
    serverSyncLockCount.value = Math.max(0, serverSyncLockCount.value - 1);
  };
  const isServerSyncLocked = computed(() => serverSyncLockCount.value > 0);
  const globalDrag = ref({
    active: false,
    isFiles: false,
    point: { x: 0, y: 0 },
    depth: 0,
    scope: "",
  });
  let globalDragBound = false;

  const getHeaders = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token.value) {
      headers["Authorization"] = `Bearer ${token.value}`;
    }
    return headers;
  };

  const isValidNetworkMode = (mode: string) =>
    mode === "auto" || mode === "lan" || mode === "wan" || mode === "latency";

  const detectWeatherNetworkStatus = async (
    force = false,
  ): Promise<"online" | "degraded" | "offline"> => {
    const now = Date.now();

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      weatherStatusLastResult = "offline";
      weatherStatusLastDetectAt = now;
      weatherNetworkStatus.value = "offline";
      return "offline";
    }

    if (!force && weatherDegradedUntil > now) {
      weatherStatusLastResult = "degraded";
      weatherNetworkStatus.value = "degraded";
      return "degraded";
    }

    if (!force && now - weatherStatusLastDetectAt < WEATHER_STATUS_CACHE_MS) {
      weatherNetworkStatus.value = weatherStatusLastResult;
      return weatherStatusLastResult;
    }

    if (weatherStatusDetectInFlight) {
      return weatherStatusDetectInFlight;
    }

    const url = `/api/health?t=${now}`;
    weatherStatusDetectInFlight = (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        let next: "online" | "degraded" | "offline";

        if (res.ok || res.status === 404) {
          next = "online";
          weatherDegradedUntil = 0;
        } else {
          next = "degraded";
          weatherDegradedUntil = Date.now() + WEATHER_DEGRADED_HOLD_MS;
        }

        weatherStatusLastResult = next;
        weatherStatusLastDetectAt = Date.now();
        weatherNetworkStatus.value = next;
        return next;
      } catch {
        const next: "online" | "degraded" | "offline" = "degraded";
        weatherDegradedUntil = Date.now() + WEATHER_DEGRADED_HOLD_MS;
        weatherStatusLastResult = next;
        weatherStatusLastDetectAt = Date.now();
        weatherNetworkStatus.value = next;
        return next;
      } finally {
        weatherStatusDetectInFlight = null;
      }
    })();

    return weatherStatusDetectInFlight;
  };

  const bindWeatherNetworkEvents = () => {
    if (typeof window === "undefined") return;
    window.addEventListener("online", () => {
      weatherDegradedUntil = 0;
      detectWeatherNetworkStatus(true);
    });
    window.addEventListener("offline", () => {
      weatherDegradedUntil = 0;
      weatherStatusLastResult = "offline";
      weatherStatusLastDetectAt = Date.now();
      weatherNetworkStatus.value = "offline";
    });
  };

  const emitNetworkHeartbeat = () => {
    const t = token.value || localStorage.getItem("flat-nas-token");
    if (!t) return;
    socket.emit("network:heartbeat", { token: t });
  };

  const resetGlobalDrag = () => {
    globalDrag.value.active = false;
    globalDrag.value.isFiles = false;
    globalDrag.value.depth = 0;
    globalDrag.value.scope = "";
  };

  const isFilesDragEvent = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes("Files");
  };

  const resolveDragScope = (e: DragEvent) => {
    const target = e.target as HTMLElement | null;
    const scopeEl = target?.closest?.("[data-drag-scope]") as HTMLElement | null;
    return scopeEl?.dataset.dragScope || "";
  };

  const initGlobalDrag = () => {
    if (globalDragBound || typeof window === "undefined") return;
    globalDragBound = true;

    const onDragEnter = (e: DragEvent) => {
      if (!isFilesDragEvent(e)) return;
      globalDrag.value.depth += 1;
      globalDrag.value.active = true;
      globalDrag.value.isFiles = true;
      globalDrag.value.point = { x: e.clientX, y: e.clientY };
      globalDrag.value.scope = resolveDragScope(e);
    };

    const onDragOver = (e: DragEvent) => {
      if (!isFilesDragEvent(e)) return;
      e.preventDefault();
      globalDrag.value.active = true;
      globalDrag.value.isFiles = true;
      globalDrag.value.point = { x: e.clientX, y: e.clientY };
      globalDrag.value.scope = resolveDragScope(e);
    };

    const onDragLeave = () => {
      if (!globalDrag.value.active) return;
      globalDrag.value.depth = Math.max(0, globalDrag.value.depth - 1);
      if (globalDrag.value.depth === 0) resetGlobalDrag();
    };

    const onDrop = () => resetGlobalDrag();
    const onDragEnd = () => resetGlobalDrag();
    const onPointerUp = () => resetGlobalDrag();
    const onMouseUp = () => resetGlobalDrag();
    const onBlur = () => resetGlobalDrag();

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onBlur, true);

  };

  /** 心跳曾断开（超时切到 poll）；再次被激活时若版本不同则提示是否同步 */
  let heartbeatLostSinceLastVisible = false;
  const updateNetworkSyncMode = (active: boolean) => {
    if (isNetworkSyncActive === active) return;
    isNetworkSyncActive = active;
    heartbeatLostSinceLastVisible = true;
  };

  const getHeartbeatInterval = () =>
    forceNetworkMode.value === "latency" ? NETWORK_HEARTBEAT_INTERVAL_LATENCY : NETWORK_HEARTBEAT_INTERVAL;
  const getHeartbeatTimeout = () =>
    forceNetworkMode.value === "latency" ? NETWORK_HEARTBEAT_TIMEOUT_LATENCY : NETWORK_HEARTBEAT_TIMEOUT;
  const getHeartbeatCheckInterval = () =>
    forceNetworkMode.value === "latency" ? NETWORK_HEARTBEAT_CHECK_INTERVAL_LATENCY : NETWORK_HEARTBEAT_CHECK_INTERVAL;

  const startNetworkHeartbeat = () => {
    if (networkHeartbeatTimer) clearInterval(networkHeartbeatTimer);
    if (networkHeartbeatCheckTimer) clearInterval(networkHeartbeatCheckTimer);
    emitNetworkHeartbeat();
    const interval = getHeartbeatInterval();
    const checkInterval = getHeartbeatCheckInterval();
    networkHeartbeatTimer = setInterval(emitNetworkHeartbeat, interval);
    networkHeartbeatCheckTimer = setInterval(() => {
      const timeout = getHeartbeatTimeout();
      const active =
        lastNetworkHeartbeatAt > 0 &&
        Date.now() - lastNetworkHeartbeatAt <= timeout;
      updateNetworkSyncMode(active);
    }, checkInterval);
  };

  const stopNetworkHeartbeat = () => {
    if (networkHeartbeatTimer) clearInterval(networkHeartbeatTimer);
    if (networkHeartbeatCheckTimer) clearInterval(networkHeartbeatCheckTimer);
    networkHeartbeatTimer = null;
    networkHeartbeatCheckTimer = null;
    lastNetworkHeartbeatAt = 0;
    updateNetworkSyncMode(false);
  };

  // Dashboard pulse: single timer to align Docker/Music polling and reduce scattered requests
  const DASHBOARD_PULSE_INTERVAL = 15000;
  const dashboardPulseCallbacks = new Set<() => void>();
  let dashboardPulseTimer: ReturnType<typeof setInterval> | null = null;

  const startDashboardPulse = () => {
    if (dashboardPulseTimer) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (dashboardPulseCallbacks.size === 0) return;
    dashboardPulseTimer = setInterval(() => {
      dashboardPulseCallbacks.forEach((f) => f());
    }, DASHBOARD_PULSE_INTERVAL);
  };

  const stopDashboardPulse = () => {
    if (dashboardPulseTimer) {
      clearInterval(dashboardPulseTimer);
      dashboardPulseTimer = null;
    }
  };

  const registerDashboardPulse = (fn: () => void) => {
    dashboardPulseCallbacks.add(fn);
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
      startDashboardPulse();
    }
  };

  const unregisterDashboardPulse = (fn: () => void) => {
    dashboardPulseCallbacks.delete(fn);
    if (dashboardPulseCallbacks.size === 0) stopDashboardPulse();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopDashboardPulse();
      else if (dashboardPulseCallbacks.size > 0) startDashboardPulse();
    });
  }

  // Version Check
  const currentVersion = "1.1.5dev2";
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
        // Use Gitee tags API to avoid connection issues in China
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

    try {
      const res = await fetch("/api/docker-status");
      if (res.ok) {
        const data = await res.json();
        if (data.hasUpdate) {
          dockerUpdateAvailable.value = true;
        }
      }
    } catch {
      // ignore
    }
  };

  // Resource version for cache busting
  const resourceVersion = useStorage("flat-nas-resource-version", Date.now());

  const refreshResources = () => {
    resourceVersion.value = Date.now();
  };

  /**
   * 为资源 URL 添加时间戳参数，防止缓存（用于同名覆盖场景）
   */
  const getAssetUrl = (url?: string) => {
    if (!url) return "";
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    const connector = url.includes("?") ? "&" : "?";
    // 使用全局资源版本号，避免频繁重绘导致闪屏
    return `${url}${connector}t=${resourceVersion.value}`;
  };

  const widgets = ref<WidgetConfig[]>([]);
  type WidgetUiState = {
    collapsed?: boolean;
    editing?: boolean;
    dragging?: boolean;
  };
  type WidgetLayoutSnapshot = {
    id: string;
    order: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    colSpan?: number;
    rowSpan?: number;
    layouts?: WidgetConfig["layouts"];
  };
  const WIDGET_UI_KEYS = ["collapsed", "editing", "dragging"] as const;
  const serverLayoutMap = ref<Record<string, WidgetLayoutSnapshot>>({});
  const uiStateMap = ref<Record<string, WidgetUiState>>({});
  const serverLayoutSignature = ref("");

  const readWidgetUiState = (widget: WidgetConfig): WidgetUiState => {
    const source = widget as unknown as Record<string, unknown>;
    const state: WidgetUiState = {};
    for (const key of WIDGET_UI_KEYS) {
      const value = source[key];
      if (typeof value === "boolean") {
        state[key] = value;
      }
    }
    return state;
  };

  const stripWidgetUiState = (widget: WidgetConfig): WidgetConfig => {
    const clone = { ...widget } as WidgetConfig & Record<string, unknown>;
    for (const key of WIDGET_UI_KEYS) {
      delete clone[key];
    }
    return clone;
  };

  const syncUiStateMapFromWidgets = (list: WidgetConfig[]) => {
    const nextMap: Record<string, WidgetUiState> = { ...uiStateMap.value };
    for (const widget of list) {
      const ui = readWidgetUiState(widget);
      if (Object.keys(ui).length > 0) {
        nextMap[widget.id] = { ...(nextMap[widget.id] || {}), ...ui };
      }
    }
    uiStateMap.value = nextMap;
  };

  const applyWidgetUiState = (widget: WidgetConfig): WidgetConfig => {
    const ui = uiStateMap.value[widget.id];
    if (!ui) return widget;
    const raw = widget as unknown as Record<string, unknown>;
    let changed = false;
    const next = { ...widget } as WidgetConfig & Record<string, unknown>;
    for (const key of WIDGET_UI_KEYS) {
      const value = ui[key];
      if (typeof value === "boolean" && raw[key] !== value) {
        next[key] = value;
        changed = true;
      }
    }
    return changed ? (next as WidgetConfig) : widget;
  };

  const buildServerLayoutMap = (list: WidgetConfig[]) => {
    const next: Record<string, WidgetLayoutSnapshot> = {};
    list.forEach((widget, index) => {
      next[widget.id] = {
        id: widget.id,
        order: index,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        colSpan: widget.colSpan,
        rowSpan: widget.rowSpan,
        layouts: widget.layouts,
      };
    });
    return next;
  };

  const buildServerLayoutSignature = (layoutMap: Record<string, WidgetLayoutSnapshot>) => {
    return JSON.stringify(
      Object.values(layoutMap)
        .sort((a, b) => a.order - b.order)
        .map((item) => ({
          id: item.id,
          order: item.order,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          colSpan: item.colSpan,
          rowSpan: item.rowSpan,
          layouts: item.layouts,
        })),
    );
  };

  const normalizeIncomingWidgets = (input?: WidgetConfig[]) => {
    const nextWidgets = Array.isArray(input) ? input.map((widget) => ({ ...widget })) : [];
    if (nextWidgets.length === 0) {
      return [
        { id: "w1", type: "clock", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "w2", type: "weather", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "w3", type: "calendar", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "w5", type: "search", enable: true, isPublic: true },
        { id: "w7", type: "quote", enable: true, isPublic: true },
        {
          id: "clockweather",
          type: "clockweather",
          enable: true,
          colSpan: 1,
          rowSpan: 1,
          isPublic: true,
        },
        { id: "sidebar", type: "sidebar", enable: false, isPublic: true },
        { id: "docker", type: "docker", enable: false, isPublic: true, colSpan: 1, rowSpan: 1 },
        {
          id: "file-transfer",
          type: "file-transfer",
          enable: true,
          colSpan: 2,
          rowSpan: 2,
          isPublic: true,
        },
        {
          id: "system-status",
          type: "system-status",
          enable: false,
          isPublic: true,
          colSpan: 1,
          rowSpan: 1,
          data: { useMock: false },
        },
        { id: "memo", type: "memo", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "todo", type: "todo", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        {
          id: "calculator",
          type: "calculator",
          enable: true,
          colSpan: 1,
          rowSpan: 1,
          isPublic: true,
        },
        { id: "ip", type: "ip", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "hot", type: "hot", enable: true, colSpan: 1, rowSpan: 1, isPublic: true },
        { id: "player", type: "player", enable: true, colSpan: 2, rowSpan: 1, isPublic: true },
        {
          id: "status-monitor",
          type: "status-monitor",
          enable: false,
          colSpan: 1,
          rowSpan: 1,
          isPublic: true,
        },
      ] as WidgetConfig[];
    }

    const memoW = nextWidgets.find((widget) => widget.id === "memo");
    if (memoW && memoW.type !== "memo") {
      memoW.type = "memo";
    }

    let dockerCandidate = nextWidgets.find((widget) => widget.id === "docker");
    if (!dockerCandidate) {
      dockerCandidate = nextWidgets.find((widget) => widget.type === "docker");
    }
    const listWithoutDocker = nextWidgets.filter((widget) => widget.id !== "docker" && widget.type !== "docker");
    let finalDockerWidget: WidgetConfig;
    if (dockerCandidate) {
      finalDockerWidget = dockerCandidate;
      finalDockerWidget.id = "docker";
      finalDockerWidget.type = "docker";
      if (typeof finalDockerWidget.colSpan !== "number") finalDockerWidget.colSpan = 1;
      if (typeof finalDockerWidget.rowSpan !== "number") finalDockerWidget.rowSpan = 1;
      if (typeof finalDockerWidget.enable !== "boolean") finalDockerWidget.enable = false;
      if (typeof finalDockerWidget.isPublic !== "boolean") finalDockerWidget.isPublic = true;
    } else {
      finalDockerWidget = {
        id: "docker",
        type: "docker",
        enable: false,
        isPublic: true,
        colSpan: 1,
        rowSpan: 1,
      };
    }
    listWithoutDocker.push(finalDockerWidget);

    const fileTransferList = listWithoutDocker.filter((widget) => widget.type === "file-transfer");
    if (fileTransferList.length > 1) {
      const keep = fileTransferList.find((widget) => widget.id === "file-transfer") || fileTransferList[0]!;
      const filtered = listWithoutDocker.filter((widget) => widget.type !== "file-transfer" || widget === keep);
      if (
        keep.id !== "file-transfer" &&
        !filtered.some((widget) => widget.id === "file-transfer" && widget.type !== "file-transfer")
      ) {
        keep.id = "file-transfer";
      }
      nextWidgets.length = 0;
      nextWidgets.push(...filtered);
    } else if (
      fileTransferList.length === 1 &&
      fileTransferList[0]!.id !== "file-transfer" &&
      !listWithoutDocker.some((widget) => widget.id === "file-transfer" && widget.type !== "file-transfer")
    ) {
      fileTransferList[0]!.id = "file-transfer";
      nextWidgets.length = 0;
      nextWidgets.push(...listWithoutDocker);
    } else if (fileTransferList.length === 0) {
      listWithoutDocker.push({
        id: "file-transfer",
        type: "file-transfer",
        enable: true,
        colSpan: 2,
        rowSpan: 2,
        isPublic: true,
      });
      nextWidgets.length = 0;
      nextWidgets.push(...listWithoutDocker);
    } else {
      nextWidgets.length = 0;
      nextWidgets.push(...listWithoutDocker);
    }

    if (!nextWidgets.find((widget) => widget.type === "rss")) {
      nextWidgets.push({
        id: "rss-reader",
        type: "rss",
        enable: false,
        colSpan: 1,
        rowSpan: 2,
        isPublic: true,
      });
    }
    if (!nextWidgets.find((widget) => widget.type === "sidebar")) {
      nextWidgets.push({
        id: "sidebar",
        type: "sidebar",
        enable: false,
        isPublic: true,
      });
    }
    if (!nextWidgets.find((widget) => widget.type === "system-status")) {
      nextWidgets.push({
        id: "system-status",
        type: "system-status",
        enable: false,
        isPublic: true,
        colSpan: 1,
        rowSpan: 1,
        data: { useMock: false },
      });
    }
    if (!nextWidgets.find((widget) => widget.type === "status-monitor")) {
      nextWidgets.push({
        id: "status-monitor",
        type: "status-monitor",
        enable: false,
        colSpan: 1,
        rowSpan: 1,
        isPublic: true,
      });
    }
    return nextWidgets;
  };

  const applyServerWidgets = (incomingWidgets: WidgetConfig[]) => {
    syncUiStateMapFromWidgets(widgets.value);
    const nextServerLayoutMap = buildServerLayoutMap(incomingWidgets);
    const nextLayoutSignature = buildServerLayoutSignature(nextServerLayoutMap);
    const previousById = new Map(widgets.value.map((widget) => [widget.id, widget] as const));
    const preserveLayout = layoutEditInProgress.value;
    const nextWidgets = incomingWidgets.map((incomingWidget) => {
      const previous = previousById.get(incomingWidget.id);
      const mergedBase = previous ? ({ ...previous, ...incomingWidget } as WidgetConfig) : incomingWidget;
      if (preserveLayout && previous) {
        mergedBase.x = previous.x;
        mergedBase.y = previous.y;
        mergedBase.w = previous.w;
        mergedBase.h = previous.h;
        mergedBase.colSpan = previous.colSpan;
        mergedBase.rowSpan = previous.rowSpan;
        mergedBase.layouts = previous.layouts
          ? (JSON.parse(JSON.stringify(previous.layouts)) as typeof previous.layouts)
          : undefined;
      }
      return applyWidgetUiState(mergedBase);
    });

    let changed = nextWidgets.length !== widgets.value.length;
    if (!changed) {
      for (let i = 0; i < nextWidgets.length; i++) {
        const current = widgets.value[i];
        const next = nextWidgets[i];
        if (!current || !next || current.id !== next.id || JSON.stringify(current) !== JSON.stringify(next)) {
          changed = true;
          break;
        }
      }
    }

    if (nextLayoutSignature === serverLayoutSignature.value && !changed) {
      return;
    }

    serverLayoutMap.value = nextServerLayoutMap;
    serverLayoutSignature.value = nextLayoutSignature;
    if (changed) {
      widgets.value = nextWidgets;
    }
  };

  const mergedWidgets = computed(() => widgets.value.map((widget) => applyWidgetUiState(widget)));

  const setWidgetUiState = (widgetId: string, patch: WidgetUiState) => {
    uiStateMap.value = {
      ...uiStateMap.value,
      [widgetId]: { ...(uiStateMap.value[widgetId] || {}), ...patch },
    };
    const index = widgets.value.findIndex((widget) => widget.id === widgetId);
    if (index >= 0) {
      const nextWidgets = [...widgets.value];
      nextWidgets[index] = applyWidgetUiState(nextWidgets[index]!);
      widgets.value = nextWidgets;
    }
  };

  const appConfig = ref<AppConfig>({
    background: "/default-wallpaper.svg",
    mobileBackground: "/default-wallpaper.svg",
    solidBackgroundColor: "",
    enableMobileWallpaper: true,
    fixedWallpaper: false,
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
      {
        id: "google",
        key: "google",
        label: "Google",
        urlTemplate: "https://www.google.com/search?q={q}",
      },
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
    // Wallpaper API defaults
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

  const CACHE_KEY = "flat-nas-data-cache";
  const stripForceNetworkMode = <T extends Record<string, unknown> | undefined>(config: T) => {
    if (!config) return config;
    const next = { ...config };
    delete (next as { forceNetworkMode?: unknown }).forceNetworkMode;
    return next;
  };
  const normalizeVersion = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  };
  const CACHE_WRITE_GUARD_MS = 15000;
  const SERVER_SNAPSHOT_RETRY_COUNT = 3;
  const SERVER_SNAPSHOT_RETRY_DELAY_MS = 1000;
  const SERVER_SNAPSHOT_TIMEOUT_MS = 6000;
  const cacheLoadedAt = ref<number | null>(null);
  const hasServerSnapshot = ref(false);
  const deferredSaveRequested = ref(false);

  const saveToCache = (data: Record<string, unknown>) => {
    try {
      const nextVersion = normalizeVersion(data.version ?? dataVersion.value);
      const cacheWidgets = Array.isArray(data.widgets)
        ? (data.widgets as WidgetConfig[]).map((widget) => stripWidgetUiState(widget))
        : data.widgets;
      const cacheData = {
        groups: data.groups,
        widgets: cacheWidgets,
        appConfig: stripForceNetworkMode((data.appConfig || undefined) as Record<string, unknown> | undefined),
        rssFeeds: data.rssFeeds,
        rssCategories: data.rssCategories,
        username: data.username || username.value,
        version: nextVersion,
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
    } catch (e) {
      console.warn("Cache save failed", e);
    }
  };

  const loadFromCache = () => {
    try {
      const json = localStorage.getItem(CACHE_KEY);
      if (!json) return false;
      const cache = JSON.parse(json);

      // Security check: only load cache if it belongs to current user
      const cachedUser = cache.username || "";
      const currentUser = username.value || "";
      // Allow loading 'admin' cache if current user is empty (guest mode / initial load)
      const isMatch = cachedUser === currentUser || (currentUser === "" && cachedUser === "admin");
      if (!isMatch) return false;

      if (cache.groups) groups.value = cache.groups;
      if (cache.widgets) {
        applyServerWidgets(normalizeIncomingWidgets(cache.widgets as WidgetConfig[]));
      }
      if (cache.appConfig) {
        appConfig.value = { ...appConfig.value, ...cache.appConfig };
        delete appConfig.value.forceNetworkMode;
      }
      if (
        !appConfig.value.marketplaceListUrl ||
        appConfig.value.marketplaceListUrl === DEV_MARKETPLACE_LIST_URL ||
        appConfig.value.marketplaceListUrl === LEGACY_DEFAULT_MARKETPLACE_LIST_URL
      ) {
        appConfig.value.marketplaceListUrl = DEFAULT_MARKETPLACE_LIST_URL;
      }
      if (cache.rssFeeds) rssFeeds.value = cache.rssFeeds;
      if (cache.rssCategories) rssCategories.value = cache.rssCategories;
      if (cache.systemConfig) systemConfig.value = cache.systemConfig;
      if (typeof cache.version !== "undefined") {
        dataVersion.value = normalizeVersion(cache.version);
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
    if (deferredSaveRequested.value) {
      deferredSaveRequested.value = false;
      saveData(true);
    }
  };
  const isServerSnapshotReady = computed(() => hasServerSnapshot.value);
  const isClientReady = computed(() => hasServerSnapshot.value || cacheLoadedAt.value !== null);

  const ensureDefaultCommonGroup = () => {
    // 逻辑已移除：允许用户删除所有分组，不再强制恢复默认分组
    /*
    const common = groups.value.find((g) => g.id === "common-group" || g.title === "常用");
    if (!common) {
      if (groups.value.length === 0) {
        groups.value = [makeDefaultCommonGroup()];
      }
      return;
    }

    if (!Array.isArray(common.items)) common.items = [];
    if (common.items.length === 0) {
      common.items = makeDefaultCommonGroup().items;
    }
    if (common.preset !== true) common.preset = true;
    */
  };

  const handleDataUpdate = (data: BackupData) => {
    isApplyingServerData = true;
    const tStart = performance.now();
    let tUser = tStart;
    // If we got username back, ensure it matches
    if (data.username && data.username !== username.value) {
      username.value = data.username;
      localStorage.setItem("flat-nas-username", data.username);
    }
    tUser = performance.now();
    if (typeof data.version !== "undefined") {
      dataVersion.value = normalizeVersion(data.version);
    }

    // Fix: Only restore items if groups is undefined (legacy data).
    // If groups is empty array [], it means user deleted all groups, so don't restore.
    if (data.items && data.items.length > 0 && !data.groups) {
      groups.value = [{ id: Date.now().toString(), title: "默认分组", items: data.items }];
      markDirty();
    } else if (data.groups) {
      groups.value = data.groups;
    } else {
      groups.value = [];
    }

    ensureDefaultCommonGroup();
    const tGroups = performance.now();

    const normalizedWidgets = normalizeIncomingWidgets(data.widgets);
    applyServerWidgets(normalizedWidgets);
    const tWidgets = performance.now();

    if (data.appConfig) {
      appConfig.value = { ...appConfig.value, ...data.appConfig };
      delete appConfig.value.forceNetworkMode;
    }
    if (
      !appConfig.value.marketplaceListUrl ||
      appConfig.value.marketplaceListUrl === DEV_MARKETPLACE_LIST_URL ||
      appConfig.value.marketplaceListUrl === LEGACY_DEFAULT_MARKETPLACE_LIST_URL
    ) {
      appConfig.value.marketplaceListUrl = DEFAULT_MARKETPLACE_LIST_URL;
    }

    // Migration for Custom Scripts List
    if (
      appConfig.value.customCss &&
      (!appConfig.value.customCssList || appConfig.value.customCssList.length === 0)
    ) {
      appConfig.value.customCssList = [
        {
          id: "default-css",
          name: "默认自定义 CSS",
          content: appConfig.value.customCss,
          enable: true,
        },
      ];
    }
    if (!appConfig.value.customCssList) appConfig.value.customCssList = [];

    if (
      appConfig.value.customJs &&
      (!appConfig.value.customJsList || appConfig.value.customJsList.length === 0)
    ) {
      appConfig.value.customJsList = [
        {
          id: "default-js",
          name: "默认自定义 JS",
          content: appConfig.value.customJs,
          enable: true,
        },
      ];
    }
    if (!appConfig.value.customJsList) appConfig.value.customJsList = [];

    if (!appConfig.value.background) appConfig.value.background = "/default-wallpaper.svg";

    if (!appConfig.value.searchEngines || appConfig.value.searchEngines.length === 0) {
      appConfig.value.searchEngines = [
        {
          id: "google",
          key: "google",
          label: "Google",
          urlTemplate: "https://www.google.com/search?q={q}",
        },
        {
          id: "bing",
          key: "bing",
          label: "Bing",
          urlTemplate: "https://cn.bing.com/search?q={q}",
        },
        {
          id: "baidu",
          key: "baidu",
          label: "百度",
          urlTemplate: "https://www.baidu.com/s?wd={q}",
        },
      ];
    }
    if (!appConfig.value.defaultSearchEngine) appConfig.value.defaultSearchEngine = "google";
    if (typeof appConfig.value.rememberLastEngine !== "boolean")
      appConfig.value.rememberLastEngine = true;

    const cachedShape = localStorage.getItem("flat-nas-icon-shape");
    if (cachedShape) appConfig.value.iconShape = cachedShape;
    const cachedColor = localStorage.getItem("flat-nas-group-title-color");
    if (cachedColor) appConfig.value.groupTitleColor = cachedColor;
    const cachedCardBg = localStorage.getItem("flat-nas-card-bg-color");
    if (cachedCardBg) appConfig.value.cardBgColor = cachedCardBg;

    if (typeof appConfig.value.widgetAreaCols !== "number") {
      if (typeof appConfig.value.widgetAreaSize === "number") {
        appConfig.value.widgetAreaCols = appConfig.value.widgetAreaSize;
      } else {
        appConfig.value.widgetAreaCols = 4;
      }
    }
    if (typeof appConfig.value.widgetAreaRows !== "number") {
      if (typeof appConfig.value.widgetAreaSize === "number") {
        appConfig.value.widgetAreaRows = appConfig.value.widgetAreaSize;
      } else {
        appConfig.value.widgetAreaRows = 4;
      }
    }
    const tConfig = performance.now();

    if (data.rssFeeds) rssFeeds.value = data.rssFeeds;
    if (data.rssCategories) rssCategories.value = data.rssCategories;
    const tRss = performance.now();

    // Fetch custom scripts separately
    fetchCustomScripts();

    // checkUpdate 仅保留在 init 与设置内显式检查时调用，避免 data-updated 导致 tags/docker-status 高频（30 分钟 TTL 由 checkUpdate 内部保证）
    // Initial snapshot load should also reset dirty state
    const currentLayoutMap = buildServerLayoutMap(widgets.value);
    lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
    // 更新快照
    lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
    layoutDirty.value = false;

    saveToCache(data);
    hasUnsavedChanges.value = false;
    const tEnd = performance.now();
    console.log("handleDataUpdate timing", {
      userMs: Math.round(tUser - tStart),
      groupsMs: Math.round(tGroups - tUser),
      widgetsMs: Math.round(tWidgets - tGroups),
      configMs: Math.round(tConfig - tWidgets),
      rssMs: Math.round(tRss - tConfig),
      tailMs: Math.round(tEnd - tRss),
      totalMs: Math.round(tEnd - tStart),
    });
    isApplyingServerData = false;
  };

  const fetchCustomScripts = async () => {
    try {
      const headers = getHeaders();
      // Skip if no token (public view might rely on embedded scripts or default config)
      if (!token.value) return;

      const res = await fetch("/api/custom-scripts", { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (Array.isArray(data.css)) appConfig.value.customCssList = data.css;
          if (Array.isArray(data.js)) appConfig.value.customJsList = data.js;
          // Apply immediately
          updateCustomScripts(false); // false = don't save back to server yet
        }
      }
    } catch (e) {
      console.error("Failed to fetch custom scripts", e);
    }
  };

  const fetchAndProcessData = async () => {
    try {
      const headers: Record<string, string> = {};
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;

      const res = await fetch(`/api/data`, { headers });
      if (!res.ok) return;
      const data = await res.json();

      if (isServerSyncLocked.value && hasUnsavedChanges.value) {
        return;
      }

      // Double check if user has started editing while we were fetching
      if (saveTimer !== null || isSaving.value) {
        return;
      }

      // 布局保护：如果本地有未保存的布局修改，提示用户
      // 注意：这里我们简单处理，如果有未保存布局，则提示用户是否覆盖
      // 实际场景中，可能需要更复杂的合并策略，但目前“提示覆盖”是比较安全的做法
      // 我们只在 layoutDirty 为 true 时提示。
      if (layoutDirty.value) {
        if (!confirm("检测到云端数据更新，但您当前有未保存的布局修改。\n是否放弃本地修改并使用云端版本覆盖？\n(取消则保留本地修改，但可能导致版本冲突)")) {
          // 用户选择保留本地，我们不应用云端数据，但更新 pendingServerVersion 以便下次有机会再同步
          // 或者也可以直接返回，不做任何事，等待用户手动保存触发冲突解决流程
          // 这里我们选择只更新版本号（如果在 data-updated 中），但这里是全量 fetch，
          // data 中包含了 version。
          // 如果我们不 apply，那么本地数据版本会落后。
          // 当用户下次保存时，会触发 409，进入冲突流程。
          return;
        }
      }

      handleDataUpdate(data);
      // 更新 lastSavedLayoutSignature，因为现在是与服务端一致了
      const currentLayoutMap = buildServerLayoutMap(widgets.value);
      lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
      // 更新快照
      lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
      layoutDirty.value = false;

      if (!hasServerSnapshot.value) {
        saveToCache(data);
        markServerSnapshotReady();
      }
    } catch (e) {
      console.error("Fetch data failed", e);
    }
  };

  let serverSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
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

  const loadServerSnapshot = async () => {
    const snapshotStart = performance.now();
    const fetchStart = performance.now();
    const res = await fetchWithTimeout("/api/data", { headers: getHeaders() });
    const fetchMs = performance.now() - fetchStart;
    if (!res.ok) {
      throw new Error(`Init failed with status ${res.status}`);
    }
    const jsonStart = performance.now();
    const data = await res.json();
    const jsonMs = performance.now() - jsonStart;
    if (data.systemConfig) {
      systemConfig.value = data.systemConfig;
    }

    if (data.username) {
      username.value = data.username;
      localStorage.setItem("flat-nas-username", data.username);
    }

    // Initial load from server snapshot
    const handleStart = performance.now();
    handleDataUpdate(data);
    // Reset dirty state
    const currentLayoutMap = buildServerLayoutMap(widgets.value);
    lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
    // 更新快照
    lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
    layoutDirty.value = false;

    const handleMs = performance.now() - handleStart;
    saveToCache(data);
    markServerSnapshotReady();
    const totalMs = performance.now() - snapshotStart;
    console.log("init snapshot timing", {
      fetchMs: Math.round(fetchMs),
      jsonMs: Math.round(jsonMs),
      handleMs: Math.round(handleMs),
      totalMs: Math.round(totalMs),
    });
  };

  const init = async () => {
    if (isInitializing) return;
    isInitializing = true;
    // #region agent log
    fetch("http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b0ccc3" },
      body: JSON.stringify({
        sessionId: "b0ccc3",
        location: "main.ts:init",
        message: "init_start",
        data: {},
        hypothesisId: "H5",
        timestamp: Date.now(),
      }),
    }).catch(() => { });
    // #endregion

    hasServerSnapshot.value = false;
    cacheLoadedAt.value = null;
    deferredSaveRequested.value = false;

    const cacheLoaded = loadFromCache();
    if (cacheLoaded) {
      cacheLoadedAt.value = Date.now();
    }

    try {
      let serverSnapshotLoaded = false;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < SERVER_SNAPSHOT_RETRY_COUNT; attempt++) {
        try {
          await loadServerSnapshot();
          serverSnapshotLoaded = true;
          setTimeout(() => {
            checkUpdate();
            fetchLuckyStunData();
          }, 2000);
          break;
        } catch (e) {
          lastError = e;
        }
        if (attempt < SERVER_SNAPSHOT_RETRY_COUNT - 1) {
          await new Promise((resolve) => setTimeout(resolve, SERVER_SNAPSHOT_RETRY_DELAY_MS));
        }
      }
      if (!serverSnapshotLoaded) {
        if (lastError) {
          console.error("Init failed", lastError);
        }
        const fallbackLoaded = loadFromCache();
        if (fallbackLoaded && cacheLoadedAt.value === null) {
          cacheLoadedAt.value = Date.now();
        }
        // 无服务端数据且无缓存时（如首次访问 / 401 未登录），仍让页面可交互，避免全屏 loading 一直挡住登录按钮
        if (cacheLoadedAt.value === null) {
          cacheLoadedAt.value = Date.now();
        }
        if (!serverSnapshotRetryTimer) {
          serverSnapshotRetryTimer = setTimeout(async () => {
            serverSnapshotRetryTimer = null;
            if (hasServerSnapshot.value) return;
            try {
              await loadServerSnapshot();
              setTimeout(() => {
                checkUpdate();
                fetchLuckyStunData();
              }, 2000);
            } catch (e) {
              console.error("Init retry failed", e);
            }
          }, SERVER_SNAPSHOT_RETRY_DELAY_MS * 3);
        }
      }
    } finally {
      // #region agent log
      fetch("http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b0ccc3" },
        body: JSON.stringify({
          sessionId: "b0ccc3",
          location: "main.ts:init finally",
          message: "init_done",
          data: {},
          hypothesisId: "H5",
          timestamp: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      isInitializing = false;
      if (!socketListenersBound) {
        let serverApplyDepth = 0;
        const withServerApply = (fn: () => void) => {
          serverApplyDepth++;
          isApplyingServerData = true;
          try {
            fn();
          } finally {
            Promise.resolve().then(() => {
              serverApplyDepth--;
              if (serverApplyDepth <= 0) {
                serverApplyDepth = 0;
                isApplyingServerData = false;
              }
            });
          }
        };

        socket.on(
          "memo:updated",
          ({ widgetId, content }: { widgetId: string; content: WidgetConfig["data"] }) => {
            withServerApply(() => {
              const w = widgets.value.find((x) => x.id === widgetId);
              if (w) w.data = content;
            });
          },
        );
        socket.on(
          "todo:updated",
          ({ widgetId, content }: { widgetId: string; content: WidgetConfig["data"] }) => {
            withServerApply(() => {
              const w = widgets.value.find((x) => x.id === widgetId);
              if (w) w.data = content;
            });
          },
        );
        socket.on(
          "data-updated",
          async ({ username: updatedUser, version }: { username: string; version?: number }) => {
            const isSameUser =
              updatedUser === username.value ||
              (username.value === "admin" && updatedUser === "admin");
            if (!isSameUser) return;

            // 如果有正在进行的保存或等待中的保存，记录服务端最新版本号后返回
            // 等保存完成后再补同步，避免快速操作时被旧的服务器状态覆盖
            if (saveTimer !== null || isSaving.value) {
              if (typeof version !== "undefined") {
                const sv = normalizeVersion(version);
                if (sv > pendingServerVersion.value) {
                  pendingServerVersion.value = sv;
                }
              }
              return;
            }

            if (typeof version !== "undefined") {
              dataVersion.value = normalizeVersion(version);
            }
            await fetchAndProcessData();
          },
        );
        socket.on("network:heartbeat", () => {
          lastNetworkHeartbeatAt = Date.now();
          updateNetworkSyncMode(true);
        });
        socket.on("connect", () => {
          if (!isInitializing) {
            fetchAndProcessData();
          }
        });
        socketListenersBound = true;
        if (typeof document !== "undefined" && !visibilityVersionCheckBound) {
          visibilityVersionCheckBound = true;
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") checkVersionAfterActivation();
          });
        }
      }
      if (token.value) {
        socket.emit("auth", { token: token.value });
      }
    }
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const isSaving = ref(false);
  // 记录是否有等待中的保存请求（在 isSaving 期间又触发了保存）
  const hasPendingSave = ref(false);
  let lastSavedJson = "";
  // 记录上次成功保存的布局签名，用于判断 layoutDirty
  const lastSavedLayoutSignature = ref("");

  const conflictState = ref({
    show: false,
    serverVersion: 0,
    clientVersion: 0,
  });
  /** 冲突解决中：此期间拦截新自动保存请求，仅置 hasPendingSave，保证数据流单一 */
  const conflictResolving = ref(false);

  /** 有未保存的本地修改；仅当用户点击「保存」或编辑模式「完成」时才真正上传 */
  const hasUnsavedChanges = ref(false);
  const markDirty = () => {
    if (isLogged.value) hasUnsavedChanges.value = true;
  };

  /** 心跳断过后再次激活且服务端版本不同时，弹窗确认是否同步 */
  const syncConfirmModal = ref({ show: false, serverVersion: 0 });
  const checkVersionAfterActivation = async () => {
    if (!isLogged.value || !heartbeatLostSinceLastVisible) return;
    heartbeatLostSinceLastVisible = false;
    try {
      const res = await fetch("/api/version", { headers: getHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { version?: number };
      const serverVer = normalizeVersion(data?.version);
      if (serverVer !== dataVersion.value) {
        syncConfirmModal.value = { show: true, serverVersion: serverVer };
      }
    } catch {
      // ignore
    }
  };
  const confirmSyncFromServer = async () => {
    syncConfirmModal.value = { show: false, serverVersion: 0 };
    await fetchAndProcessData();
  };
  const dismissSyncConfirm = () => {
    syncConfirmModal.value = { show: false, serverVersion: 0 };
  };

  const layoutDirty = ref(false);
  /** 组件区正在编辑：应用服务端数据时保留本地布局，避免外网下 409/补拉导致抖动 */
  const layoutEditInProgress = ref(false);
  // 内存中的上一次布局快照，用于撤销
  // 改名：lastSavedLayoutSnapshot，明确语义为“上次成功保存的快照”
  const lastSavedLayoutSnapshot = ref<Record<string, WidgetLayoutSnapshot> | null>(null);

  // 在保存成功时，我们更新了 lastSavedLayoutSignature。
  // 我们需要监听 widgets 的变化来更新 layoutDirty。
  // 但 widgets 是 deep reactive 的，任何变化都会触发。
  // 我们只关心布局相关的变化：id, order, x, y, w, h, colSpan, rowSpan, layouts。
  // buildServerLayoutSignature 已经只包含这些字段了。

  const checkLayoutDirty = () => {
    const currentLayoutMap = buildServerLayoutMap(widgets.value);
    const currentSig = buildServerLayoutSignature(currentLayoutMap);
    layoutDirty.value = currentSig !== lastSavedLayoutSignature.value;
  };

  // 监听 widgets 变化，防抖更新 dirty 状态
  // 注意：saveData 内部也会触发 widgets 变化（例如 stripWidgetUiState 可能不会，但如果有其他逻辑），
  // 但最重要的是，saveData 成功后会更新 lastSavedLayoutSignature，
  // 此时 checkLayoutDirty 应该会算出 false。
  watch(
    widgets,
    () => {
      checkLayoutDirty();
    },
    { deep: true }
  );

  const saveData = async (immediate = false, force = false) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    // 冲突解决期间，仅允许通过 resolveConflict 触发的 force 保存；其它保存请求只置 hasPendingSave
    if (conflictResolving.value && !force) {
      hasPendingSave.value = true;
      return;
    }

    // 移除：不要在 saveData 开始时更新快照，因为此时 widgets 已经是脏数据了！
    // 应该在保存成功后更新快照。

    const doSave = async () => {
      // 冲突状态下，除非强制保存，否则不执行任何保存
      if (conflictState.value.show && !force) {
        hasPendingSave.value = false;
        return;
      }

      const shouldSyncAfterConflict = false;
      if (isPageUnloading.value) {
        return;
      }
      if (isCacheWriteGuardActive()) {
        deferredSaveRequested.value = true;
        return;
      }

      // 如果正在保存，则标记为有待保存请求，然后返回
      if (isSaving.value) {
        hasPendingSave.value = true;
        return;
      }

      isSaving.value = true;
      // 清除 pending 标记，因为我们正在处理它（或最新的一个）
      hasPendingSave.value = false;

      try {
        if (!isLogged.value) {
          return;
        }

        // Handle force save: adopt server version to bypass conflict check
        if (force && conflictState.value.show) {
          dataVersion.value = normalizeVersion(conflictState.value.serverVersion);
        }

        const body: Record<string, unknown> = {
          groups: groups.value,
          widgets: widgets.value.map((widget) => stripWidgetUiState(widget)),
          appConfig: stripForceNetworkMode(appConfig.value as unknown as Record<string, unknown>),
          rssFeeds: rssFeeds.value,
          rssCategories: rssCategories.value,
          version: dataVersion.value,
        };
        if (typeof password.value === "string" && password.value.length > 0) {
          body.password = password.value;
        }
        const json = JSON.stringify(body);

        if (json === lastSavedJson) {
          return;
        }

        // Optimistic cache save to ensure data persistence even if network fails
        saveToCache(body);

        // Compress data
        const compressed = pako.gzip(json);

        // 保存重试逻辑：慢速网络/内网穿透环境下需要更长超时和重试
        const MAX_SAVE_RETRIES = 3;
        const SAVE_TIMEOUT_MS = 60000; // 60秒，适应慢速网络
        let saveAttempt = 0;
        let res: Response | null = null;

        while (saveAttempt < MAX_SAVE_RETRIES) {
          saveAttempt++;
          try {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
            res = await fetch("/api/save", {
              method: "POST",
              headers: {
                ...getHeaders(),
                "Content-Encoding": "gzip",
              },
              body: compressed,
              signal: controller.signal,
            }).finally(() => window.clearTimeout(timeout));

            // 成功响应，跳出重试循环
            if (res.ok || res.status === 409 || res.status === 401) {
              break;
            }

            // 服务器错误（5xx）或网络错误，准备重试
            if (saveAttempt < MAX_SAVE_RETRIES) {
              const delay = Math.min(1000 * Math.pow(2, saveAttempt - 1), 5000); // 指数退避：1s, 2s, 4s
              console.warn(`保存失败 (尝试 ${saveAttempt}/${MAX_SAVE_RETRIES})，${delay}ms 后重试...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          } catch (e) {
            // 网络错误或超时
            if (e instanceof DOMException && e.name === "AbortError") {
              if (saveAttempt < MAX_SAVE_RETRIES) {
                const delay = Math.min(1000 * Math.pow(2, saveAttempt - 1), 5000);
                console.warn(`保存超时 (尝试 ${saveAttempt}/${MAX_SAVE_RETRIES})，${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
              }
            }
            throw e; // 其他错误抛出到外层 catch
          }
        }

        if (!res) {
          throw new Error(`保存失败：已重试 ${MAX_SAVE_RETRIES} 次`);
        }

        if (res.ok) {
          conflictState.value.show = false;
          hasUnsavedChanges.value = false;
          const result = await res.json().catch(() => null);
          if (result && typeof (result as { version?: number }).version !== "undefined") {
            dataVersion.value = normalizeVersion((result as { version?: number }).version);
          }
          lastSavedJson = JSON.stringify({ ...body, version: dataVersion.value });
          // 更新上次成功保存的布局签名
          const currentLayoutMap = buildServerLayoutMap(widgets.value);
          lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
          // 更新快照，这是干净的、已保存的状态
          lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
          layoutDirty.value = false;

          if (body.password) {
            password.value = "";
          }
          saveCustomScripts();
          // 如果保存期间其他端有更新，补拉一次服务端数据以合并差异
          if (pendingServerVersion.value > dataVersion.value) {
            pendingServerVersion.value = 0;
            await fetchAndProcessData();
          } else {
            pendingServerVersion.value = 0;
          }
        }
        if (res.status === 409) {
          const result = await res.json().catch(() => null);
          const serverVer = (result as { currentVersion?: number } | null)?.currentVersion;
          if (typeof serverVer !== "undefined") {
            const v = normalizeVersion(serverVer);

            // 策略调整：如果冲突 UI 已显示，则不再自动重试，直接让用户决定
            if (conflictState.value.show) {
              // 维持冲突状态，不做任何事，等待用户操作
              return;
            }

            // [Fix Question 3] 智能冲突检测：如果是纯数据变动（布局/分组/配置未变），则静默同步
            try {
              const remoteRes = await fetch("/api/data", { headers: getHeaders() });
              if (remoteRes.ok) {
                const remoteData = await remoteRes.json();

                // 1. Check Layout
                const remoteLayoutMap = buildServerLayoutMap(remoteData.widgets || []);
                const remoteSig = buildServerLayoutSignature(remoteLayoutMap);
                const localSig = buildServerLayoutSignature(buildServerLayoutMap(widgets.value));
                const isLayoutSame = remoteSig === localSig;

                // 2. Check Groups
                // Simple JSON stringify comparison
                const remoteGroups = remoteData.groups || [];
                const localGroups = groups.value;
                const isGroupsSame = JSON.stringify(remoteGroups) === JSON.stringify(localGroups);

                // 3. Check AppConfig
                // We need to be careful about local-only fields if any, but usually appConfig is fully synced
                const remoteConfig = stripForceNetworkMode((remoteData.appConfig || {}) as Record<string, unknown>);
                const localConfig = stripForceNetworkMode(appConfig.value as unknown as Record<string, unknown>);
                const isConfigSame = JSON.stringify(remoteConfig) === JSON.stringify(localConfig);

                if (isLayoutSame && isGroupsSame && isConfigSame) {
                  // Conflict is only in widget data (e.g. Memo content, Clock style).
                  // For Memo, it handles its own sync, so global save is redundant.
                  // For others, we accept server version (Last Write Wins from server perspective for now).
                  // We sync to server state to resolve conflict without popup.
                  console.log("Non-structural conflict detected, auto-resolving by syncing from server...");

                  // Update version
                  dataVersion.value = v;

                  // Apply server data (this updates store widgets to match server)
                  handleDataUpdate(remoteData);

                  // Reset dirty state since we synced
                  const currentLayoutMap = buildServerLayoutMap(widgets.value);
                  lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
                  lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
                  layoutDirty.value = false;

                  pendingServerVersion.value = 0;
                  return;
                }
              }
            } catch (e) {
              console.warn("Smart conflict check failed", e);
            }

            // 第一次遇到 409，尝试自动采纳服务端版本号后重试一次（当前标签的改动优先）
            // 若其他端也在同步，它们会通过 data-updated 事件得到最新版本
            const retryBody = { ...body, version: v };
            const retryController = new AbortController();
            const retryTimeout = window.setTimeout(() => retryController.abort(), 60000); // 延长到 60 秒
            const retryRes = await fetch("/api/save", {
              method: "POST",
              headers: getHeaders(),
              body: JSON.stringify(retryBody),
              signal: retryController.signal,
            }).finally(() => window.clearTimeout(retryTimeout));
            if (retryRes.ok) {
              conflictState.value.show = false;
              hasUnsavedChanges.value = false;
              const retryResult = await retryRes.json().catch(() => null);
              if (retryResult && typeof (retryResult as { version?: number }).version !== "undefined") {
                dataVersion.value = normalizeVersion((retryResult as { version?: number }).version);
              } else {
                dataVersion.value = v + 1;
              }
              lastSavedJson = JSON.stringify({ ...retryBody, version: dataVersion.value });
              // 更新上次成功保存的布局签名
              const currentLayoutMap = buildServerLayoutMap(widgets.value);
              lastSavedLayoutSignature.value = buildServerLayoutSignature(currentLayoutMap);
              // 更新快照
              lastSavedLayoutSnapshot.value = JSON.parse(JSON.stringify(currentLayoutMap));
              layoutDirty.value = false;

              if (body.password) {
                password.value = "";
              }
              pendingServerVersion.value = 0;
              return;
            }
            // 仅当本次保存包含「组件区布局」或「卡片区位置」变动时才显示冲突弹窗；
            // 纯组件内容变化（如备忘录文字）与版本冲突无关，静默拉取服务端并应用，不弹窗。
            const currentLayoutSig = buildServerLayoutSignature(buildServerLayoutMap(widgets.value));
            const layoutChangedSinceLastSave = currentLayoutSig !== lastSavedLayoutSignature.value;
            let groupsUnchangedSinceLastSave = false;
            try {
              const lastBody = JSON.parse(lastSavedJson) as { groups?: unknown } | null;
              if (lastBody && Array.isArray(lastBody.groups)) {
                groupsUnchangedSinceLastSave =
                  JSON.stringify(groups.value) === JSON.stringify(lastBody.groups);
              }
            } catch {
              // 无上次保存 body 时视为有结构变动，允许弹窗
            }
            const structureChangedSinceLastSave =
              layoutChangedSinceLastSave || !groupsUnchangedSinceLastSave;
            if (!structureChangedSinceLastSave) {
              dataVersion.value = v;
              await fetchAndProcessData();
              hasPendingSave.value = false;
              return;
            }
            conflictState.value = {
              show: true,
              serverVersion: v,
              clientVersion: dataVersion.value,
            };
            hasPendingSave.value = false;
          }
          return;
        }

        if (res.status === 401) {
          token.value = "";
          username.value = "";
          isLogged.value = false;
          localStorage.removeItem("flat-nas-token");
          localStorage.removeItem("flat-nas-username");
        }
      } catch (e) {
        if (isPageUnloading.value) {
          return;
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return;
        }
        console.error("保存失败", e);
      } finally {
        isSaving.value = false;
        if (shouldSyncAfterConflict) {
          await fetchAndProcessData();
        }

        // 如果在保存期间有新的保存请求，立即再次触发保存
        if (hasPendingSave.value) {
          // 重新调用 doSave
          doSave();
        }
      }
    };

    if (immediate) {
      return doSave();
    }

    saveTimer = setTimeout(() => {
      saveTimer = null;
      doSave();
    }, 500);
  };

  if (typeof window !== "undefined") {
    bindWeatherNetworkEvents();
    const markUnloading = () => {
      isPageUnloading.value = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    };
    window.addEventListener("beforeunload", markUnloading);
    window.addEventListener("pagehide", markUnloading);
  }

  const cleanInvalidGroups = () => {
    const seen = new Set<string>();
    groups.value = groups.value.filter((g) => {
      const validId = typeof g.id === "string" && g.id.length > 0;
      const dup = validId && seen.has(g.id);
      if (validId) seen.add(g.id);
      const hasTitle = typeof g.title === "string" && g.title.trim().length > 0;
      const hasItems = Array.isArray(g.items) && g.items.length > 0;
      return validId && (hasTitle || hasItems) && !dup;
    });
  };

  const addGroup = () => {
    try {
      const id = Date.now().toString();
      const index = groups.value.length + 1;
      const title = `新建分组 ${index}`;
      groups.value.push({ id, title, items: [] });
      markDirty();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteGroup = (groupId: string, skipConfirm = false) => {
    if (!skipConfirm && !confirm("确定删除？")) return;
    groups.value = groups.value.filter((g) => g.id !== groupId);
    markDirty();
  };

  const updateGroupTitle = (groupId: string, newTitle: string) => {
    const group = groups.value.find((g) => g.id === groupId);
    if (group) {
      group.title = newTitle;
      markDirty();
    }
  };

  const updateGroup = (groupId: string, updates: Partial<NavGroup>) => {
    const group = groups.value.find((g) => g.id === groupId);
    if (group) {
      Object.assign(group, updates);
      markDirty();
    }
  };

  const addItem = (item: NavItem, groupId: string) => {
    const group = groups.value.find((g) => g.id === groupId);
    if (group) {
      group.items.push({ ...item, isPublic: item.isPublic ?? true });
      markDirty();
    }
  };

  const updateItem = (updatedItem: NavItem) => {
    for (const group of groups.value) {
      const idx = group.items.findIndex((i) => i.id === updatedItem.id);
      if (idx !== -1) {
        group.items[idx] = updatedItem;
        markDirty();
        return;
      }
    }
  };

  const deleteItem = (id: string) => {
    for (const group of groups.value) {
      const idx = group.items.findIndex((i) => i.id === id);
      if (idx !== -1) {
        group.items.splice(idx, 1);
        markDirty();
        return;
      }
    }
  };

  const login = async (usr: string, pwd: string) => {
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usr, password: pwd }),
      });
      if (res.ok) {
        const data = await res.json();
        token.value = data.token;
        username.value = data.username;
        isLogged.value = true;

        localStorage.setItem("flat-nas-token", data.token);
        localStorage.setItem("flat-nas-username", data.username);

        // Reload data for the new user
        await init();
        return true;
      }
      const data = await res.json();
      throw new Error(data.error || "Login failed");
    } catch (e: unknown) {
      console.error(e);
      throw e;
    }
  };

  const register = async (usr: string, pwd: string) => {
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usr, password: pwd }),
      });
      if (res.ok) return true;
      const data = await res.json();
      throw new Error(data.error || "Register failed");
    } catch (e: unknown) {
      console.error(e);
      throw e;
    }
  };

  const fetchUsers = async () => {
    try {
      const headers: Record<string, string> = {};
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;
      const res = await fetch("/api/admin/users", { headers });
      if (res.ok) {
        const data = await res.json();
        return data.users;
      }
      return [];
    } catch {
      return [];
    }
  };

  const addUser = async (usr: string, pwd: string) => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ username: usr, password: pwd }),
      });
      if (res.ok) return true;
      const data = await res.json();
      throw new Error(data.error || "Add user failed");
    } catch (e) {
      throw e;
    }
  };

  const deleteUser = async (usr: string) => {
    try {
      const headers: Record<string, string> = {};
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;
      const res = await fetch(`/api/admin/users/${usr}`, {
        method: "DELETE",
        headers,
      });
      if (res.ok) return true;
      throw new Error("Delete failed");
    } catch (e) {
      throw e;
    }
  };

  const uploadLicense = async (key: string) => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token.value) headers["Authorization"] = `Bearer ${token.value}`;
      const res = await fetch("/api/admin/license", {
        method: "POST",
        headers,
        body: JSON.stringify({ key }),
      });
      if (res.ok) return true;
      const data = await res.json();
      throw new Error(data.error || "Upload license failed");
    } catch (e) {
      throw e;
    }
  };

  const logout = async () => {
    token.value = "";
    username.value = "";
    isLogged.value = false;
    localStorage.removeItem("flat-nas-token");
    localStorage.removeItem("flat-nas-username");
    stopNetworkHeartbeat();

    // Reload to show default/public view
    await init();
  };

  socket.on("auth-mode-changed", (data: { mode: string }) => {
    if (data && data.mode) {
      systemConfig.value.authMode = data.mode;
    }
    if (isLogged.value) {
      // Force logout on other clients when system mode changes
      logout();
    } else {
      // Refresh to update UI state (e.g. login screen vs dashboard)
      init();
    }
  });

  const changePassword = (newPwd: string) => {
    password.value = newPwd;
  };

  const saveWidget = async (id?: string, data?: unknown) => {
    if (typeof id === "string") {
      const w = widgets.value.find((x) => x.id === id);
      if (w) w.data = data as WidgetConfig["data"];
    }
    markDirty();
  };

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

  watch(
    forceNetworkMode,
    (mode, prev) => {
      if (!mode || mode === prev) return;
      if (!isValidNetworkMode(mode)) return;
      if (isConnected.value) {
        stopNetworkHeartbeat();
        startNetworkHeartbeat();
      }
    },
  );

  watch(
    appConfig,
    () => {
      if (!isInitializing && !isApplyingServerData) {
        markDirty();
      }
    },
    { deep: true },
  );

  watch(
    widgets,
    () => {
      if (!isInitializing && !isApplyingServerData) {
        markDirty();
      }
    },
    { deep: true },
  );

  watch(
    rssFeeds,
    () => {
      if (!isInitializing && !isApplyingServerData) {
        markDirty();
      }
    },
    { deep: true },
  );

  watch(
    rssCategories,
    () => {
      if (!isInitializing && !isApplyingServerData) {
        markDirty();
      }
    },
    { deep: true },
  );

  const saveCustomScripts = async () => {
    try {
      if (!isLogged.value) return;
      const res = await fetch("/api/custom-scripts", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          css: appConfig.value.customCssList || [],
          js: appConfig.value.customJsList || [],
        }),
      });
      if (!res.ok) {
        console.error("Failed to save custom scripts");
      }
    } catch (e) {
      console.error("Error saving custom scripts", e);
    }
  };

  const updateCustomScripts = (doSave = true) => {
    if (appConfig.value.customCssList) {
      appConfig.value.customCss = appConfig.value.customCssList
        .filter((item) => item.enable)
        .map((item) => `/* ${item.name} */\n${item.content}`)
        .join("\n\n");
    }
    if (appConfig.value.customJsList) {
      appConfig.value.customJs = appConfig.value.customJsList
        .filter((item) => item.enable)
        .map((item) => `// ${item.name}\n${item.content}`)
        .join("\n\n");
    }
    if (doSave) {
      markDirty();
      saveCustomScripts();
    }
  };

  const applyMarketplaceItem = (item: MarketplaceItem) => {
    let changed = false;

    // 1. CSS
    if (item.css) {
      if (!appConfig.value.customCssList) appConfig.value.customCssList = [];
      const newId = item.id ? `css-${item.id}` : `css-${Date.now()}`;
      // Check for duplicates? Maybe not, just append.
      appConfig.value.customCssList.push({
        id: newId,
        name: item.name || "Unknown CSS",
        content: item.css,
        enable: true,
        useProxy: item.useProxy ?? false,
      });
      changed = true;
    }

    // 2. JS
    if (item.js) {
      if (!appConfig.value.customJsList) appConfig.value.customJsList = [];
      const newId = item.id ? `js-${item.id}` : `js-${Date.now()}`;
      appConfig.value.customJsList.push({
        id: newId,
        name: item.name || "Unknown JS",
        content: item.js,
        enable: true,
        useProxy: item.useProxy ?? false,
      });
      changed = true;
    }

    // 3. Component
    if (item.component) {
      const newId = "custom-css-" + Date.now();
      widgets.value.push({
        id: newId,
        type: "custom-css",
        enable: true,
        data: item.component,
        colSpan: 1,
        rowSpan: 1,
        isPublic: true,
      });
      changed = true;
    }

    if (changed) {
      updateCustomScripts();
    }
  };

  const resolveConflict = async (action: "remote" | "local") => {
    conflictState.value.show = false;
    conflictResolving.value = true;
    try {
      if (action === "remote") {
        await fetchAndProcessData();
      } else {
        await saveData(true, true);
        // 若再次 409，doSave 内会设置 conflictState.show = true，弹窗会再次出现
      }
    } finally {
      conflictResolving.value = false;
    }
  };

  const undoLayout = async () => {
    if (!lastSavedLayoutSnapshot.value) return;

    // 应用快照
    const layoutMap = lastSavedLayoutSnapshot.value;

    // 我们需要恢复的不仅仅是位置，还有可能被删除的组件（如果快照里有）
    // 但目前的逻辑主要针对位置和尺寸。
    // 如果组件被删除了，快照里有，但 widgets 里没有，这里可能无法完全恢复（因为缺少 data）。
    // 这里做简单回滚：只针对还在 widgets 里的组件恢复位置。
    // 如果要支持恢复删除，需要更复杂的快照。

    widgets.value.forEach(widget => {
      const snapshot = layoutMap[widget.id];
      if (snapshot) {
        widget.x = snapshot.x;
        widget.y = snapshot.y;
        widget.w = snapshot.w;
        widget.h = snapshot.h;
        widget.colSpan = snapshot.colSpan;
        widget.rowSpan = snapshot.rowSpan;
        widget.layouts = snapshot.layouts;
      }
    });

    // 强制保存
    await saveData(true, true);
  };

  return {
    groups,
    items,
    widgets,
    mergedWidgets,
    appConfig,
    forceNetworkMode,
    password,
    isLogged,
    token,
    username, // Export username
    getHeaders,
    isExpandedMode,
    activeMusicPlayer,
    webPaginationActiveGroupId,
    isLanModeInited,
    isLanMode,
    networkLatency,
    effectiveIsLan,
    ipFetchStatus,
    weatherNetworkStatus,
    detectWeatherNetworkStatus,
    globalDrag,
    initGlobalDrag,
    rssFeeds,
    rssCategories,
    init,
    fetchData: fetchAndProcessData,
    addGroup,
    deleteGroup,
    updateGroupTitle,
    updateGroup,
    addItem,
    updateItem,
    deleteItem,
    login,
    register,
    logout,
    changePassword,
    saveWidget,
    setWidgetUiState,
    saveData,
    cleanInvalidGroups,
    checkUpdate,
    currentVersion,
    latestVersion,
    hasUpdate,
    fetchSystemConfig,
    updateSystemConfig,
    systemConfig,
    isConnected,
    socket,
    fetchUsers,
    addUser,
    deleteUser,
    uploadLicense,
    luckyStunData,
    fetchLuckyStunData,
    getAssetUrl,
    refreshResources,
    resourceVersion,
    updateCustomScripts,
    applyMarketplaceItem,
    isServerSnapshotReady,
    isClientReady,
    conflictState,
    isSaving,
    hasPendingSave,
    hasUnsavedChanges,
    markDirty,
    lastSavedLayoutSignature,
    layoutDirty,
    layoutEditInProgress,
    resolveConflict,
    undoLayout,
    syncConfirmModal,
    confirmSyncFromServer,
    dismissSyncConfirm,
    registerDashboardPulse,
    unregisterDashboardPulse,
    startDashboardPulse,
    stopDashboardPulse,
    lockServerSync,
    unlockServerSync,
    isServerSyncLocked,
  };
});
