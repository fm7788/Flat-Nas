import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import type { WidgetConfig } from "@/types";
import { useMainStore } from "@/stores/main";
import {
  isValidCity,
  resolveCityFromIp,
  getFallbackCity,
  safeReadCachedCity,
  safeWriteCachedCity,
} from "@/utils/weather";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

export interface WeatherData {
  temp: string;
  city: string;
  text: string;
  humidity: string;
  today: { min: string; max: string };
  forecast: Array<{ date: string; mintempC: string; maxtempC: string }>;
}

export interface UseWeatherOptions {
  widget: WidgetConfig | undefined;
  pollIntervalMs?: number; // default 15 min
}

/**
 * Unified weather fetching composable.
 * Reads weather data from backend cache (/api/weather) instead of
 * calling external APIs directly. The backend handles polling & fallback.
 */
export function useWeather(opts: UseWeatherOptions) {
  const store = useMainStore();
  const weather = ref<WeatherData>({
    temp: "--",
    city: getInitialCity(),
    text: "...",
    humidity: "",
    today: { min: "", max: "" },
    forecast: [],
  });
  const locationSource = ref<"auto" | "manual" | "cache" | "fallback">("auto");
  const networkStatus = computed(() => store.weatherNetworkStatus);

  const pollIntervalMs = opts.pollIntervalMs ?? 15 * 60 * 1000;
  let weatherTimer: ReturnType<typeof setInterval> | null = null;
  let activeCleanup: (() => void) | undefined;
  let activeController: AbortController | undefined;
  let activeRequestId = 0;

  function getInitialCity(): string {
    if (opts.widget?.data?.city) return opts.widget.data.city;
    const cache = safeReadCachedCity(localStorage.getItem("flatnas_auto_city"));
    if (cache?.city) return cache.city;
    return "定位中...";
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchIpWithRetry = async (attempts = 2): Promise<any> => {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const ipRes = await fetch("/api/ip", { cache: "no-store" });
        if (!ipRes.ok) throw new Error("IP API Error");
        return await ipRes.json();
      } catch (error) {
        lastError = error;
        if (i < attempts - 1) {
          const backoff = 300 * 2 ** i + Math.floor(Math.random() * 200);
          await wait(backoff);
        }
      }
    }
    throw lastError;
  };

  const getCacheTtl = (status: "online" | "degraded" | "offline") => {
    if (status === "offline") return 24 * 60 * 60 * 1000;
    if (status === "degraded") return 6 * 60 * 60 * 1000;
    return 60 * 60 * 1000;
  };

  const isCacheValid = (timestamp: number, duration: number) => {
    return Date.now() - timestamp < duration;
  };

  const resolveCity = async (): Promise<{ city: string; source: string }> => {
    let city = "Shanghai";
    let source: "auto" | "manual" | "cache" | "fallback" = "auto";

    // Priority 1: Manual city from widget config
    if (opts.widget?.data?.city) {
      city = opts.widget.data.city;
      source = "manual";
      return { city, source };
    }

    // Priority 2: Cached auto-located city
    const cached = safeReadCachedCity(localStorage.getItem("flatnas_auto_city"));
    const status = await store.detectWeatherNetworkStatus();
    const ttl = getCacheTtl(status);

    if (cached && isCacheValid(cached.timestamp, ttl) && isValidCity(cached.city)) {
      city = cached.city;
      source = "cache";
      return { city, source };
    }

    // Priority 3: Resolve from IP
    try {
      const ipData = await fetchIpWithRetry(3);
      if (ipData.success) {
        const resolved = resolveCityFromIp(ipData);
        if (resolved) {
          city = resolved;
          source = "auto";
          safeWriteCachedCity({
            city,
            timestamp: Date.now(),
            source: "auto",
            confidence: status === "online" ? "high" : "medium",
          });
          return { city, source };
        }
      }
    } catch {
      // fall through to fallback
    }

    // Priority 4: Fallback
    city = getFallbackCity(cached?.city ?? null);
    source = "fallback";
    return { city, source };
  };

  const buildWeatherUrl = (city: string) => {
    const weatherSource = store.appConfig.weatherSource || "uapi";
    const key = store.appConfig.amapKey || "";
    const projectId = store.appConfig.qweatherProjectId || "";
    const keyId = store.appConfig.qweatherKeyId || "";
    const privateKey = store.appConfig.qweatherPrivateKey || "";

    let url = `/api/weather?city=${encodeURIComponent(city)}&source=${weatherSource}&key=${encodeURIComponent(key)}`;
    if (weatherSource === "qweather") {
      url += `&projectId=${encodeURIComponent(projectId)}&keyId=${encodeURIComponent(keyId)}&privateKey=${encodeURIComponent(privateKey)}`;
    }
    return url;
  };

  const fetchWeather = async (_force = false) => {
    activeCleanup?.();
    activeController?.abort();
    activeController = undefined;
    const requestId = ++activeRequestId;

    let city = "定位中...";
    let source: "auto" | "manual" | "cache" | "fallback" = "auto";

    try {
      const resolved = await resolveCity();
      city = resolved.city;
      source = resolved.source as any;
    } catch (e) {
      console.warn("[useWeather] City resolution failed, using fallback", e);
      city = "Shanghai";
      source = "fallback";
    }

    locationSource.value = source;

    const controller = new AbortController();
    activeController = controller;
    const cleanup = () => {
      if (activeCleanup === cleanup) activeCleanup = undefined;
      if (activeController === controller) activeController = undefined;
    };
    activeCleanup = cleanup;

    try {
      const timeoutTimer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(buildWeatherUrl(city), {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeoutTimer);

      if (!res.ok) throw new Error("Weather API failed");
      const j = await res.json();
      if (!j.success || !j.data) throw new Error("Weather payload invalid");
      if (requestId !== activeRequestId) return;

      weather.value = {
        ...j.data,
        city: j.data.city || city,
      } as WeatherData;
    } catch {
      if (requestId !== activeRequestId) return;
      weather.value = {
        temp: "--",
        city: city,
        text: "获取失败",
        humidity: "",
        today: { min: "", max: "" },
        forecast: [],
      };
    } finally {
      cleanup();
    }
  };

  const startPolling = () => {
    weatherTimer = setInterval(fetchWeather, pollIntervalMs);
  };

  const stopPolling = () => {
    if (weatherTimer) {
      clearInterval(weatherTimer);
      weatherTimer = null;
    }
  };

  useResumeRefresh({
    onHidden: () => {
      stopPolling();
    },
    onVisible: () => {
      void fetchWeather(true);
      stopPolling();
      startPolling();
    },
    onOnline: () => {
      void fetchWeather(true);
      stopPolling();
      startPolling();
    },
  });

  onMounted(() => {
    void fetchWeather();
    startPolling();
  });

  onUnmounted(() => {
    stopPolling();
    activeCleanup?.();
    activeController?.abort();
  });

  // Watch for weather source changes
  watch(
    () => [store.appConfig.weatherSource, store.appConfig.amapKey],
    () => {
      fetchWeather(true);
    }
  );

  return {
    weather,
    locationSource,
    networkStatus,
    fetchWeather,
    saveCity: (newCity: string) => {
      if (opts.widget) {
        if (!opts.widget.data) opts.widget.data = {};
        opts.widget.data.city = newCity;
        fetchWeather(true);
      }
    },
  };
}
