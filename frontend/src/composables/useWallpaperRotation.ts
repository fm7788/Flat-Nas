import { watch, onMounted, onUnmounted, ref } from "vue";
import { useMainStore } from "../stores/main";

export function useWallpaperRotation() {
  const store = useMainStore();

  let pcInterval: ReturnType<typeof setInterval> | null = null;
  let mobileInterval: ReturnType<typeof setInterval> | null = null;
  let apiUpdateTimer: ReturnType<typeof setInterval> | null = null;

  const apiUpdateError = ref("");
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;
  let backoffMultiplier = 1;

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

  const checkAndUpdateApiWallpaper = async () => {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      console.warn("[Wallpaper] Max consecutive failures reached, pausing auto-update");
      return;
    }

    const pcConfig = store.appConfig.wallpaperConfig;
    const mobileConfig = store.appConfig.mobileWallpaperConfig;

    const tasks: Array<{ url: string; lastUpdated: number; type: "pc" | "mobile" }> = [];

    if (pcConfig?.enabled && pcConfig.url) {
      const lastUpdated = pcConfig.lastUpdated || 0;
      const hoursSinceUpdate = (Date.now() - lastUpdated) / (1000 * 60 * 60);
      if (hoursSinceUpdate >= 24) {
        tasks.push({ url: pcConfig.url, lastUpdated, type: "pc" });
      }
    }

    if (mobileConfig?.enabled && mobileConfig.url) {
      const lastUpdated = mobileConfig.lastUpdated || 0;
      const hoursSinceUpdate = (Date.now() - lastUpdated) / (1000 * 60 * 60);
      if (hoursSinceUpdate >= 24) {
        tasks.push({ url: mobileConfig.url, lastUpdated, type: "mobile" });
      }
    }

    if (tasks.length === 0) return;

    apiUpdateError.value = "";

    for (const task of tasks) {
      const success = await fetchAndUpdateWallpaper(task.url, task.type);
      if (!success) {
        consecutiveFailures++;
        apiUpdateError.value = `壁纸自动更新失败，已连续失败 ${consecutiveFailures} 次`;
        console.error(`[Wallpaper] Failed to update ${task.type} wallpaper`);
        return;
      }
    }

    consecutiveFailures = 0;
    backoffMultiplier = 1;
    apiUpdateError.value = "";
  };

  const fetchAndUpdateWallpaper = async (url: string, type: "pc" | "mobile"): Promise<boolean> => {
    try {
      const proxyRes = await fetch(
        `/api/wallpaper/proxy?url=${encodeURIComponent(url)}&uuid=auto-update`,
        { headers: store.getHeaders() as Record<string, string> },
      );

      if (!proxyRes.ok) {
        console.error(`[Wallpaper] Proxy request failed with status ${proxyRes.status}`);
        return false;
      }

      const blob = await proxyRes.blob();
      const formData = new FormData();
      formData.append("file", blob, `wallpaper_${Date.now()}.jpg`);

      const uploadUrl = type === "pc" ? "/api/backgrounds/upload" : "/api/mobile_backgrounds/upload";
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: store.getHeaders() as Record<string, string>,
        body: formData,
      });

      if (!uploadRes.ok) {
        console.error(`[Wallpaper] Upload failed with status ${uploadRes.status}`);
        if (uploadRes.status === 401 || uploadRes.status === 403) {
          apiUpdateError.value = "登录已过期，请重新登录后再试";
          consecutiveFailures = maxConsecutiveFailures;
        }
        return false;
      }

      const data = await uploadRes.json();
      if (data.success && data.path) {
        if (type === "pc") {
          store.appConfig.background = data.path;
          store.appConfig.wallpaperConfig = {
            ...store.appConfig.wallpaperConfig!,
            lastUpdated: Date.now(),
          };
        } else {
          store.appConfig.mobileBackground = data.path;
          store.appConfig.mobileWallpaperConfig = {
            ...store.appConfig.mobileWallpaperConfig!,
            lastUpdated: Date.now(),
          };
        }
        store.markDirty();
        store.refreshResources();
        await store.fetchWallpaperLists();
        return true;
      }

      return false;
    } catch (error) {
      console.error("[Wallpaper] Auto-update failed:", error);
      return false;
    }
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

    if (pcConfig?.enabled || mobileConfig?.enabled) {
      const baseInterval = 60 * 60 * 1000;
      apiUpdateTimer = setInterval(checkAndUpdateApiWallpaper, baseInterval * backoffMultiplier);
      setTimeout(checkAndUpdateApiWallpaper, 2000);
    }
  };

  const resetError = () => {
    apiUpdateError.value = "";
    consecutiveFailures = 0;
    backoffMultiplier = 1;
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
    () => [store.appConfig.wallpaperConfig?.enabled, store.appConfig.mobileWallpaperConfig?.enabled],
    () => {
      resetError();
      updateApiScheduler();
    },
  );

  onMounted(() => {
    store.fetchWallpaperLists().finally(() => {
      updatePcInterval();
      updateMobileInterval();
      updateApiScheduler();
    });
  });

  onUnmounted(() => {
    if (pcInterval) clearInterval(pcInterval);
    if (mobileInterval) clearInterval(mobileInterval);
    if (apiUpdateTimer) clearInterval(apiUpdateTimer);
  });

  return {
    rotate,
    apiUpdateError,
    resetError,
  };
}
