<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useMainStore } from "../stores/main";
import type { MarketplaceItem } from "@/types";
import OverlayMotion from "@/components/base/OverlayMotion.vue";
import { getApiBaseUrl } from "@/utils/runtimeUrls";

defineProps<{ show: boolean }>();
const emit = defineEmits(["update:show"]);
const store = useMainStore();

const close = () => emit("update:show", false);

const defaultUrl = "http://qdnas.icu:23111/";
const isLocalLikeHost = (hostname: string) => {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
};
const openUrl = computed(() => {
  const input = (store.appConfig.marketplaceListUrl || defaultUrl).trim();
  try {
    const parsed = new URL(input);
    return parsed.toString();
  } catch {
    return input;
  }
});
const isUpgradedToHttps = computed(() => {
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(openUrl.value);
    return window.location.protocol === "https:" && parsed.protocol === "http:" && !isLocalLikeHost(parsed.hostname);
  } catch {
    return false;
  }
});
const iframeUrl = computed(() => {
  if (!isUpgradedToHttps.value) return openUrl.value;
  try {
    const parsed = new URL(openUrl.value);
    parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return openUrl.value;
  }
});
const iframeRef = ref<HTMLIFrameElement | null>(null);

// ─── In-component notification state (replaces native alert/confirm) ──────────
type NoticeType = "confirm" | "success" | "error";
const notice = ref<{
  show: boolean;
  type: NoticeType;
  title: string;
  message: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}>({ show: false, type: "success", title: "", message: "" });

const showConfirm = (title: string, message: string): Promise<boolean> => {
  return new Promise((resolve) => {
    notice.value = {
      show: true,
      type: "confirm",
      title,
      message,
      onConfirm: () => { notice.value.show = false; resolve(true); },
      onCancel: () => { notice.value.show = false; resolve(false); },
    };
  });
};

const showSuccess = (title: string, message: string) => {
  notice.value = { show: true, type: "success", title, message };
  window.setTimeout(() => { notice.value.show = false; }, 3000);
};

const showError = (title: string, message: string) => {
  notice.value = { show: true, type: "error", title, message };
};

// ─── postMessage handshake ────────────────────────────────────────────────────
const onIframeLoad = () => {
  if (iframeRef.value?.contentWindow) {
    iframeRef.value.contentWindow.postMessage(
      {
        type: "FLATNAS_INFO",
        payload: {
          origin: window.location.origin,
          apiBase: getApiBaseUrl(),
          version: store.currentVersion || "unknown",
        },
      },
      new URL(iframeUrl.value).origin,
    );
  }
};

const handleMessage = async (event: MessageEvent) => {
  // Validate origin
  try {
    const allowedOrigin = new URL(iframeUrl.value).origin;
    if (event.origin !== allowedOrigin) return;
  } catch {
    return;
  }

  const { type, payload } = event.data as { type?: string; payload?: MarketplaceItem };
  if (type !== "INSTALL_COMPONENT" || !payload) return;

  const item = payload;

  // JS disclaimer check — use component dialog instead of native confirm()
  if (item.js && !store.appConfig.customJsDisclaimerAgreed) {
    const ok = await showConfirm(
      "安全提示",
      `组件 "${item.name}" 包含自定义 JavaScript 脚本。\n自定义脚本具有较高权限，可能存在安全风险。\n\n请确认您信任该组件来源，是否继续安装？`,
    );
    if (!ok) return;
    store.appConfig.customJsDisclaimerAgreed = true;
  }

  try {
    store.applyMarketplaceItem(item);
    showSuccess("安装成功", `组件 "${item.name}" 已添加到仪表盘。`);
    if (event.source) {
      (event.source as Window).postMessage({ type: "INSTALL_SUCCESS", id: item.id }, event.origin);
    }
  } catch (e) {
    showError("安装失败", e instanceof Error ? e.message : String(e));
  }
};

onMounted(() => window.addEventListener("message", handleMessage));
onUnmounted(() => window.removeEventListener("message", handleMessage));
</script>

<template>
  <OverlayMotion
    :show="show"
    :z-index="50"
    overlay-class="bg-black/50 backdrop-blur-sm p-8"
    panel-class="max-w-5xl"
  >
    <div class="bg-white w-full h-full max-h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <!-- Header -->
      <div class="flex justify-between items-center px-4 py-3 border-b border-gray-100 bg-gray-50/50 flex-shrink-0">
        <h3 class="text-base font-bold text-gray-800 flex items-center gap-2">
          <span class="text-lg">🛒</span> 组件商城
        </h3>
        <div class="flex items-center gap-4">
          <a
            :href="openUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <span>在新窗口打开</span>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
          <button @click="close" class="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Iframe content -->
      <div class="flex-1 bg-gray-50 relative">
        <div
          v-if="isUpgradedToHttps"
          class="px-4 py-2 text-xs bg-amber-50 text-amber-800 border-b border-amber-100"
        >
          当前通过 HTTPS 访问。为避免浏览器拦截 HTTP 的内嵌页面（混合内容），已尝试用 HTTPS 加载组件商城；
          若页面空白/打不开，请点右上角“在新窗口打开”使用 HTTP 打开。
        </div>
        <iframe
          ref="iframeRef"
          :src="iframeUrl"
          @load="onIframeLoad"
          class="w-full h-full border-0"
          allowfullscreen
          allow="clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
        ></iframe>
      </div>
    </div>

    <!-- In-component notice overlay -->
    <Transition name="notice-fade">
      <div
        v-if="notice.show"
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="notice.type !== 'confirm' && (notice.show = false)"
      >
        <div class="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4">
          <!-- Icon -->
          <div class="flex items-center gap-3 mb-3">
            <span v-if="notice.type === 'confirm'" class="text-2xl">⚠️</span>
            <span v-else-if="notice.type === 'success'" class="text-2xl">✅</span>
            <span v-else class="text-2xl">❌</span>
            <h4 class="font-bold text-gray-800 text-base">{{ notice.title }}</h4>
          </div>
          <!-- Message -->
          <p class="text-sm text-gray-600 whitespace-pre-line mb-5">{{ notice.message }}</p>
          <!-- Actions -->
          <div class="flex gap-2 justify-end">
            <template v-if="notice.type === 'confirm'">
              <button
                @click="notice.onCancel?.()"
                class="px-4 py-2 rounded-lg text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
              >取消</button>
              <button
                @click="notice.onConfirm?.()"
                class="px-4 py-2 rounded-lg text-sm text-white bg-blue-500 hover:bg-blue-600 transition-colors"
              >确认安装</button>
            </template>
            <template v-else>
              <button
                @click="notice.show = false"
                class="px-4 py-2 rounded-lg text-sm text-white bg-blue-500 hover:bg-blue-600 transition-colors"
              >好的</button>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </OverlayMotion>
</template>

<style scoped>
.notice-fade-enter-active,
.notice-fade-leave-active {
  transition: opacity 0.15s ease;
}
.notice-fade-enter-from,
.notice-fade-leave-to {
  opacity: 0;
}
</style>
