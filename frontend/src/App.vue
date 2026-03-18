<script setup lang="ts">
import { onMounted, watch, computed, ref } from "vue";
import GridPanel from "./components/GridPanel.vue";
import StatusMonitor from "./components/StatusMonitor.vue";
import { useMainStore } from "./stores/main";
import type { CustomScript, MarketplaceItem } from "@/types";
import { useWindowScroll, useWindowSize } from "@vueuse/core";

const store = useMainStore();
const { y } = useWindowScroll();
const { width: windowWidth, height: windowHeight } = useWindowSize();

const showBackToTop = computed(() => y.value > windowHeight.value);
const statusMonitorWidget = computed(() => store.widgets.find((w) => w.type === "status-monitor"));
const saveErrorMessage = ref("");
let saveErrorTimer: number | null = null;

const pushSaveError = (message: string) => {
  saveErrorMessage.value = message;
  if (saveErrorTimer) {
    window.clearTimeout(saveErrorTimer);
  }
  saveErrorTimer = window.setTimeout(() => {
    saveErrorMessage.value = "";
    saveErrorTimer = null;
  }, 6000);
};
// Auto-detect ultrawide screen
const checkUltrawide = () => {
  if (!store.appConfig.autoUltrawide) {
    store.isExpandedMode = false;
    return;
  }

  const windowRatio = windowWidth.value / windowHeight.value;
  const screenRatio = window.screen.width / window.screen.height;
  // 21:9 ≈ 2.33, 32:9 ≈ 3.55
  // Consider ultrawide if either ratio > 2.3
  store.isExpandedMode = windowRatio > 2.3 || screenRatio > 2.3;
};

// Check on resize and config change
watch(
  [windowWidth, windowHeight, () => store.appConfig.autoUltrawide],
  () => {
    checkUltrawide();
  },
  { immediate: true },
);

const scrollToTop = () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
};

watch(
  () => store.appConfig.customTitle,
  (newTitle) => {
    document.title = newTitle || "FlatNas";
  },
  { immediate: true },
);

watch(
  () => store.appConfig.customCss,
  (newCss) => {
    const raw = String(newCss || "");
    const build = (input: string) => {
      const src = String(input || "");
      const re = /\/\*\s*@(?<tag>[a-zA-Z_-]+)\s*\*\/([\s\S]*?)\/\*\s*@end\s*\*\//g;
      const blocks: Array<{ tag: string; body: string }> = [];
      const base = src.replace(re, (...args) => {
        const groups = args[args.length - 1] as { tag?: string } | undefined;
        const tag = String(groups?.tag || "").toLowerCase();
        const body = String(args[1] || "");
        if (tag) blocks.push({ tag, body });
        return "";
      });

      const extra = blocks
        .map((b) => {
          const body = String(b.body || "").trim();
          if (!body) return "";
          if (b.tag === "mobile") return `@media (max-width: 768px) {\n${body}\n}`;
          if (b.tag === "desktop") return `@media (min-width: 769px) {\n${body}\n}`;
          if (b.tag === "dark") return `@media (prefers-color-scheme: dark) {\n${body}\n}`;
          if (b.tag === "light") return `@media (prefers-color-scheme: light) {\n${body}\n}`;
          return body;
        })
        .filter(Boolean)
        .join("\n\n");

      return [base.trim(), extra.trim()].filter(Boolean).join("\n\n");
    };

    const css = build(raw);
    let style = document.getElementById("custom-css") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "custom-css";
      document.head.appendChild(style);
    }
    style.textContent = css;
  },
  { immediate: true },
);

type CustomHooks = {
  init?: (ctx: CustomCtx) => void | Promise<void>;
  update?: (ctx: CustomCtx) => void | Promise<void>;
  destroy?: (ctx: CustomCtx) => void | Promise<void>;
};

// Readonly view of the store exposed to custom scripts.
// Only data properties are exposed — no mutation methods.
type ReadonlyCtxStore = {
  readonly widgets: ReturnType<typeof useMainStore>["widgets"];
  readonly groups: ReturnType<typeof useMainStore>["groups"];
  readonly appConfig: ReturnType<typeof useMainStore>["appConfig"];
  readonly isLogged: boolean;
  readonly currentVersion: string | undefined;
};

type CustomCtx = {
  store: ReadonlyCtxStore;
  root: HTMLElement | null;
  query: (selector: string) => Element | null;
  queryAll: (selector: string) => Element[];
  widgetEl: (id: string) => HTMLElement | null;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  onCleanup: (fn: () => void) => void;
  on: (type: string, handler: (ev: CustomEvent) => void) => () => void;
  emit: (type: string, detail?: unknown) => void;
};

// How long to wait (ms) before triggering the update() hook after a DOM mutation.
const UPDATE_DEBOUNCE_MS = 300;

const customJsRuntime = (() => {
  const scriptClass = "custom-js-injected";
  const cleanupFns: Array<() => void> = [];
  let hooks: CustomHooks | null = null;
  let observer: MutationObserver | null = null;
  let updateTimer: number | null = null;
  let pendingRegister: CustomHooks | null = null;
  let currentNonce = 0;

  const getRoot = () => (document.getElementById("app") as HTMLElement | null) || null;
  const clearUpdateTimer = () => {
    if (updateTimer) window.clearTimeout(updateTimer);
    updateTimer = null;
  };

  // Read-only store proxy: exposes data but hides all action methods.
  const readonlyStore: ReadonlyCtxStore = {
    get widgets() { return store.widgets; },
    get groups() { return store.groups; },
    get appConfig() { return store.appConfig; },
    get isLogged() { return store.isLogged; },
    get currentVersion() { return store.currentVersion; },
  };

  // ctx.fetch: auto-proxies cross-origin requests through /proxy?url=
  const ctxFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const urlStr = typeof input === "string" ? input : (input instanceof URL ? input.href : (input as Request).url);
      if (urlStr.startsWith("http")) {
        const parsed = new URL(urlStr);
        if (parsed.hostname !== window.location.hostname) {
          return await window.fetch("/proxy?url=" + encodeURIComponent(urlStr), init);
        }
      }
    } catch { /* fall through to normal fetch */ }
    return window.fetch(input, init);
  };

  const ctx: CustomCtx = {
    store: readonlyStore,
    get root() { return getRoot(); },
    query(selector: string) {
      return getRoot()?.querySelector(selector) || null;
    },
    queryAll(selector: string) {
      return Array.from(getRoot()?.querySelectorAll(selector) || []);
    },
    widgetEl(id: string) {
      return document.getElementById(`widget-${id}`) as HTMLElement | null;
    },
    fetch: ctxFetch,
    onCleanup(fn: () => void) {
      if (typeof fn === "function") cleanupFns.push(fn);
    },
    on(type: string, handler: (ev: CustomEvent) => void) {
      const t = `flatnas:${type}`;
      const wrapped = (e: Event) => handler(e as CustomEvent);
      window.addEventListener(t, wrapped as EventListener);
      const off = () => window.removeEventListener(t, wrapped as EventListener);
      cleanupFns.push(off);
      return off;
    },
    emit(type: string, detail?: unknown) {
      window.dispatchEvent(new CustomEvent(`flatnas:${type}`, { detail }));
    },
  };

  const removeScripts = () => {
    document.querySelectorAll(`.${scriptClass}`).forEach((el) => el.remove());
  };

  const doDestroy = async () => {
    clearUpdateTimer();
    if (observer) observer.disconnect();
    observer = null;
    try {
      await hooks?.destroy?.(ctx);
    } catch (e) {
      console.error("Custom JS destroy failed:", e);
    }
    hooks = null;
    while (cleanupFns.length) {
      const fn = cleanupFns.pop();
      try { fn?.(); } catch { /* ignore cleanup errors */ }
    }
    removeScripts();
  };

  const scheduleUpdate = () => {
    clearUpdateTimer();
    updateTimer = window.setTimeout(async () => {
      updateTimer = null;
      try {
        await hooks?.update?.(ctx);
      } catch (e) {
        console.error("Custom JS update failed:", e);
      }
    }, UPDATE_DEBOUNCE_MS);
  };

  const ensureObserver = () => {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!hooks?.update) return;
      scheduleUpdate();
    });
    // Observe only childList + subtree to reduce noise; attribute changes excluded.
    observer.observe(getRoot() || document.body, { subtree: true, childList: true });
    cleanupFns.push(() => observer?.disconnect());
  };

  const setRegister = () => {
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.FlatNasCustomRegister === "function") return;
    w.FlatNasCustomRegister = (h: unknown) => {
      if (!h || typeof h !== "object") return;
      pendingRegister = h as CustomHooks;
    };
  };

  const adoptHooks = async (h: CustomHooks | null) => {
    hooks = h;
    if (!hooks) return;
    try {
      await hooks.init?.(ctx);
    } catch (e) {
      console.error("Custom JS init failed:", e);
    }
    ensureObserver();
    scheduleUpdate();
  };

  const apply = async (input: string | CustomScript[], agreed: boolean) => {
    currentNonce++;
    const nonce = currentNonce;
    await doDestroy();
    setRegister();
    pendingRegister = null;

    const w = window as unknown as Record<string, unknown>;
    w.FlatNasCustomCtx = ctx;

    if (!agreed) return;

    let scripts: CustomScript[] = [];
    if (Array.isArray(input)) {
      scripts = input.filter((s) => s.enable && s.content.trim());
    } else {
      const s = String(input || "").trim();
      if (s) scripts.push({ id: "legacy", name: "Legacy Script", content: s, enable: true });
    }

    if (scripts.length === 0) return;

    // Track how many async module scripts are still loading.
    // Non-module scripts execute synchronously on append so they count as 0 async.
    let pendingModuleCount = 0;
    let nonModuleScriptAppended = false;

    const tryAdopt = () => {
      if (nonce !== currentNonce) return;
      const fallback = (w.FlatNasCustom as CustomHooks | undefined) || null;
      const next = (pendingRegister || fallback) as CustomHooks | null;
      pendingRegister = null;
      void adoptHooks(next);
    };

    const onModuleLoaded = () => {
      pendingModuleCount--;
      if (pendingModuleCount === 0) tryAdopt();
    };

    scripts.forEach((item) => {
      const src = item.content;
      const looksModule =
        /^\s*\/\/\s*@module\b/m.test(src) ||
        /(^|\n)\s*import\s.+from\s+["'][^"']+["']/m.test(src) ||
        /(^|\n)\s*export\s+/m.test(src);

      const script = document.createElement("script");
      script.className = scriptClass;

      // Suffix lets module scripts self-register via FlatNasCustomRegister(FlatNasCustom).
      const suffix = "\n;globalThis.FlatNasCustomRegister?.(globalThis.FlatNasCustom);";

      if (looksModule) {
        script.type = "module";
        script.textContent = `${src}${suffix}`;
        // For module scripts, the `load` event fires after top-level execution — reliable timing.
        pendingModuleCount++;
        script.addEventListener("load", onModuleLoaded);
        script.addEventListener("error", onModuleLoaded);
      } else {
        // Build a local `fetch` override if useProxy is enabled.
        let proxyCode = "";
        if (item.useProxy) {
          proxyCode = `
const originalFetch = window.fetch;
const fetch = async (input, init) => {
  try {
    if (typeof input === 'string' && input.startsWith('http')) {
      const url = new URL(input);
      if (url.hostname !== window.location.hostname) {
        return await originalFetch('/proxy?url=' + encodeURIComponent(input), init);
      }
    }
  } catch (e) {}
  return originalFetch(input, init);
};`;
        }
        const wrapped = `;(async () => {\n${proxyCode}\ntry {\n${src}\n} catch (e) {\nconsole.error('[FlatNas Custom JS: ${item.name}]', e);\n}\n})();`;
        script.textContent = `${wrapped}${suffix}`;
        nonModuleScriptAppended = true;
      }

      script.onerror = (e) => console.error(`[FlatNas Custom JS: ${item.name}] load error:`, e);
      document.body.appendChild(script);
    });

    if (pendingModuleCount === 0) {
      // No module scripts (or none at all) — non-module scripts ran synchronously.
      if (nonModuleScriptAppended || scripts.length === 0) {
        window.setTimeout(tryAdopt, 0);
      }
    }
    // If pendingModuleCount > 0, adoption is triggered by onModuleLoaded callbacks.
  };

  return { apply, destroy: doDestroy };
})();

watch(
  [
    () => store.appConfig.customJs,
    () => store.appConfig.customJsList,
    () => store.appConfig.customJsDisclaimerAgreed,
  ],
  ([newJs, newList, agreed]) => {
    if (newList && newList.length > 0) {
      void customJsRuntime.apply(newList, Boolean(agreed));
    } else {
      void customJsRuntime.apply(String(newJs || ""), Boolean(agreed));
    }
  },
  { immediate: true },
);

onMounted(() => {
  // Listen for marketplace install events from new windows/tabs (Component Store)
  window.addEventListener("message", async (event: MessageEvent) => {
    // Validate message structure
    const { type, payload } = event.data || {};
    if (type !== "INSTALL_COMPONENT" || !payload) return;

    // Optional: Validate origin if needed. For now we trust the user's browser context.
    // If strict security is needed, we should check against store.appConfig.marketplaceListUrl

    const item = payload as MarketplaceItem;
    
    // JS Disclaimer
    if (item.js && !store.appConfig.customJsDisclaimerAgreed) {
      const ok = confirm(
        `安全提示\n\n组件 "${item.name}" 包含自定义 JavaScript 脚本。\n自定义脚本具有较高权限，可能存在安全风险。\n\n请确认您信任该组件来源，是否继续安装？`
      );
      if (!ok) return;
      store.appConfig.customJsDisclaimerAgreed = true;
    }

    try {
      store.applyMarketplaceItem(item);
      
      // Notify source window
      if (event.source) {
        (event.source as Window).postMessage({ type: "INSTALL_SUCCESS", id: item.id }, event.origin);
      }
      
      // Notify user in main window
      alert(`组件 "${item.name}" 安装成功！`);
    } catch (e) {
      console.error(e);
      alert(`组件 "${item.name}" 安装失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  store.initGlobalDrag();
  const win = window as Window & { __flatnasSaveFetchWrapped?: boolean };
  if (!win.__flatnasSaveFetchWrapped) {
    const originalFetch = window.fetch.bind(window);
    win.__flatnasSaveFetchWrapped = true;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const resolveUrl = () => {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        return input.url;
      };
      const rawUrl = resolveUrl();
      let isSaveRequest = false;
      try {
        const url = rawUrl.startsWith("http")
          ? new URL(rawUrl)
          : new URL(rawUrl, window.location.origin);
        isSaveRequest = url.pathname === "/api/save";
      } catch {
        isSaveRequest = rawUrl.includes("/api/save");
      }
      try {
        const res = await originalFetch(input, init);
        if (isSaveRequest && !res.ok && res.status !== 401 && res.status !== 409) {
          if (res.status === 413) {
            pushSaveError("实时保存失败：请求体过大，当前修改未成功写入。");
          } else {
            pushSaveError(`实时保存失败：服务器返回 ${res.status}。`);
          }
        }
        return res;
      } catch (e) {
        if (isSaveRequest) {
          const msg = e instanceof Error ? e.message : String(e);
          pushSaveError(`实时保存失败：${msg || "网络异常"}`);
        }
        throw e;
      }
    };
  }
  const style = document.createElement("style");
  style.id = "devtools-hider";
  style.innerHTML = `
    #vue-devtools-anchor,
    .vue-devtools__anchor,
    .vue-devtools__trigger,
    [data-v-inspector-toggle] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  // Poll for updates every 18 hours
  setInterval(
    () => {
      store.fetchData();
    },
    18 * 60 * 60 * 1000,
  );
});

</script>

<template>
  <div class="flatnas-handshake-signal" style="display: none !important"></div>
  
  <GridPanel />

  <!-- 冲突提示：居中模态框 -->
  <Transition name="fade">
    <div
      v-if="store.conflictState.show"
      class="fixed inset-0 z-[130] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
    >
      <div
        class="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        @click.stop
      />
      <div
        class="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-800 shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
      >
        <div class="p-5 sm:p-6">
          <div class="flex items-start gap-3">
            <div class="p-2 rounded-full bg-red-100 dark:bg-red-900/40 shrink-0">
              <svg class="w-5 h-5 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <h2 id="conflict-title" class="font-bold text-base text-neutral-900 dark:text-white">
                版本冲突 (Version Conflict)
              </h2>
              <p class="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
                其他设备或标签页已更新配置，请选择解决方式。
              </p>
              <p class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span class="inline-flex items-center gap-1 rounded-md bg-neutral-100 dark:bg-neutral-700 px-2 py-1 font-mono text-neutral-700 dark:text-neutral-300">
                  服务端 V{{ store.conflictState.serverVersion }}
                </span>
                <span class="text-neutral-400 dark:text-neutral-500">/</span>
                <span class="inline-flex items-center gap-1 rounded-md bg-neutral-100 dark:bg-neutral-700 px-2 py-1 font-mono text-neutral-700 dark:text-neutral-300">
                  本地 V{{ store.conflictState.clientVersion }}
                </span>
              </p>
            </div>
          </div>
          <div class="mt-5 flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <button
              type="button"
              @click.stop.prevent="store.resolveConflict('remote')"
              class="min-h-[48px] px-5 rounded-xl text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors"
            >
              采用服务端 (放弃本地)
            </button>
            <button
              type="button"
              @click.stop.prevent="store.resolveConflict('local')"
              class="min-h-[48px] px-5 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors shadow-sm"
            >
              强制本端 (覆盖服务端)
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
  <!-- 心跳断过后再次激活且服务端版本不同时，确认是否同步 -->
  <Transition name="fade">
    <div
      v-if="store.syncConfirmModal.show"
      class="fixed inset-0 z-[130] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-confirm-title"
    >
      <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px]" @click.stop />
      <div
        class="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-800 shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
      >
        <div class="p-5 sm:p-6">
          <h2 id="sync-confirm-title" class="font-bold text-base text-neutral-900 dark:text-white">
            服务端配置已更新
          </h2>
          <p class="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
            检测到服务端配置版本 (V{{ store.syncConfirmModal.serverVersion }}) 与当前不同，是否同步为服务端配置？
          </p>
          <div class="mt-5 flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
            <button
              type="button"
              @click.stop.prevent="store.dismissSyncConfirm()"
              class="min-h-[48px] px-5 rounded-xl text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors"
            >
              保留本地
            </button>
            <button
              type="button"
              @click.stop.prevent="store.confirmSyncFromServer()"
              class="min-h-[48px] px-5 rounded-xl text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors shadow-sm"
            >
              同步
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
  <Transition name="slide-down">
    <div
      v-if="saveErrorMessage && !store.conflictState.show"
      class="fixed top-0 inset-x-0 z-[111] bg-amber-500/95 text-white shadow-xl backdrop-blur-md border-b border-amber-400/50 pt-[env(safe-area-inset-top)]"
    >
      <div class="max-w-7xl mx-auto px-4 py-2 text-sm font-medium">
        {{ saveErrorMessage }}
      </div>
    </div>
  </Transition>

  <div
    v-if="!store.isClientReady"
    class="fixed inset-0 z-[120] bg-black/30 backdrop-blur-[2px] flex items-center justify-center text-white"
  >
    <div class="flex flex-col items-center gap-3 px-6 py-4 bg-black/60 rounded-2xl border border-white/10">
      <div class="w-8 h-8 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
      <div class="text-sm font-medium">正在同步服务端数据，请稍后...</div>
    </div>
  </div>

  <Transition name="fade-up">
    <button
      v-if="showBackToTop"
      @click="scrollToTop"
      class="fixed bottom-6 right-6 z-[100] w-12 h-12 rounded-full bg-white/20 backdrop-blur-md border border-white/30 text-white shadow-lg flex items-center justify-center hover:bg-white/40 active:scale-95 transition-all cursor-pointer"
      title="返回首页"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-6 w-6 drop-shadow-md"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2.5"
          d="M5 10l7-7m0 0l7 7m-7-7v18"
        />
      </svg>
    </button>
  </Transition>

  <StatusMonitor v-if="statusMonitorWidget?.enable" :widget="statusMonitorWidget" />

  <!-- Global Audio Element for persistent playback across groups -->
  <audio id="flatnas-global-audio" style="display: none" crossorigin="anonymous"></audio>
</template>

<style>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-up-enter-active,
.fade-up-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>
