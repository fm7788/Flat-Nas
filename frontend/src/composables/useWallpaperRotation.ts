import { watch, onMounted, onUnmounted, ref, computed } from "vue";
import { useMainStore } from "../stores/main";

const STORAGE_KEY_LAST_HASH_PC = "flatnas_wallpaper_last_hash_pc";
const STORAGE_KEY_LAST_HASH_MOBILE = "flatnas_wallpaper_last_hash_mobile";
const STORAGE_KEY_LAST_PATH_PC = "flatnas_wallpaper_last_api_path_pc";
const STORAGE_KEY_LAST_PATH_MOBILE = "flatnas_wallpaper_last_api_path_mobile";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function useWallpaperRotation() {
  const store = useMainStore();

  let pcInterval: ReturnType<typeof setInterval> | null = null;
  let mobileInterval: ReturnType<typeof setInterval> | null = null;
  let apiUpdateTimer: ReturnType<typeof setInterval> | null = null;
  let dailyRecoveryTimer: ReturnType<typeof setInterval> | null = null;

  const apiUpdateError = ref("");
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;
  let backoffMultiplier = 1;
  const maxBackoffMultiplier = 8;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let isPausedDueToFailures = false;

  const isLoggedIn = computed(() => !!store.isLogged);

  const clearErrorTimer = () => {
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  };

  const showError = (message: string, autoHide = true) => {
    clearErrorTimer();
    apiUpdateError.value = message;
    if (autoHide) {
      errorTimer = setTimeout(() => {
        apiUpdateError.value = "";
        errorTimer = null;
      }, 5000);
    }
  };

  const computeBlobHash = async (blob: Blob): Promise<string> => {
    try {
      const buf = await blob.arrayBuffer();
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const hashArray = Array.from(new Uint8Array(hashBuf));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return `${blob.size}-${blob.type}`;
    }
  };

  const getStoredHash = (type: "pc" | "mobile"): string => {
    try {
      const key = type === "pc" ? STORAGE_KEY_LAST_HASH_PC : STORAGE_KEY_LAST_HASH_MOBILE;
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  };

  const setStoredHash = (type: "pc" | "mobile", hash: string) => {
    try {
      const key = type === "pc" ? STORAGE_KEY_LAST_HASH_PC : STORAGE_KEY_LAST_HASH_MOBILE;
      localStorage.setItem(key, hash);
    } catch {
      // ignore
    }
  };

  const getStoredApiPath = (type: "pc" | "mobile"): string => {
    try {
      const key = type === "pc" ? STORAGE_KEY_LAST_PATH_PC : STORAGE_KEY_LAST_PATH_MOBILE;
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  };

  const setStoredApiPath = (type: "pc" | "mobile", path: string) => {
    try {
      const key = type === "pc" ? STORAGE_KEY_LAST_PATH_PC : STORAGE_KEY_LAST_PATH_MOBILE;
      localStorage.setItem(key, path);
    } catch {
      // ignore
    }
  };

  const stripQueryParams = (url: string): string => {
    if (!url) return "";
    return url.split("?")[0] || "";
  };

  // 判断用户是否已手动切换壁纸：
  // 当前 background 与上次 API 自动设置的路径不一致，说明用户已手动改过
  const userManuallyChangedWallpaper = (type: "pc" | "mobile"): boolean => {
    const lastApiPath = getStoredApiPath(type);
    if (!lastApiPath) return false; // 还没记录过 API 路径，不算"用户改了"
    const currentBg = stripQueryParams(
      type === "pc" ? store.appConfig.background || "" : store.appConfig.mobileBackground || "",
    );
    return currentBg !== stripQueryParams(lastApiPath);
  };

  const isSameLocalDay = (ts1: number, ts2: number): boolean => {
    if (!ts1 || !ts2) return false;
    const d1 = new Date(ts1);
    const d2 = new Date(ts2);
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  };

  const rotate = (type: "pc" | "mobile") => {
    const list = type === "pc" ? store.wallpaperListPc : store.wallpaperListMobile;
    if (list.length === 0) return;

    const mode =
      type === "pc" ? store.appConfig.pcRotationMode : store.appConfig.mobileRotationMode;

    let nextWallpaper = "";

    if (mode === "random" || !mode) {
      const randomIndex = Math.floor(Math.random() * list.length);
      nextWallpaper = list[randomIndex] || "";
    } else {
      // Sequential - we need to find current index
      const currentUrl =
        type === "pc" ? store.appConfig.background : store.appConfig.mobileBackground;
      // Extract name from URL: /backgrounds/name.jpg or /mobile_backgrounds/name.jpg
      const prefix = type === "pc" ? "/backgrounds/" : "/mobile_backgrounds/";
      // Be careful with URL encoding if used, but usually it's plain

      const currentPath = (currentUrl || "").split("?")[0] || "";
      let currentName = "";
      if (currentPath === "/default-wallpaper.svg") {
        currentName = "default-wallpaper.svg";
      } else if (currentPath.startsWith(prefix)) {
        currentName = currentPath.replace(prefix, "");
      }

      let currentIndex = -1;
      if (currentName) {
        currentIndex = list.indexOf(decodeURIComponent(currentName));
        if (currentIndex === -1) {
          currentIndex = list.indexOf(currentName);
        }
      }

      const nextIndex = (currentIndex + 1) % list.length;
      nextWallpaper = list[nextIndex] || "";
    }

    let url = "";
    if (nextWallpaper === "default-wallpaper.svg") {
      url = "/default-wallpaper.svg";
    } else {
      const base =
        type === "pc"
          ? store.appConfig.wallpaperPcImageBase || "/backgrounds"
          : store.appConfig.wallpaperMobileImageBase || "/mobile_backgrounds";
      const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
      url = `${trimmed}/${encodeURIComponent(nextWallpaper)}`;
    }

    if (type === "pc") {
      store.appConfig.background = url;
    } else {
      store.appConfig.mobileBackground = url;
    }
  };

  const shouldUpdateWallpaper = (lastUpdated: number): boolean => {
    if (!lastUpdated) return true;
    // 按本地日期判断：与上次更新不是同一天即需更新
    return !isSameLocalDay(lastUpdated, Date.now());
  };

  const disableConfigEnabled = (type: "pc" | "mobile") => {
    if (type === "pc" && store.appConfig.wallpaperConfig) {
      store.appConfig.wallpaperConfig = {
        ...store.appConfig.wallpaperConfig,
        enabled: false,
      };
    } else if (type === "mobile" && store.appConfig.mobileWallpaperConfig) {
      store.appConfig.mobileWallpaperConfig = {
        ...store.appConfig.mobileWallpaperConfig,
        enabled: false,
      };
    }
    store.markDirty();
    console.info(`[Wallpaper] Disabled API auto-update for ${type} (user manually changed)`);
  };

  const checkAndUpdateApiWallpaper = async () => {
    // 未登录时不执行（避免上传失败导致计数堆积）
    if (!isLoggedIn.value) {
      console.info("[Wallpaper] Skip auto-update: user not logged in");
      return;
    }

    // 失败暂停时仅由每日恢复 timer 触发重试
    if (isPausedDueToFailures) {
      console.warn("[Wallpaper] Auto-update paused due to consecutive failures");
      return;
    }

    const pcConfig = store.appConfig.wallpaperConfig;
    const mobileConfig = store.appConfig.mobileWallpaperConfig;

    const tasks: Array<{ url: string; lastUpdated: number; type: "pc" | "mobile" }> = [];

    if (pcConfig?.enabled && pcConfig.url) {
      // 双重保险：检测用户是否已手动切换了壁纸
      if (userManuallyChangedWallpaper("pc")) {
        disableConfigEnabled("pc");
      } else {
        const lastUpdated = pcConfig.lastUpdated || 0;
        if (shouldUpdateWallpaper(lastUpdated)) {
          tasks.push({ url: pcConfig.url, lastUpdated, type: "pc" });
        }
      }
    }

    if (mobileConfig?.enabled && mobileConfig.url) {
      if (userManuallyChangedWallpaper("mobile")) {
        disableConfigEnabled("mobile");
      } else {
        const lastUpdated = mobileConfig.lastUpdated || 0;
        if (shouldUpdateWallpaper(lastUpdated)) {
          tasks.push({ url: mobileConfig.url, lastUpdated, type: "mobile" });
        }
      }
    }

    if (tasks.length === 0) return;

    let anyFailed = false;
    for (const task of tasks) {
      const result = await fetchAndUpdateWallpaper(task.url, task.type);
      if (result === "auth_failed") {
        // 登录失效：暂停，等待登录后由 watch 自动恢复
        consecutiveFailures = 0;
        backoffMultiplier = 1;
        isPausedDueToFailures = false;
        return;
      }
      if (result === "failed") {
        anyFailed = true;
        consecutiveFailures++;
        showError(`壁纸自动更新失败，已连续失败 ${consecutiveFailures} 次`);
        console.error(`[Wallpaper] Failed to update ${task.type} wallpaper`);
        break;
      }
    }

    if (anyFailed) {
      if (consecutiveFailures >= maxConsecutiveFailures) {
        // 达到上限：标记暂停，启动每日恢复 timer
        isPausedDueToFailures = true;
        console.warn(
          `[Wallpaper] Pausing auto-update after ${maxConsecutiveFailures} consecutive failures, will retry in 24h`,
        );
        showError("壁纸自动更新已暂停，将在 24 小时后重试", false);
        startDailyRecoveryTimer();
      } else {
        // 指数退避：1h -> 2h -> 4h -> 8h（最多）
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
        updateApiScheduler();
      }
      return;
    }

    // 全部成功：重置状态
    consecutiveFailures = 0;
    backoffMultiplier = 1;
    isPausedDueToFailures = false;
    stopDailyRecoveryTimer();
    apiUpdateError.value = "";
    clearErrorTimer();
    updateApiScheduler();
  };

  type FetchResult = "success" | "failed" | "auth_failed" | "no_change";

  const fetchAndUpdateWallpaper = async (
    url: string,
    type: "pc" | "mobile",
  ): Promise<FetchResult> => {
    try {
      const proxyRes = await fetch(
        `/api/wallpaper/proxy?url=${encodeURIComponent(url)}&uuid=auto-update`,
        { headers: store.getHeaders() as Record<string, string> },
      );

      if (!proxyRes.ok) {
        console.error(`[Wallpaper] Proxy request failed with status ${proxyRes.status}`);
        if (proxyRes.status === 401 || proxyRes.status === 403) {
          return "auth_failed";
        }
        return "failed";
      }

      const blob = await proxyRes.blob();

      // 内容校验：与上次同 hash 则跳过上传，但仍更新 lastUpdated 避免重复请求
      const currentHash = await computeBlobHash(blob);
      const lastHash = getStoredHash(type);
      if (currentHash && lastHash && currentHash === lastHash) {
        console.info(`[Wallpaper] ${type} content unchanged, skipping upload`);
        updateLastUpdatedOnly(type);
        return "no_change";
      }

      const formData = new FormData();
      // 后端 UploadBackground 使用 form.File["files"]（复数），字段名必须是 "files"
      formData.append("files", blob, `wallpaper_${Date.now()}.jpg`);

      const uploadUrl =
        type === "pc" ? "/api/backgrounds/upload" : "/api/mobile_backgrounds/upload";
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: store.getHeaders() as Record<string, string>,
        body: formData,
      });

      if (!uploadRes.ok) {
        console.error(`[Wallpaper] Upload failed with status ${uploadRes.status}`);
        if (uploadRes.status === 401 || uploadRes.status === 403) {
          showError("登录已过期，请重新登录后再试", false);
          return "auth_failed";
        }
        return "failed";
      }

      const data = await uploadRes.json();
      // 后端返回 { success: true, files: [{ filename, path }] }
      const uploadedPath: string | undefined = data?.files?.[0]?.path;
      if (data?.success && uploadedPath) {
        if (type === "pc") {
          store.appConfig.background = uploadedPath;
          store.appConfig.wallpaperConfig = {
            ...store.appConfig.wallpaperConfig!,
            lastUpdated: Date.now(),
          };
        } else {
          store.appConfig.mobileBackground = uploadedPath;
          store.appConfig.mobileWallpaperConfig = {
            ...store.appConfig.mobileWallpaperConfig!,
            lastUpdated: Date.now(),
          };
        }
        // 记录 API 自动设置的路径，用于下次检测"用户是否手动改过"
        setStoredApiPath(type, uploadedPath);
        if (currentHash) setStoredHash(type, currentHash);
        store.markDirty();
        store.refreshResources();
        await store.fetchWallpaperLists();
        console.info(`[Wallpaper] ${type} auto-update success: ${uploadedPath}`);
        return "success";
      }

      console.error(`[Wallpaper] Upload response invalid:`, data);
      return "failed";
    } catch (error) {
      console.error("[Wallpaper] Auto-update failed:", error);
      return "failed";
    }
  };

  const updateLastUpdatedOnly = (type: "pc" | "mobile") => {
    if (type === "pc" && store.appConfig.wallpaperConfig) {
      store.appConfig.wallpaperConfig = {
        ...store.appConfig.wallpaperConfig,
        lastUpdated: Date.now(),
      };
    } else if (type === "mobile" && store.appConfig.mobileWallpaperConfig) {
      store.appConfig.mobileWallpaperConfig = {
        ...store.appConfig.mobileWallpaperConfig,
        lastUpdated: Date.now(),
      };
    }
    store.markDirty();
  };

  const updatePcInterval = () => {
    if (pcInterval) clearInterval(pcInterval);
    if (store.appConfig.pcRotation) {
      const minutes = Math.max(1, store.appConfig.pcRotationInterval || 30);
      pcInterval = setInterval(() => rotate("pc"), minutes * 60 * 1000);
    }
  };

  const updateMobileInterval = () => {
    if (mobileInterval) clearInterval(mobileInterval);
    if (store.appConfig.mobileRotation) {
      const minutes = Math.max(1, store.appConfig.mobileRotationInterval || 30);
      mobileInterval = setInterval(() => rotate("mobile"), minutes * 60 * 1000);
    }
  };

  const updateApiScheduler = () => {
    if (apiUpdateTimer) clearInterval(apiUpdateTimer);

    const pcConfig = store.appConfig.wallpaperConfig;
    const mobileConfig = store.appConfig.mobileWallpaperConfig;

    const pcEnabled = pcConfig?.enabled === true;
    const mobileEnabled = mobileConfig?.enabled === true;

    if (pcEnabled || mobileEnabled) {
      const intervalMs = ONE_HOUR_MS * backoffMultiplier;
      apiUpdateTimer = setInterval(checkAndUpdateApiWallpaper, intervalMs);
      console.info(`[Wallpaper] Scheduler set, next check in ${backoffMultiplier}h`);
    } else {
      resetError();
      stopDailyRecoveryTimer();
    }
  };

  const startDailyRecoveryTimer = () => {
    stopDailyRecoveryTimer();
    // 暂停后每 24 小时尝试一次恢复
    dailyRecoveryTimer = setInterval(() => {
      console.info("[Wallpaper] Daily recovery attempt: resetting failure state");
      consecutiveFailures = 0;
      backoffMultiplier = 1;
      isPausedDueToFailures = false;
      apiUpdateError.value = "";
      updateApiScheduler();
      void checkAndUpdateApiWallpaper();
    }, ONE_DAY_MS);
  };

  const stopDailyRecoveryTimer = () => {
    if (dailyRecoveryTimer) {
      clearInterval(dailyRecoveryTimer);
      dailyRecoveryTimer = null;
    }
  };

  const resetError = () => {
    clearErrorTimer();
    apiUpdateError.value = "";
    consecutiveFailures = 0;
    backoffMultiplier = 1;
    isPausedDueToFailures = false;
    stopDailyRecoveryTimer();
  };

  // Watchers
  watch(
    () => [store.appConfig.pcRotation, store.appConfig.pcRotationInterval],
    () => {
      updatePcInterval();
    },
  );

  watch(
    () => [store.appConfig.mobileRotation, store.appConfig.mobileRotationInterval],
    () => {
      updateMobileInterval();
    },
  );

  watch(
    () => [
      store.appConfig.wallpaperConfig?.enabled,
      store.appConfig.mobileWallpaperConfig?.enabled,
    ],
    () => {
      resetError();
      updateApiScheduler();
    },
  );

  // 监听登录状态：登录后自动恢复调度器并立即检查一次
  watch(
    () => store.isLogged,
    (logged) => {
      if (logged) {
        console.info("[Wallpaper] User logged in, resuming auto-update");
        resetError();
        updateApiScheduler();
        void checkAndUpdateApiWallpaper();
      } else {
        // 未登录时停止调度器，避免无效请求
        if (apiUpdateTimer) clearInterval(apiUpdateTimer);
        apiUpdateTimer = null;
        stopDailyRecoveryTimer();
      }
    },
  );

  onMounted(() => {
    // 初始化时立即清除错误状态，避免历史遗留错误显示
    resetError();

    store.fetchWallpaperLists().finally(() => {
      updatePcInterval();
      updateMobileInterval();
      // 延迟 5 秒再启动 API 调度器，给页面加载时间
      setTimeout(() => {
        updateApiScheduler();
        // 启动后立即检查一次（处理"启动时已经跨天"的场景）
        if (isLoggedIn.value) {
          void checkAndUpdateApiWallpaper();
        }
      }, 5000);
    });
  });

  onUnmounted(() => {
    if (pcInterval) clearInterval(pcInterval);
    if (mobileInterval) clearInterval(mobileInterval);
    if (apiUpdateTimer) clearInterval(apiUpdateTimer);
    stopDailyRecoveryTimer();
    clearErrorTimer();
  });

  return {
    rotate,
    apiUpdateError,
    resetError,
  };
}
