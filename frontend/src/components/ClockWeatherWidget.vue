<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useMainStore } from "../stores/main";
import type { WidgetConfig } from "@/types";
import { useWeather } from "@/composables/useWeather";
import { formatLocationSource } from "@/utils/weather";
import OverlayMotion from "@/components/base/OverlayMotion.vue";

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();
const debugCity = ref("");
const showDebugBadge = import.meta.env.DEV;

const cityData = ref<Record<string, string[]> | null>(null);

const loadCityData = async () => {
  if (cityData.value) return;
  try {
    const mod = await import("@/utils/cityData");
    cityData.value = mod.cityData;
  } catch (e) {
    console.error("Failed to load city data", e);
  }
};

const showCityInput = ref(false);
const customCityInput = ref("");
const selectedProvince = ref("");

watch(showCityInput, (val) => {
  if (val) {
    loadCityData();
  }
});

// Use the unified weather composable (fixes inconsistent cache read)
const { weather, locationSource, fetchWeather } = useWeather({
  widget: props.widget,
  pollIntervalMs: 15 * 60 * 1000,
});

watch(
  () => props.widget?.data?.city,
  (city, prevCity) => {
    const nextCity = typeof city === "string" ? city.trim() : "";
    const previousCity = typeof prevCity === "string" ? prevCity.trim() : "";
    customCityInput.value = nextCity;
    if (nextCity && weather.value.city !== nextCity) {
      weather.value = { ...weather.value, city: nextCity };
    }
    if (prevCity !== undefined && nextCity !== previousCity) {
      fetchWeather(true);
    }
  },
  { immediate: true },
);

const saveCity = async () => {
  try {
    if (props.widget) {
      const newCity = customCityInput.value.trim();
      const newData = { ...(props.widget.data || {}), city: newCity };
      props.widget.data = newData;
      if (newCity) {
        weather.value = { ...weather.value, city: newCity };
      }
      await store.saveSingleWidget(props.widget.id, {
        data: newData,
        enable: props.widget.enable,
      });
      fetchWeather(true);
    }
  } catch (e) {
    console.error("Failed to save city", e);
  } finally {
    showCityInput.value = false;
  }
};

// 映射天气类型
const weatherType = computed(() => {
  const text = weather.value.text;
  if (text.includes("雨")) return "rain";
  if (text.includes("雪")) return "snow";
  if (text.includes("雾") || text.includes("霾")) return "fog";
  if (text.includes("云") || text.includes("阴")) return "cloudy";
  if (text.includes("晴")) return isNight.value ? "clear-night" : "sunny";
  return "default";
});

// 计算背景样式
const bgClass = computed(() => {
  switch (weatherType.value) {
    case "sunny":
      return "bg-gradient-to-br from-blue-400 via-blue-300 to-orange-200";
    case "clear-night":
      return "bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900";
    case "cloudy":
      return "bg-gradient-to-br from-slate-400 via-slate-300 to-gray-200";
    case "rain":
      return "bg-gradient-to-br from-slate-700 via-blue-900 to-slate-800";
    case "snow":
      return "bg-gradient-to-br from-blue-100 via-white to-blue-50";
    case "fog":
      return "bg-gradient-to-br from-gray-500 via-slate-400 to-zinc-400";
    default:
      return "bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-500";
  }
});

// 判断是否为高亮天气（需要加深遮罩）
const isBrightWeather = computed(() => {
  return ["snow", "cloudy", "fog"].includes(weatherType.value);
});

// 更新时间
const time = ref("");
const date = ref("");
const isNight = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;
let alignTimer: ReturnType<typeof setTimeout> | null = null;

const updateTime = () => {
  const now = new Date();
  time.value = now.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  date.value = now.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    weekday: "short",
  });

  const hour = now.getHours();
  isNight.value = hour < 6 || hour >= 18;
};

const startTimer = () => {
  updateTime();
  if (alignTimer) clearTimeout(alignTimer);
  if (timer) clearInterval(timer);
  const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
  alignTimer = setTimeout(() => {
    updateTime();
    timer = setInterval(updateTime, 60000);
  }, msToNextMinute);
};

const stopTimer = () => {
  if (alignTimer) clearTimeout(alignTimer);
  alignTimer = null;
  if (timer) clearInterval(timer);
  timer = null;
};

const handleVisibilityChange = () => {
  if (document.visibilityState === "hidden") stopTimer();
  else startTimer();
};

const rainDrops = ref(
  Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    animationDelay: `${Math.random()}s`,
    opacity: Math.random(),
  })),
);
const snowFlakes = ref(
  Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    left: `${Math.random() * 100}%`,
    top: "-10px",
    animationDelay: `${Math.random() * 5}s`,
    animationDuration: `${3 + Math.random() * 4}s`,
  })),
);

onMounted(() => {
  startTimer();
  document.addEventListener("visibilitychange", handleVisibilityChange);
});

onUnmounted(() => {
  stopTimer();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});
</script>

<template>
  <div
    class="h-full w-full relative overflow-hidden text-white group select-none transition-all duration-500 rounded-2xl"
  >
    <!-- 动态背景层 -->
    <div class="absolute inset-0 transition-colors duration-1000 ease-in-out" :class="bgClass">
      <!-- 晴天动画 -->
      <div
        v-if="weatherType === 'sunny'"
        class="absolute -top-10 -right-10 w-48 h-48 opacity-30 animate-spin-slow"
      >
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="50" cy="50" r="20" fill="yellow" />
          <path
            d="M50 10V20 M50 80V90 M10 50H20 M80 50H90 M22 22L29 29 M71 71L78 78 M22 78L29 71 M71 29L78 22"
            stroke="yellow"
            stroke-width="4"
            stroke-linecap="round"
          />
        </svg>
      </div>

      <!-- 夜晚动画 -->
      <div v-if="weatherType === 'clear-night'" class="absolute inset-0">
        <div class="absolute top-10 right-10 w-16 h-16 text-yellow-100 opacity-80 animate-pulse">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
            />
          </svg>
        </div>
        <div
          class="star absolute top-1/4 left-1/4 w-1 h-1 bg-white rounded-full animate-twinkle"
        ></div>
        <div
          class="star absolute top-3/4 right-1/3 w-1 h-1 bg-white rounded-full animate-twinkle delay-75"
        ></div>
        <div
          class="star absolute bottom-1/4 left-1/3 w-1 h-1 bg-white rounded-full animate-twinkle delay-150"
        ></div>
      </div>

      <!-- 多云动画 -->
      <div v-if="weatherType === 'cloudy'" class="absolute inset-0 overflow-hidden">
        <div class="absolute top-4 right-[-20%] w-32 h-20 opacity-40 animate-float-slow">
          <svg viewBox="0 0 24 24" fill="currentColor" class="text-white">
            <path
              d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"
            />
          </svg>
        </div>
        <div class="absolute bottom-8 left-[-10%] w-24 h-16 opacity-30 animate-float-slower">
          <svg viewBox="0 0 24 24" fill="currentColor" class="text-white">
            <path
              d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"
            />
          </svg>
        </div>
      </div>

      <!-- 下雨动画 -->
      <div
        v-if="weatherType === 'rain'"
        class="absolute inset-0 flex justify-around items-start overflow-hidden opacity-50"
      >
        <div
          v-for="d in rainDrops"
          :key="d.id"
          class="w-0.5 h-16 bg-gradient-to-b from-transparent to-white animate-rain"
          :style="{ animationDelay: d.animationDelay, opacity: d.opacity }"
        ></div>
      </div>

      <!-- 雪天动画 -->
      <div v-if="weatherType === 'snow'" class="absolute inset-0 overflow-hidden">
        <div
          v-for="s in snowFlakes"
          :key="s.id"
          class="absolute w-1.5 h-1.5 bg-white rounded-full animate-snow opacity-80"
          :style="{
            left: s.left,
            top: s.top,
            animationDelay: s.animationDelay,
            animationDuration: s.animationDuration,
          }"
        ></div>
      </div>

      <!-- 雾天动画 -->
      <div v-if="weatherType === 'fog'" class="absolute inset-0 overflow-hidden">
        <div
          class="absolute bottom-0 left-[-50%] w-[200%] h-[60%] bg-white/20 blur-[40px] animate-fog-flow"
        ></div>
        <div
          class="absolute bottom-[-20%] left-[-20%] w-[150%] h-[50%] bg-white/10 blur-[30px] animate-fog-flow-reverse"
        ></div>
      </div>
    </div>

    <!-- 玻璃质感遮罩 -->
    <div
      class="absolute inset-0 backdrop-blur-[0px] group-hover:backdrop-blur-[2px] transition-all duration-500"
      :class="isBrightWeather ? 'bg-black/30' : 'bg-black/5'"
    ></div>

    <!-- 开发调试标签 -->
    <div
      v-if="showDebugBadge"
      class="absolute left-2 bottom-2 z-20 px-2 py-1 rounded-md bg-black/45 text-[10px] leading-tight text-white/90 backdrop-blur-sm border border-white/15"
    >
      <div>定位: {{ formatLocationSource(locationSource) }}</div>
      <div>请求城市: {{ weather.city }}</div>
    </div>

    <!-- 设置按钮 -->
    <div
      v-if="props.widget && store.isLogged"
      class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-20"
    >
      <button
        @click.stop="showCityInput = true"
        class="p-1.5 bg-black/10 text-white/70 hover:text-white rounded-full hover:bg-black/30 backdrop-blur-md transition-colors"
        title="设置城市"
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
            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
          />
        </svg>
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="relative z-10 h-full flex flex-col justify-between p-2 sm:p-3">
      <!-- Location Source Hint -->
      <div class="absolute bottom-1 left-2 text-[10px] text-white/40 z-20 select-none pointer-events-none">
        {{ formatLocationSource(locationSource) }}
      </div>
      <!-- 顶部：日期与城市 -->
      <div class="flex items-start justify-between">
        <!-- 日期 -->
        <span
          class="text-[10px] sm:text-xs font-bold tracking-widest uppercase bg-white/10 px-1.5 py-0.5 rounded backdrop-blur-md border border-white/10 shadow-sm"
          >{{ date }}</span
        >
        <!-- 城市 -->
        <div class="relative z-20">
          <div
            @click="
              showCityInput = true;
              customCityInput = weather.city;
            "
            class="flex items-center gap-1 opacity-90 cursor-pointer hover:opacity-100 transition-opacity"
          >
            <svg class="w-3 h-3 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span class="text-xs font-medium truncate max-w-[60px]">{{ weather.city }}</span>
          </div>

          <OverlayMotion
            :show="showCityInput"
            :z-index="9999"
            overlay-class="bg-black/60 backdrop-blur-md p-4"
            panel-class="max-w-sm"
          >
              <div
                class="bg-gray-900/90 p-6 rounded-2xl border border-white/10 shadow-2xl w-full backdrop-blur-xl"
              >
                <div class="text-lg font-medium mb-4 text-white">设置城市</div>
                <input
                  v-model="customCityInput"
                  @keyup.enter="saveCity"
                  placeholder="输入城市 (为空自动)"
                  class="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white placeholder-white/40 text-left outline-none focus:bg-white/20 focus:border-white/40 mb-4 transition-all"
                  autofocus
                />

                <!-- 城市选择区域 -->
                <div class="mb-6 w-full">
                  <!-- 模式切换/面包屑 -->
                  <div class="flex items-center gap-2 mb-2 text-sm">
                    <button
                      @click="selectedProvince = ''"
                      class="text-white/50 hover:text-white transition-colors"
                      :class="{ 'font-bold text-white': !selectedProvince }"
                    >
                      省份/地区
                    </button>
                    <span v-if="selectedProvince" class="text-white/30">/</span>
                    <span v-if="selectedProvince" class="text-white font-bold">{{
                      selectedProvince
                    }}</span>
                  </div>

                  <!-- 省份列表 -->
                  <div v-if="!selectedProvince" class="grid grid-cols-4 gap-2 mb-4">
                    <button
                      v-for="province in cityData ? Object.keys(cityData) : []"
                      :key="province"
                      @click="selectedProvince = province"
                      class="px-2 py-1.5 text-xs rounded transition-colors text-center truncate border"
                      :class="
                        selectedProvince === province
                          ? 'bg-blue-500 border-blue-500 text-white shadow-md'
                          : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:border-white/20'
                      "
                    >
                      {{ province }}
                    </button>
                  </div>

                  <!-- 城市列表 -->
                  <div
                    v-else-if="cityData && cityData[selectedProvince]"
                    class="grid grid-cols-4 gap-2 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar"
                  >
                    <button
                      v-for="city in cityData[selectedProvince]"
                      :key="city"
                      @click="
                        customCityInput = city;
                        saveCity();
                      "
                      class="px-1 py-1.5 bg-white/5 hover:bg-white/20 text-white/70 hover:text-white rounded text-xs transition-colors truncate border border-white/5 hover:border-white/20"
                    >
                      {{ city }}
                    </button>
                  </div>
                  <div
                    v-else
                    class="h-[200px] flex items-center justify-center text-white/40 text-xs"
                  >
                    加载中...
                  </div>
                </div>

                <div class="flex gap-3 justify-end">
                  <button
                    @click="showCityInput = false"
                    class="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/80 rounded-lg text-sm transition-colors"
                  >
                    取消
                  </button>
                  <button
                    @click="saveCity"
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors font-medium shadow-lg shadow-blue-900/20"
                  >
                    确定
                  </button>
                </div>
              </div>
          </OverlayMotion>
        </div>
      </div>

      <!-- 中部：绝对居中的时间 -->
      <div
        class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pt-8"
      >
        <div
          class="text-3xl sm:text-4xl font-bold tracking-tighter font-mono leading-none bg-gradient-to-b from-white to-white/80 bg-clip-text text-transparent"
          :class="isBrightWeather ? 'drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : 'drop-shadow-lg'"
        >
          {{ time }}
        </div>
        <!-- 天气文字 -->
        <div class="flex items-center gap-2 mt-2">
          <span class="text-sm sm:text-base font-medium opacity-90 drop-shadow-md">{{
            weather.text
          }}</span>
          <div
            v-if="weatherType === 'sunny' || weatherType === 'clear-night'"
            class="w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]"
          ></div>
        </div>
      </div>

      <!-- 底部：天气详情 (优化对齐) -->
      <div class="flex items-end justify-between pb-0.5">
        <!-- 左侧：大温度 -->
        <div class="flex flex-col justify-end">
          <div class="text-2xl sm:text-3xl font-bold tracking-tight drop-shadow-md leading-none">
            {{ weather.temp }}<span class="text-base align-top">°</span>
          </div>
        </div>

        <!-- 右侧：详情 -->
        <div
          class="flex flex-col items-end gap-0.5 text-xs sm:text-sm font-medium opacity-80"
          v-if="weather.today && weather.today.min"
        >
          <span>🌡️ {{ weather.today.min }}°/{{ weather.today.max }}°</span>
          <span v-if="weather.humidity">💧 {{ weather.humidity }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.font-mono {
  font-family: "Monaco", "Consolas", monospace;
}

/* 动画定义 */
@keyframes spin-slow {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.animate-spin-slow {
  animation: spin-slow 20s linear infinite;
}

@keyframes float-slow {
  0%,
  100% {
    transform: translateX(0) translateY(0);
  }
  50% {
    transform: translateX(-10px) translateY(5px);
  }
}
.animate-float-slow {
  animation: float-slow 8s ease-in-out infinite;
}

@keyframes float-slower {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(15px);
  }
}
.animate-float-slower {
  animation: float-slower 12s ease-in-out infinite;
}

@keyframes rain {
  0% {
    transform: translateY(-100px);
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  100% {
    transform: translateY(200px);
    opacity: 0;
  }
}
.animate-rain {
  animation: rain 1.5s linear infinite;
}

@keyframes snow {
  0% {
    transform: translateY(0) translateX(0);
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  100% {
    transform: translateY(300px) translateX(20px);
    opacity: 0;
  }
}
.animate-snow {
  animation: snow linear infinite;
}

@keyframes twinkle {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}
.animate-twinkle {
  animation: twinkle 3s ease-in-out infinite;
}

@keyframes fog-flow {
  0% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(-10%);
  }
  100% {
    transform: translateX(0);
  }
}
.animate-fog-flow {
  animation: fog-flow 20s ease-in-out infinite;
}

@keyframes fog-flow-reverse {
  0% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(10%);
  }
  100% {
    transform: translateX(0);
  }
}
.animate-fog-flow-reverse {
  animation: fog-flow-reverse 15s ease-in-out infinite;
}
</style>
