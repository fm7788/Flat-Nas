import "./assets/main.css";
import "./assets/grid-layout.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useMainStore } from "./stores/main";
import { attachErrorCapture, ensureOverlayHandled } from "./utils/overlay";

if (typeof document !== "undefined" && typeof navigator !== "undefined") {
  const ua = navigator.userAgent || "";
  const isHarmony = /(harmonyos|hongmeng|hm os)/i.test(ua);
  const isHuawei = /(huaweibrowser|huawei)/i.test(ua);
  const isAlook = /alook/i.test(ua);
  if (isHarmony || isHuawei) {
    document.documentElement.classList.add("harmony-os");
  }
  if (isAlook) {
    document.documentElement.classList.add("alook-browser");
  }
}

// #region agent log
const _debugIngest = (msg: string, data: Record<string, unknown>, hypothesisId: string) => {
  fetch("http://127.0.0.1:7872/ingest/26a085c1-eea6-41df-83f2-c178aa092a66", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "214d88" },
    body: JSON.stringify({
      sessionId: "214d88",
      location: "main.ts:init",
      message: msg,
      data: { ...data, origin: location?.origin, pathname: location?.pathname },
      timestamp: Date.now(),
      hypothesisId,
    }),
  }).catch(() => {});
};
if (typeof location !== "undefined") {
  _debugIngest("page_init", { href: location.href }, "H2");
  fetch(new URL("/ICON.PNG", location.origin).href, { method: "HEAD" })
    .then((r) => _debugIngest("icon_png_fetch", { status: r.status, ok: r.ok, url: new URL("/ICON.PNG", location.origin).href }, "H1"))
    .catch((e) => _debugIngest("icon_png_fetch_err", { err: String(e) }, "H1"));
}
// #endregion

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// Initialize store globally to ensure configuration is loaded
const store = useMainStore();
store.init();

app.mount("#app");

if (import.meta.env.DEV) {
  attachErrorCapture();
  ensureOverlayHandled();
}
