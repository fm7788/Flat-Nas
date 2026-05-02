import "./assets/main.css";
import "./assets/grid-layout.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useMainStore } from "./stores/main";
import { attachErrorCapture, ensureOverlayHandled } from "./utils/overlay";
import { installFetchUrlPatch } from "./utils/runtimeUrls";
import { installNetworkFetchPatch } from "./utils/networkFetch";

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

installFetchUrlPatch();
installNetworkFetchPatch();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount("#app");

const bootstrap = async () => {
  // Initialize store once after mount so the shell UI can render even if
  // the sync pipeline is slow or temporarily blocked.
  const store = useMainStore();
  try {
    await store.init();
  } catch (error) {
    console.error("Initial store init failed", error);
  }
};

if (import.meta.env.DEV) {
  attachErrorCapture();
  ensureOverlayHandled();
}

void bootstrap();
