<script setup lang="ts">
import { ref, onMounted, computed, watch, onUnmounted } from "vue";
import type { WidgetConfig } from "@/types";
import { useMainStore } from "../stores/main";
import cityData from "@/assets/city-data.json";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();

// City Data Types
interface CityNode {
  label: string;
  value: string;
  children?: CityNode[];
}

const provinces = ref<CityNode[]>(cityData);
const selectedProvince = ref<string>("");
const selectedCity = ref<string>("");
const selectedDistrict = ref<string>("");

const cities = computed(() => {
  if (!selectedProvince.value) return [];
  const p = provinces.value.find((n) => n.value === selectedProvince.value);
  return p?.children || [];
});

const districts = computed(() => {
  if (!selectedCity.value) return [];
  const c = cities.value.find((n) => n.value === selectedCity.value);
  return c?.children || [];
});

const handleProvinceChange = () => {
  selectedCity.value = "";
  selectedDistrict.value = "";
  updateConfigCity(selectedProvince.value);
};

const handleCityChange = () => {
  selectedDistrict.value = "";
  updateConfigCity(selectedCity.value);
};

const handleDistrictChange = () => {
  updateConfigCity(selectedDistrict.value);
};

const updateConfigCity = (adcode: string) => {
  configForm.value.city = adcode;
};

// Recursive helper to find path to adcode
const findPath = (nodes: CityNode[], target: string): string[] => {
  for (const node of nodes) {
    if (node.value === target) return [node.value];
    if (node.children) {
      const path = findPath(node.children, target);
      if (path.length > 0) return [node.value, ...path];
    }
  }
  return [];
};

// Init Cascading Selects from existing config
const initCascadingSelect = () => {
  const currentCity = configForm.value.city;
  if (!currentCity) {
    selectedProvince.value = "";
    selectedCity.value = "";
    selectedDistrict.value = "";
    return;
  }

  const path = findPath(provinces.value, currentCity);
  if (path.length > 0) selectedProvince.value = path[0]!;
  if (path.length > 1) selectedCity.value = path[1]!;
  if (path.length > 2) selectedDistrict.value = path[2]!;
};

interface Cast {
  date: string;
  week: string;
  dayweather: string;
  nightweather: string;
  daytemp: string;
  nighttemp: string;
  daywind: string;
  nightwind: string;
  daypower: string;
  nightpower: string;
}

interface Forecast {
  city: string;
  adcode: string;
  province: string;
  reporttime: string;
  casts: Cast[];
}

interface LiveWeather {
  province: string;
  city: string;
  adcode: string;
  weather: string;
  temperature: string;
  winddirection: string;
  windpower: string;
  humidity: string;
  reporttime: string;
}

const weatherData = ref<Forecast | null>(null);
const liveWeather = ref<LiveWeather | null>(null);
const loading = ref(false);
const errorMsg = ref("");

const isConfiguring = ref(false);
const configForm = ref({
  city: "",
  apiKey: "",
});

type CachedAmapWeather = {
  forecast: Forecast | null;
  live: LiveWeather | null;
  timestamp: number;
};

const getCacheKey = (city: string) => `flatnas_amap_cache_${city}`;

const loadCachedWeather = (city: string) => {
  try {
    const cached = localStorage.getItem(getCacheKey(city));
    if (!cached) return null;
    return JSON.parse(cached) as CachedAmapWeather;
  } catch {
    return null;
  }
};

const saveCachedWeather = (city: string, forecast: Forecast | null, live: LiveWeather | null) => {
  try {
    localStorage.setItem(
      getCacheKey(city),
      JSON.stringify({
        forecast,
        live,
        timestamp: Date.now(),
      }),
    );
  } catch {
    return;
  }
};

// Weather Type Determination
const weatherType = computed(() => {
  const w = liveWeather.value?.weather || weatherData.value?.casts[0]?.dayweather || "";
  if (!w) return "default";

  if (w.includes("晴")) return "sunny";
  if (w.includes("多云")) return "cloudy";
  if (w.includes("阴")) return "overcast";
  if (w.includes("雷")) return "thunder";
  if (w.includes("雨") || w.includes("淋")) return "rain";
  if (w.includes("雪") || w.includes("霜") || w.includes("冰")) return "snow";
  if (w.includes("雾") || w.includes("霾")) return "fog";
  if (w.includes("沙") || w.includes("尘")) return "sand";
  if (w.includes("风")) return "wind";

  return "default";
});

const weatherBgClass = computed(() => {
  const map: Record<string, string> = {
    sunny: "bg-gradient-to-br from-blue-400 via-blue-200 to-orange-100",
    cloudy: "bg-gradient-to-br from-blue-300 via-blue-100 to-gray-100",
    overcast: "bg-gradient-to-br from-gray-400 via-gray-300 to-gray-200",
    rain: "bg-gradient-to-br from-blue-300 via-gray-300 to-gray-400",
    thunder: "bg-gradient-to-br from-indigo-300 via-purple-300 to-gray-300",
    snow: "bg-gradient-to-br from-blue-100 via-white to-blue-50",
    fog: "bg-gradient-to-br from-gray-300 via-gray-200 to-gray-100",
    sand: "bg-gradient-to-br from-orange-200 via-yellow-100 to-yellow-50",
    wind: "bg-gradient-to-br from-teal-300 via-teal-100 to-blue-100",
    default: "bg-white/50",
  };
  return map[weatherType.value] || map.default;
});

const init = async () => {
  if (!props.widget.data) {
    // eslint-disable-next-line vue/no-mutating-props
    props.widget.data = {
      city: "", // Default empty to trigger IP location
      apiKey: "",
    };
  }
  configForm.value.city = props.widget.data.city || "";
  configForm.value.apiKey = props.widget.data.apiKey || "";

  const effectiveKey = props.widget.data.apiKey || store.appConfig.amapKey;

  if (effectiveKey) {
    await fetchWeather();
  } else {
    isConfiguring.value = true;
  }

  // Init selectors
  initCascadingSelect();
};

const fetchWeather = async () => {
  const localKey = props.widget.data?.apiKey;
  const globalKey = store.appConfig.amapKey;
  const apiKey = localKey || globalKey;

  if (!apiKey) {
    errorMsg.value = "请配置 API Key";
    return;
  }

  let city = props.widget.data?.city;

  loading.value = true;
  errorMsg.value = "";

  try {
    // If city is empty, try IP location
    if (!city) {
      const ipRes = await fetch(`/api/amap/ip?key=${apiKey}`);
      const ipData = await ipRes.json();
      if (ipData.status === "1" && ipData.adcode) {
        city = ipData.adcode;
        // Optionally save detected city? No, keep it dynamic as requested "auto use IP"
      } else {
        throw new Error(ipData.info || "IP 定位失败");
      }
    }

    // Fetch Forecast and Live weather in parallel
    const [forecastRes, liveRes] = await Promise.all([
      fetch(`/api/amap/weather?city=${city}&key=${apiKey}&extensions=all`),
      fetch(`/api/amap/weather?city=${city}&key=${apiKey}&extensions=base`),
    ]);

    const forecastData = await forecastRes.json();
    const liveData = await liveRes.json();
    const cached = city ? loadCachedWeather(city) : null;
    let hasUpdate = false;

    if (
      forecastData.status === "1" &&
      forecastData.forecasts &&
      forecastData.forecasts.length > 0
    ) {
      weatherData.value = forecastData.forecasts[0];
      hasUpdate = true;
    } else {
      if (cached?.forecast) {
        weatherData.value = cached.forecast;
      } else {
        errorMsg.value = forecastData.info || "获取天气预报失败";
      }
    }

    if (liveData.status === "1" && liveData.lives && liveData.lives.length > 0) {
      liveWeather.value = liveData.lives[0];
      hasUpdate = true;
    } else if (cached?.live) {
      liveWeather.value = cached.live;
    }
    if (hasUpdate && city) {
      saveCachedWeather(city, weatherData.value, liveWeather.value);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    if (city) {
      const cached = loadCachedWeather(city);
      if (cached?.forecast || cached?.live) {
        if (cached.forecast) weatherData.value = cached.forecast;
        if (cached.live) liveWeather.value = cached.live;
        errorMsg.value = "";
      } else {
        errorMsg.value = e.message || "网络请求失败";
      }
    } else {
      errorMsg.value = e.message || "网络请求失败";
    }
  } finally {
    loading.value = false;
  }
};

const saveConfig = () => {
  // eslint-disable-next-line vue/no-mutating-props
  if (!props.widget.data) props.widget.data = {};
  // eslint-disable-next-line vue/no-mutating-props
  props.widget.data.city = configForm.value.city;
  // eslint-disable-next-line vue/no-mutating-props
  props.widget.data.apiKey = configForm.value.apiKey;
  store.markDirty();
  isConfiguring.value = false;
  fetchWeather();
};

const weekMap: Record<string, string> = {
  "1": "周一",
  "2": "周二",
  "3": "周三",
  "4": "周四",
  "5": "周五",
  "6": "周六",
  "7": "周日",
};

const formatWeek = (week: string) => weekMap[week] || week;

let timer: ReturnType<typeof setInterval> | null = null;

const startPolling = () => {
  if (timer) clearInterval(timer);
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  timer = setInterval(() => {
    void fetchWeather();
  }, 2 * 60 * 60 * 1000);
};

const stopPolling = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

useResumeRefresh({
  onHidden: () => {
    stopPolling();
  },
  onVisible: () => {
    void fetchWeather();
    startPolling();
  },
  onOnline: () => {
    void fetchWeather();
    startPolling();
  },
});

onMounted(async () => {
  await init();
  startPolling();
});

onUnmounted(() => {
  stopPolling();
});

// Watch global key changes
watch(
  () => store.appConfig.amapKey,
  () => {
    if (!props.widget.data?.apiKey) {
      fetchWeather();
    }
  },
);
</script>

<template>
  <div
    class="group w-full h-full relative overflow-hidden flex flex-col rounded-2xl p-3 transition-all shadow-sm border border-white/20"
  >
    <!-- Dynamic Background Layer -->
    <div
      :class="['absolute inset-0 transition-all duration-1000 opacity-90', weatherBgClass]"
    ></div>

    <!-- Animation Layers -->
    <div
      v-if="weatherType === 'rain' || weatherType === 'thunder'"
      class="absolute inset-0 z-0 overflow-hidden pointer-events-none"
    >
      <div class="absolute inset-0 weather-rain-1"></div>
      <div class="absolute inset-0 weather-rain-2"></div>
      <div class="absolute inset-0 weather-rain-3"></div>
    </div>
    <div
      v-if="weatherType === 'snow'"
      class="absolute inset-0 weather-snow pointer-events-none z-0"
    ></div>
    <div
      v-if="weatherType === 'cloudy' || weatherType === 'overcast'"
      class="absolute inset-0 weather-clouds pointer-events-none z-0"
    ></div>
    <div
      v-if="weatherType === 'sunny'"
      class="absolute inset-0 weather-sun pointer-events-none z-0"
    ></div>

    <!-- Config Mode -->
    <div
      v-if="isConfiguring"
      class="absolute inset-0 z-20 bg-white/90 p-4 flex flex-col gap-2 overflow-y-auto"
    >
      <h3 class="font-bold text-gray-700">配置高德天气</h3>
      <div>
        <label class="text-xs text-gray-500">选择城市</label>
        <div class="flex flex-col gap-2">
          <select
            v-model="selectedProvince"
            @change="handleProvinceChange"
            class="w-full border rounded px-2 py-1 text-sm bg-white text-gray-900"
          >
            <option value="">请选择省份</option>
            <option v-for="p in provinces" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </select>

          <select
            v-if="cities.length > 0"
            v-model="selectedCity"
            @change="handleCityChange"
            class="w-full border rounded px-2 py-1 text-sm bg-white text-gray-900"
          >
            <option value="">请选择城市</option>
            <option v-for="c in cities" :key="c.value" :value="c.value">
              {{ c.label }}
            </option>
          </select>

          <select
            v-if="districts.length > 0"
            v-model="selectedDistrict"
            @change="handleDistrictChange"
            class="w-full border rounded px-2 py-1 text-sm bg-white text-gray-900"
          >
            <option value="">请选择区县</option>
            <option v-for="d in districts" :key="d.value" :value="d.value">
              {{ d.label }}
            </option>
          </select>
        </div>

        <div class="text-[10px] text-gray-400 mt-1">
          当前 Adcode: {{ configForm.city || "自动定位" }}
        </div>
      </div>
      <!-- API Key input removed as requested, using global setting -->
      <div class="flex gap-2 mt-2">
        <button @click="saveConfig" class="bg-blue-500 text-white px-3 py-1 rounded text-sm flex-1">
          保存
        </button>
        <button
          @click="isConfiguring = false"
          class="bg-gray-200 text-gray-700 px-3 py-1 rounded text-sm"
        >
          取消
        </button>
      </div>
    </div>

    <!-- Display Mode -->
    <div v-else class="relative z-10 flex flex-col h-full">
      <button
        @click="isConfiguring = true"
        class="absolute top-2 right-2 z-20 text-gray-500 hover:text-blue-600 transition-all bg-white/30 p-1 rounded-full opacity-0 group-hover:opacity-100"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      <div v-if="loading" class="flex-1 flex items-center justify-center text-gray-500 text-sm">
        加载中...
      </div>

      <div
        v-else-if="errorMsg"
        class="flex-1 flex items-center justify-center text-red-500 text-sm px-2 text-center"
      >
        {{ errorMsg }}
      </div>

      <div v-else-if="weatherData" class="flex-1 flex flex-col gap-1 overflow-auto scrollbar-hide">
        <!-- Live Weather Section -->
        <p class="text-xs text-gray-600 pl-2">
          {{ liveWeather?.reporttime || weatherData?.reporttime?.split(" ")[0] }} 发布
        </p>
        <div
          v-if="liveWeather"
          class="flex items-center justify-between bg-white/40 backdrop-blur-sm rounded-xl p-2 pr-8 mb-1 shadow-sm relative"
        >
          <div class="flex flex-col items-start">
            <h2 class="text-lg font-bold text-gray-800 drop-shadow-sm leading-none">
              {{ weatherData?.city || "未知城市" }}
            </h2>
          </div>
          <div class="flex flex-col items-end">
            <div class="flex items-baseline gap-1">
              <span class="text-3xl font-bold text-gray-800">{{ liveWeather.temperature }}°</span>
              <span class="text-sm text-gray-700 font-medium">{{ liveWeather.weather }}</span>
            </div>
            <div class="flex items-center gap-2 text-xs text-gray-600 mt-1">
              <span>湿度 {{ liveWeather.humidity }}%</span>
              <span>{{ liveWeather.winddirection }}风 {{ liveWeather.windpower }}级</span>
            </div>
          </div>
        </div>

        <div
          v-for="(cast, index) in weatherData.casts"
          :key="index"
          class="flex items-center justify-between text-sm border-b border-gray-200/30 last:border-0 pb-1 last:pb-0"
        >
          <div class="flex flex-col w-12">
            <span class="font-medium text-gray-700">{{
              index === 0 ? "今天" : formatWeek(cast.week)
            }}</span>
            <span class="text-[10px] text-gray-500">{{ cast.date.slice(5) }}</span>
          </div>
          <div class="flex flex-col items-center w-[30%]">
            <span class="text-gray-700 truncate w-full text-center">{{
              cast.dayweather === cast.nightweather
                ? cast.dayweather
                : `${cast.dayweather}转${cast.nightweather}`
            }}</span>
          </div>
          <div class="flex flex-col items-end flex-1">
            <span class="font-bold text-gray-800">{{ cast.nighttemp }}° ~ {{ cast.daytemp }}°</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Rain Animation */
.weather-rain-1,
.weather-rain-2,
.weather-rain-3 {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-repeat: repeat;
  animation: rain-fall linear infinite;
}

.weather-rain-1 {
  /* Close layer: Thicker, longer drops */
  background-image: url('data:image/svg+xml;utf8,<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="10" width="1" height="30" fill="white" opacity="0.6"/><rect x="70" y="50" width="1" height="30" fill="white" opacity="0.6"/></svg>');
  background-size: 100px 100px;
  animation-duration: 0.8s;
  z-index: 3;
}

.weather-rain-2 {
  /* Mid layer: More drops, thinner */
  background-image: url('data:image/svg+xml;utf8,<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="0" width="1" height="20" fill="white" opacity="0.4"/><rect x="50" y="30" width="1" height="20" fill="white" opacity="0.4"/><rect x="80" y="60" width="1" height="20" fill="white" opacity="0.4"/><rect x="30" y="80" width="1" height="20" fill="white" opacity="0.4"/></svg>');
  background-size: 100px 100px;
  animation-duration: 1.2s;
  z-index: 2;
}

.weather-rain-3 {
  /* Far layer: Many small drops, faint */
  background-image: url('data:image/svg+xml;utf8,<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="1" height="10" fill="white" opacity="0.2"/><rect x="25" y="25" width="1" height="10" fill="white" opacity="0.2"/><rect x="45" y="45" width="1" height="10" fill="white" opacity="0.2"/><rect x="65" y="65" width="1" height="10" fill="white" opacity="0.2"/><rect x="85" y="85" width="1" height="10" fill="white" opacity="0.2"/><rect x="15" y="55" width="1" height="10" fill="white" opacity="0.2"/><rect x="55" y="15" width="1" height="10" fill="white" opacity="0.2"/><rect x="75" y="35" width="1" height="10" fill="white" opacity="0.2"/></svg>');
  background-size: 100px 100px;
  animation-duration: 2s;
  z-index: 1;
}

@keyframes rain-fall {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: 0 100px;
  }
}

/* Snow Animation */
.weather-snow {
  background-image:
    radial-gradient(3px 3px at 20% 30%, rgba(255, 255, 255, 0.9) 50%, transparent),
    radial-gradient(2px 2px at 40% 70%, rgba(255, 255, 255, 0.9) 50%, transparent),
    radial-gradient(4px 4px at 60% 20%, rgba(255, 255, 255, 0.9) 50%, transparent),
    radial-gradient(3px 3px at 80% 50%, rgba(255, 255, 255, 0.9) 50%, transparent);
  background-size: 200px 200px;
  animation: snow 4s linear infinite;
}
@keyframes snow {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: 20px 200px;
  }
}

/* Sun Animation */
.weather-sun {
  background: radial-gradient(
    circle at 90% 10%,
    rgba(255, 255, 200, 0.6) 0%,
    rgba(255, 255, 255, 0) 50%
  );
  animation: sun-pulse 6s ease-in-out infinite;
}
@keyframes sun-pulse {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(1);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.1);
  }
}

/* Cloud Animation */
.weather-clouds {
  background: radial-gradient(
    circle at 50% 50%,
    rgba(255, 255, 255, 0.4) 0%,
    rgba(255, 255, 255, 0) 70%
  );
  background-size: 150% 150%;
  animation: cloud-move 10s ease-in-out infinite alternate;
}
@keyframes cloud-move {
  0% {
    background-position: 0% 50%;
  }
  100% {
    background-position: 100% 50%;
  }
}
</style>
