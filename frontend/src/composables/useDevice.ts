import { computed, type Ref } from "vue";
import { useWindowSize } from "@vueuse/core";

export function useDevice(deviceMode?: Ref<"auto" | "desktop" | "tablet" | "mobile" | undefined>) {
  const { width, height } = useWindowSize();

  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const uaLower = ua.toLowerCase();
  const isHarmony = /(harmonyos|hongmeng|hm os)/i.test(ua);
  const isHuaweiBrowser = /(huaweibrowser|huawei)/i.test(ua);
  const isAndroid = uaLower.includes("android");
  const isiOS = /(iphone|ipad|ipod)/i.test(ua);
  const isAlook = /alook/i.test(ua);
  const isMobileUA = /(mobi|mobile|android|iphone|ipod|ipad)/i.test(ua);

  const autoKey = computed(() => {
    const w = width.value;
    const h = height.value;
    const mode = deviceMode?.value || "auto";
    if (mode !== "auto") return mode as "desktop" | "tablet" | "mobile";

    const treatAsHandheld =
      isHarmony || isHuaweiBrowser || isAndroid || isiOS || isMobileUA || isAlook;

    if (treatAsHandheld) {
      const minSide = Math.min(w, h);
      if (minSide < 768) return "mobile" as const;
      if (minSide < 1024) return "tablet" as const;
      return "desktop" as const;
    }

    if (w < 768) return "mobile" as const;
    if (w < 1024) return "tablet" as const;
    return "desktop" as const;
  });
  const deviceKey = computed(() => {
    const mode = deviceMode?.value || "auto";
    if (mode === "auto") return autoKey.value;
    if (mode === "desktop" || mode === "tablet" || mode === "mobile") return mode;
    return autoKey.value;
  });
  const isMobile = computed(() => deviceKey.value === "mobile");
  const isTablet = computed(() => deviceKey.value === "tablet");
  const isDesktop = computed(() => deviceKey.value === "desktop");

  // Browser Detection
  const isVia = ua.includes("Via");
  const isQuark = ua.includes("Quark");
  const isUC = ua.includes("UCBrowser") || ua.includes("UBrowser");
  const isSafari =
    ua.includes("Safari") &&
    !ua.includes("Chrome") &&
    !ua.includes("CriOS") &&
    !ua.includes("Android");

  return {
    deviceKey,
    isMobile,
    isTablet,
    isDesktop,
    isVia,
    isQuark,
    isUC,
    isAlook,
    isSafari,
    isHarmony,
    isHuaweiBrowser,
    isAndroid,
    isiOS,
  };
}
