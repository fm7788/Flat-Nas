<script setup lang="ts">
import { ref, watch, computed, shallowRef, onMounted, onUnmounted } from "vue";
import type { NavItem, SimpleIcon, AliIcon } from "@/types";
import { useMainStore } from "../stores/main";
import IconUploader from "./IconUploader.vue";
import IconSelectionModal from "./IconSelectionModal.vue";
import GroupSelector from "./GroupSelector.vue";
import Fuse from "fuse.js";

// 接收父组件传来的数据
const props = defineProps<{
  show: boolean;
  data?: NavItem | null;
  // ✨✨✨ 新增关键参数：当前分组ID (必须有这个才能支持分组添加)
  groupId?: string;
  onSave?: (payload: { item: NavItem; groupId?: string }) => Promise<void>;
}>();

const emit = defineEmits(["update:show", "save"]);

const store = useMainStore();

const currentHour = ref(new Date().getHours());
let daylightTimer: number | null = null;
const updateHour = () => {
  currentHour.value = new Date().getHours();
};
const isNightTime = computed(() => currentHour.value >= 18 || currentHour.value < 6);
const isNightDaylightMode = computed(
  () => store.appConfig.daylightModeEnabled && isNightTime.value,
);

onMounted(() => {
  daylightTimer = window.setInterval(updateHour, 60000);
});
onUnmounted(() => {
  if (daylightTimer) clearInterval(daylightTimer);
});

const isVertical = computed(() => {
  const layout = props.groupId
    ? store.groups.find((g) => g.id === props.groupId)?.cardLayout
    : undefined;
  return (layout || store.appConfig.cardLayout) === "vertical";
});

// 合并描述字段的计算属性
const mergedDescription = computed({
  get: () => {
    const d1 = form.value.description1 || "";
    const d2 = form.value.description2 || "";
    const d3 = form.value.description3 || "";
    // 如果有后面行的内容，则保留前面的换行符
    if (d3) return `${d1}\n${d2}\n${d3}`;
    if (d2) return `${d1}\n${d2}`;
    return d1;
  },
  set: (val: string) => {
    const lines = val.split("\n");
    form.value.description1 = lines[0] || "";
    form.value.description2 = lines[1] || "";
    form.value.description3 = lines[2] || "";
  },
});

// 自动调整高度
const autoResize = (event: Event) => {
  const el = event.target as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
};

// 图标模式：emoji 或 图片
const iconType = ref<"emoji" | "image">("image");
const isFetching = ref(false);

// 搜索相关状态
const showIconSelection = ref(false);
const iconCandidates = shallowRef<string[]>([]);
const searchSource = ref<"local" | "api">("local");
const localIcons = shallowRef<string[]>([]);
const simpleIconsData = shallowRef<SimpleIcon[] | null>(null);
const aliIconsData = shallowRef<AliIcon[] | null>(null);

const localGroupId = ref("");

// 表单数据 (合并管理，比以前分散的 ref 更整洁)
interface EditForm extends Omit<NavItem, "id" | "backupUrls" | "backupLanUrls"> {
  backupUrls: { name: string; url: string }[];
  backupLanUrls: { name: string; url: string }[];
}

const form = ref<EditForm>({
  title: "",
  url: "",
  lanUrl: "",
  backupUrls: [],
  backupLanUrls: [],
  icon: "",
  description1: "",
  description2: "",
  description3: "",
  color: "bg-gray-100 text-gray-700",
  titleColor: "",
  isPublic: false,
  backgroundImage: "",
  backgroundBlur: 6,
  backgroundMask: 0.3,
  iconSize: 100,
});

// 预设一些常用的 Emoji
const commonEmojis = [
  "🏠",
  "🔍",
  "💻",
  "📱",
  "📸",
  "🎵",
  "🎬",
  "📚",
  "🛠️",
  "☁️",
  "⚡",
  "🔥",
  "🌟",
  "❤️",
  "🚀",
  "🌍",
  "🎨",
  "📂",
  "📅",
  "🛒",
  "🎁",
  "🐱",
  "🐶",
  "🍀",
  "⚽",
];

// 随机选择 Emoji
const randomEmoji = () => {
  const randomIndex = Math.floor(Math.random() * commonEmojis.length);
  form.value.icon = commonEmojis[randomIndex] || "";
};

// 检测图片是否有效
const checkImageExists = (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 3000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.width > 1);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = url;
  });
};

// 获取本地图标列表
const fetchLocalIcons = async () => {
  if (localIcons.value.length > 0) return;
  try {
    const res = await fetch("/api/icons");
    if (res.ok) {
      const list = await res.json();
      // 加上目录前缀
      localIcons.value = list.map((f: string) => `icons/${f}`);
    }
  } catch (e) {
    console.error("Failed to fetch local icons", e);
  }
};

// 获取 Simple Icons 数据
const fetchSimpleIconsData = async () => {
  if (simpleIconsData.value) return;
  try {
    // 使用 Iconify API 替代 GitHub Raw，解决国内/Docker环境无法连接的问题
    // Iconify 返回 { prefix: "simple-icons", total: N, uncategorized: ["slug1", "slug2", ...] }
    const res = await fetch("https://api.iconify.design/collection?prefix=simple-icons");
    if (res.ok) {
      const data = await res.json();
      // 将 uncategorized (slug 数组) 转换为 Fuse 可用的对象格式
      if (data.uncategorized && Array.isArray(data.uncategorized)) {
        simpleIconsData.value = data.uncategorized.map((slug: string) => ({
          title: slug, // Iconify API 只提供 slug，暂用 slug 作为 title
          slug: slug,
        }));
      }
    }
  } catch (e) {
    console.error("Failed to fetch simple-icons data", e);
  }
};

const ALI_ICON_BASE_URLS = [
  "https://icon-manager.1851365c.er.aliyun-esa.net",
  "https://icon-manager2.1851365c.er.aliyun-esa.net",
  "http://icon-manager3.1851365c.er.aliyun-esa.net",
] as const;

const normalizeAliIcons = (icons: AliIcon[], baseUrl: string): AliIcon[] => {
  return icons.map((icon) => {
    const url = typeof icon.url === "string" ? icon.url.trim() : "";
    const downloadUrl = typeof icon.downloadUrl === "string" ? icon.downloadUrl.trim() : "";

    if (downloadUrl) {
      if (
        /^https?:\/\//i.test(downloadUrl) ||
        downloadUrl.startsWith("//") ||
        downloadUrl.startsWith("data:")
      ) {
        return { ...icon, downloadUrl };
      }
      try {
        return { ...icon, downloadUrl: new URL(downloadUrl, baseUrl).href };
      } catch {
        return { ...icon, downloadUrl: "" };
      }
    }

    if (/^https?:\/\//i.test(url) || url.startsWith("//") || url.startsWith("data:")) {
      return { ...icon, downloadUrl: url };
    }

    try {
      return { ...icon, downloadUrl: new URL(url || "", baseUrl).href };
    } catch {
      return { ...icon, downloadUrl: "" };
    }
  });
};

const resolveAliIconUrl = (icon: AliIcon): string => {
  const downloadUrl = typeof icon.downloadUrl === "string" ? icon.downloadUrl.trim() : "";
  if (downloadUrl) {
    if (
      /^https?:\/\//i.test(downloadUrl) ||
      downloadUrl.startsWith("//") ||
      downloadUrl.startsWith("data:")
    ) {
      return downloadUrl;
    }
    try {
      return new URL(downloadUrl, ALI_ICON_BASE_URLS[0]).href;
    } catch {
      return "";
    }
  }

  const url = typeof icon.url === "string" ? icon.url.trim() : "";
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("//") || url.startsWith("data:")) return url;

  try {
    return new URL(url, ALI_ICON_BASE_URLS[0]).href;
  } catch {
    return "";
  }
};

// 获取 Ali Icons 数据
const fetchAliIconsData = async () => {
  if (aliIconsData.value) return;
  try {
    // 优先尝试使用本地代理，解决 CORS 问题
    const res = await fetch("/api/ali-icons");
    if (res.ok) {
      const data = await res.json();
      aliIconsData.value = Array.isArray(data) ? data : null;
    } else {
      throw new Error("Proxy failed");
    }
  } catch (e) {
    console.warn("Proxy fetch failed, trying direct fetch...", e);
    // 降级尝试直接请求 (如果后端挂了但前端能通外网)
    try {
      const results = await Promise.allSettled(
        ALI_ICON_BASE_URLS.map(async (baseUrl) => {
          const res = await fetch(`${baseUrl}/icons.json`);
          if (!res.ok) throw new Error(`Fetch failed: ${baseUrl}`);
          const data = await res.json();
          if (!Array.isArray(data)) throw new Error(`Invalid icons.json: ${baseUrl}`);
          return normalizeAliIcons(data as AliIcon[], baseUrl);
        }),
      );

      const merged: AliIcon[] = [];
      const seen = new Set<string>();

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const icon of r.value) {
          const key = icon.downloadUrl || `${icon.name}|${icon.url}|${icon.filename}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(icon);
        }
      }

      aliIconsData.value = merged.length > 0 ? merged : null;
    } catch (directErr) {
      console.error("Failed to fetch ali-icons data", directErr);
    }
  }
};

// 提取主域名关键词
const extractKeywordFromUrl = (url: string): string => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // 1. 移除 www.
    let core = hostname.replace(/^www\./, "");

    // 2. 移除常见的顶级域名后缀 (TLD) 和二级后缀 (SLD)
    // 这是一个简化的列表，覆盖常见情况
    const suffixes = [
      ".com.cn",
      ".net.cn",
      ".org.cn",
      ".gov.cn",
      ".edu.cn",
      ".co.uk",
      ".co.jp",
      ".co.kr",
      ".com",
      ".cn",
      ".net",
      ".org",
      ".io",
      ".me",
      ".cc",
      ".info",
      ".biz",
      ".tv",
      ".top",
      ".xyz",
      ".edu",
      ".gov",
      ".mil",
      ".int",
    ];

    for (const suffix of suffixes) {
      if (core.endsWith(suffix)) {
        core = core.slice(0, -suffix.length);
        break; // 只移除最长匹配的后缀一次
      }
    }

    // 3. 如果还包含点号（例如 news.163），取最后一部分
    if (core.includes(".")) {
      const parts = core.split(".");
      return parts[parts.length - 1] || "";
    }

    return core;
  } catch {
    return "";
  }
};

// 自动适配图标 (两阶段搜索：本地 -> API)
const autoAdaptIcon = async () => {
  // 优先尝试从 URL 提取关键词，如果没有则使用标题
  let searchTerm = "";

  const targetUrl = form.value.url || form.value.lanUrl;
  if (targetUrl) {
    searchTerm = extractKeywordFromUrl(targetUrl);
  }

  if (!searchTerm) {
    searchTerm = form.value.title.trim();
  }

  if (!searchTerm) return alert("请先填写链接或标题作为搜索关键词！");

  isFetching.value = true;
  iconType.value = "image";

  try {
    // Phase 1: 本地搜索
    console.log(`[Search] Starting Phase 1 (Local) for: "${searchTerm}"`);
    await fetchLocalIcons();
    // 使用 Fuse.js 进行本地搜索
    const localIconList = localIcons.value.map((path) => {
      const parts = path.split("/");
      const filename = parts[parts.length - 1];
      const name = filename ? filename.split(".")[0] : "";
      return { path, name };
    });

    const localFuse = new Fuse(localIconList, {
      keys: ["name"],
      threshold: 0.3,
      ignoreLocation: true,
    });

    const localResults = localFuse.search(searchTerm);
    const localMatches = localResults.map((result) => result.item.path);

    console.log(`[Search] Phase 1 found ${localMatches.length} matches`);

    if (localMatches.length > 0) {
      if (localMatches.length === 1) {
        console.log(`[Search] Auto-selecting single local match: ${localMatches[0]}`);
        form.value.icon = localMatches[0] || "";
      } else {
        console.log(`[Search] Showing selection modal for ${localMatches.length} local matches`);
        iconCandidates.value = localMatches;
        searchSource.value = "local";
        showIconSelection.value = true;
      }
      return;
    }

    // Phase 2: API Fallback (Simple Icons)
    console.log(`[Search] Phase 1 failed. Starting Phase 2 (API) for: "${searchTerm}"`);
    await fetchSimpleIconsData();
    if (simpleIconsData.value) {
      const apiFuse = new Fuse(simpleIconsData.value, {
        keys: ["title", "slug"],
        threshold: 0.3,
        ignoreLocation: true,
      });

      const apiResults = apiFuse.search(searchTerm);
      const apiMatches = apiResults.map(
        (result) => `https://cdn.simpleicons.org/${result.item.slug}`,
      );

      console.log(`[Search] Phase 2 found ${apiMatches.length} matches`);

      if (apiMatches.length > 0) {
        if (apiMatches.length === 1) {
          console.log(`[Search] Auto-selecting single API match: ${apiMatches[0]}`);
          form.value.icon = apiMatches[0] || "";
        } else {
          console.log(`[Search] Showing selection modal for ${apiMatches.length} API matches`);
          iconCandidates.value = apiMatches;
          searchSource.value = "api";
          showIconSelection.value = true;
        }
        return;
      }
    }

    // Phase 3: AliYun Icon Manager
    console.log(`[Search] Phase 2 failed. Starting Phase 3 (AliYun) for: "${searchTerm}"`);
    await fetchAliIconsData();
    if (aliIconsData.value) {
      const aliFuse = new Fuse(aliIconsData.value, {
        keys: ["name", "cnName", "domain"],
        threshold: 0.3,
        ignoreLocation: true,
      });

      const aliResults = aliFuse.search(searchTerm);
      const aliMatches = aliResults.map((result) => resolveAliIconUrl(result.item)).filter(Boolean);

      console.log(`[Search] Phase 3 found ${aliMatches.length} matches`);

      if (aliMatches.length > 0) {
        if (aliMatches.length === 1) {
          console.log(`[Search] Auto-selecting single Ali match: ${aliMatches[0]}`);
          form.value.icon = aliMatches[0] || "";
        } else {
          console.log(`[Search] Showing selection modal for ${aliMatches.length} Ali matches`);
          iconCandidates.value = aliMatches;
          searchSource.value = "api";
          showIconSelection.value = true;
        }
        return;
      }
    }

    // 原始逻辑兜底：尝试根据域名匹配
    const targetUrl = form.value.url || form.value.lanUrl;
    if (targetUrl) {
      const urlObj = new URL(targetUrl);
      const domain = (urlObj.hostname.replace(/^www\./, "").split(".")[0] || "").toLowerCase();
      if (domain) {
        const fallbackIcon = `https://cdn.simpleicons.org/${domain}`;
        if (await checkImageExists(fallbackIcon)) {
          form.value.icon = fallbackIcon;
          return;
        }
      }
    }

    alert("未找到适配的图标，尝试使用自动抓取功能？");
  } catch (e) {
    console.error(e);
    alert("搜索失败，请检查网络");
  } finally {
    isFetching.value = false;
  }
};

// 网络匹配（直接搜索 AliYun 图标库）
const networkMatch = async () => {
  // 1. 确定搜索关键词
  // 优先使用标题 (根据用户要求)
  let searchTerm = form.value.title.trim();

  // 如果标题为空，尝试从 URL 提取
  if (!searchTerm) {
    const targetUrl = form.value.url || form.value.lanUrl;
    if (targetUrl) {
      searchTerm = extractKeywordFromUrl(targetUrl);
    }
  }

  // 如果还是为空，且图标输入框里有非 URL 内容，尝试使用它
  if (!searchTerm) {
    const iconInput = form.value.icon ? form.value.icon.trim() : "";
    if (
      iconInput &&
      !iconInput.startsWith("http") &&
      !iconInput.startsWith("/") &&
      !iconInput.startsWith("data:")
    ) {
      searchTerm = iconInput;
    }
  }

  if (!searchTerm) return alert("请输入标题或链接后重试！");

  await searchAliIcons(searchTerm);
};

// 核心搜索函数
const searchAliIcons = async (searchTerm: string) => {
  isFetching.value = true;
  iconType.value = "image";

  try {
    console.log(`[Search] Searching AliYun for: "${searchTerm}"`);
    await fetchAliIconsData();

    if (aliIconsData.value) {
      const aliFuse = new Fuse(aliIconsData.value, {
        keys: ["name", "cnName", "domain"],
        threshold: 0.3,
        ignoreLocation: true,
      });

      const aliResults = aliFuse.search(searchTerm);
      const aliMatches = aliResults.map((result) => resolveAliIconUrl(result.item)).filter(Boolean);

      console.log(`[Search] Found ${aliMatches.length} matches`);

      if (aliMatches.length > 0) {
        if (aliMatches.length === 1) {
          form.value.icon = aliMatches[0] || "";
        } else {
          iconCandidates.value = aliMatches;
          searchSource.value = "api";
          showIconSelection.value = true;
        }
      } else {
        alert("未找到匹配的网络图标");
      }
    } else {
      alert("获取图标库失败，请检查网络");
    }
  } catch (e) {
    console.error(e);
    alert("搜索失败");
  } finally {
    isFetching.value = false;
  }
};

// 二级域名匹配
const domainMatch = () => {
  const targetUrl = form.value.url || form.value.lanUrl;
  if (!targetUrl) return alert("请先填写链接！");
  const keyword = extractKeywordFromUrl(targetUrl);
  if (!keyword) return alert("无法从链接提取有效关键词");
  searchAliIcons(keyword);
};

// 选中图标
const onIconSelect = (icon: string) => {
  form.value.icon = icon;
};

// Helper: 尝试从服务器获取 Base64 图标
const fetchBase64Icon = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(`/api/get-icon-base64?url=${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.icon) {
        return data.icon;
      }
    }
  } catch (e) {
    console.warn("Failed to fetch base64 icon", e);
  }
  return null;
};

// 自动抓取网站图标
const autoFetchIcon = async () => {
  const targetUrl = form.value.url || form.value.lanUrl;
  if (!targetUrl) return alert("请先填写链接！");

  isFetching.value = true;
  iconType.value = "image"; // 自动切换到图片模式

  try {
    const urlObj = new URL(targetUrl);
    // 尝试多种来源抓取图标
    // 调整顺序：优先使用可靠的 API，最后尝试直接访问 favicon.ico
    const candidates = [
      `https://www.favicon.vip/get.php?url=${encodeURIComponent(targetUrl)}`,
      `https://icon.bqb.cool?url=${encodeURIComponent(targetUrl)}`,
      `https://api.afmax.cn/so/ico/index.php?r=${encodeURIComponent(targetUrl)}`,
      `https://api.quickso.cn/api/favicon/index.php?url=${encodeURIComponent(targetUrl)}`,
      `${urlObj.origin}/favicon.ico`,
    ];

    let found = false;
    for (const src of candidates) {
      // 1. 优先尝试让服务器转换成 Base64 (解决内网/外网访问问题)
      const base64 = await fetchBase64Icon(src);
      if (base64) {
        form.value.icon = base64;
        found = true;
        break;
      }

      // 2. 降级：如果服务器不行（比如跨域或其他原因），尝试前端直接加载
      if (await checkImageExists(src)) {
        form.value.icon = src;
        found = true;
        break;
      }
    }

    if (!found) {
      // 没抓到就用随机 Emoji 兜底
      randomEmoji();
      iconType.value = "emoji";
    }
  } catch {
    alert("链接格式错误，无法抓取");
    isFetching.value = false;
  } finally {
    isFetching.value = false;
  }
};

// 监听弹窗打开，初始化表单
watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      localGroupId.value = props.groupId || "";
      if (props.data) {
        // 编辑模式：回填数据
        form.value = {
          ...props.data,
          backupUrls: props.data.backupUrls
            ? props.data.backupUrls.map((u) =>
                typeof u === "string" ? { name: "", url: u } : { ...u },
              )
            : [],
          backupLanUrls: props.data.backupLanUrls
            ? props.data.backupLanUrls.map((u) =>
                typeof u === "string" ? { name: "", url: u } : { ...u },
              )
            : [],
          description1: props.data.description1 || "",
          description2: props.data.description2 || "",
          description3: props.data.description3 || "",
          titleColor: props.data.titleColor || "",
          backgroundImage: props.data.backgroundImage || "",
          backgroundBlur: props.data.backgroundBlur ?? 6,
          backgroundMask: props.data.backgroundMask ?? 0.3,
          iconSize: props.data.iconSize ?? 100,
        };

        // 判断当前图标是图片还是 Emoji
        // 逻辑：只要 icon 有值，且看起来不像是一个单字符或双字符的 Emoji，就默认是图片模式
        // 这样可以避免把本地路径 (icons/xxx) 或 URL 误判为 Emoji
        const iconVal = form.value.icon || "";
        // Emoji 一般长度很短（1-2个字符，虽然有些组合 Emoji 会长一点，但路径通常更长）
        // 只要包含 '/' (路径) 或 '.' (文件名后缀) 或 ':' (协议)，肯定是图片
        const isLikelyImage =
          iconVal.length > 0 &&
          (iconVal.length > 4 ||
            iconVal.includes("/") ||
            iconVal.includes(".") ||
            iconVal.includes(":") ||
            iconVal.startsWith("data:"));

        iconType.value = isLikelyImage ? "image" : "emoji";

        // 如果是空的，默认也给图片模式（配合之前修改的默认行为）
        if (!iconVal) {
          iconType.value = "image";
        }
      } else {
        // 新增模式：重置表单
        form.value = {
          title: "",
          url: "",
          lanUrl: "",
          backupUrls: [],
          backupLanUrls: [],
          icon: "",
          color: "bg-gray-100 text-gray-700",
          titleColor: "",
          isPublic: false,
          backgroundImage: "",
          backgroundBlur: 6,
          backgroundMask: 0.3,
          iconSize: 100,
        };
        iconType.value = "image";
      }
    }
  },
  { immediate: true },
);

const addBackupUrl = () => {
  if (!form.value.backupUrls) form.value.backupUrls = [];
  form.value.backupUrls.push({ name: "", url: "" });
};

const removeBackupUrl = (index: number) => {
  if (form.value.backupUrls) {
    form.value.backupUrls.splice(index, 1);
  }
};

const addBackupLanUrl = () => {
  if (!form.value.backupLanUrls) form.value.backupLanUrls = [];
  form.value.backupLanUrls.push({ name: "", url: "" });
};

const removeBackupLanUrl = (index: number) => {
  if (form.value.backupLanUrls) {
    form.value.backupLanUrls.splice(index, 1);
  }
};

const isValidUrl = (url: string) => {
  if (!url) return true; // allow empty for now? No, required if item exists?
  // User said: Address field RFC 3986 validation.
  // Simple regex
  return /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(url);
};

const focusNextInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const parent = target.parentElement?.parentElement;
  if (parent) {
    const inputs = parent.querySelectorAll("input");
    if (inputs.length > 1 && inputs[0] === target && inputs[1]) {
      (inputs[1] as HTMLElement).focus();
      event.preventDefault();
    }
  }
};

const close = () => emit("update:show", false);

// 处理图标加载错误
const iconInputFocused = ref(false);
const isImgError = ref(false);

const processIconError = () => {
  const val = form.value.icon;
  if (
    val &&
    val.startsWith("http") &&
    !val.includes("favicon.ico") &&
    !val.includes("api.uomg.com") &&
    !val.includes("simpleicons.org") &&
    !val.includes("api.afmax.cn") &&
    !val.includes("api.quickso.cn") &&
    !val.includes("favicon.vip") &&
    !val.includes("icon.bqb.cool")
  ) {
    console.log("Icon load failed, trying to fallback to reliable API:", val);
    try {
      const urlObj = new URL(val);
      // 尝试使用 Afmax API，它比直接访问 favicon.ico 更可靠且不会产生 404 错误日志
      form.value.icon = `https://api.afmax.cn/so/ico/index.php?r=https://${urlObj.hostname}`;
      return;
    } catch {
      // ignore
    }
  }
  // 否则直接清空
  form.value.icon = "";
};

const handleIconError = () => {
  isImgError.value = true;
  // 如果正在输入，不要打断用户
  if (iconInputFocused.value) return;
  processIconError();
};

const onIconInputBlur = () => {
  iconInputFocused.value = false;
  // 失去焦点时，如果有错误，尝试修正
  if (isImgError.value) {
    processIconError();
  }
};

const onImgLoad = () => {
  isImgError.value = false;
};

const saveIconToLocal = ref(true);
const isSaving = ref(false);

const extractIconCacheError = (data: any): string => {
  if (!data) return "图标缓存失败，请稍后重试";
  if (typeof data.error === "string") return data.error;
  if (data.error && typeof data.error.message === "string") {
    const code = typeof data.error.code === "string" ? data.error.code : "";
    const tips: Record<string, string> = {
      invalid_url: "请使用有效的 http/https 图标地址",
      blocked_host: "该地址属于受限内网地址，建议先上传图标再保存",
      icon_too_large: "图标超过 5MB，建议压缩后重试",
      unsupported_icon_type: "仅支持 png/jpg/webp/gif/svg/ico",
      unsafe_svg: "SVG 含高风险脚本内容，请换一个安全图标",
      fetch_failed: "远程图标拉取失败，请检查网络后重试",
    };
    const tip = code && tips[code] ? `（${tips[code]}）` : "";
    return `${data.error.message}${tip}`;
  }
  return "图标缓存失败，请稍后重试";
};

const cacheIconToLocal = async (icon: string): Promise<{ path: string | null; error: string | null }> => {
  const trimmed = icon.trim();
  if (!trimmed) return { path: null, error: null };
  if (trimmed.startsWith("/icon-cache/")) return { path: trimmed, error: null };

  const iconUrlToDataUrl = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  // Support relative local icon paths (e.g. "icons/foo.png" from local matching).
  const normalizeIconUrl = (value: string) => {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/icons/")) return `${window.location.origin}${value}`;
    if (value.startsWith("icons/")) return `${window.location.origin}/${value}`;
    return "";
  };

  let payload: { dataUrl?: string; url?: string } | null = null;
  if (trimmed.startsWith("data:")) {
    payload = { dataUrl: trimmed };
  } else {
    const normalized = normalizeIconUrl(trimmed);
    if (normalized) {
      if (trimmed.startsWith("icons/") || trimmed.startsWith("/icons/")) {
        // Convert local static icons to dataUrl to avoid backend private-host blocking.
        const dataUrl = await iconUrlToDataUrl(normalized);
        payload = dataUrl ? { dataUrl } : null;
      } else {
        payload = { url: normalized };
      }
    }
  }

  if (!payload) return { path: null, error: "图标地址格式不支持本地缓存，请改为上传图片或使用 http/https 链接" };

  try {
    const res = await fetch("/api/icon-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { path: null, error: extractIconCacheError(data) };
    if (data && data.success && typeof data.path === "string" && data.path) {
      return { path: data.path, error: null };
    }
    return { path: null, error: extractIconCacheError(data) };
  } catch (e: any) {
    return { path: null, error: e?.message || "图标缓存请求失败，请稍后重试" };
  }
};

// 提交保存
const submit = async () => {
  if (!form.value.title && !form.value.url) return alert("标题和链接总得写一个吧！");

  isSaving.value = true;
  try {
    if (iconType.value === "image" && saveIconToLocal.value) {
      const icon = (form.value.icon || "").trim();
      if (icon && !icon.startsWith("/icon-cache/")) {
        const cached = await cacheIconToLocal(icon);
        if (cached.path) {
          form.value.icon = cached.path;
        } else if (cached.error) {
          alert(`图标本地缓存失败：${cached.error}\n将保留当前图标继续保存。`);
        }
      }
    }

    const payload = {
      item: { ...form.value, id: props.data?.id },
      groupId: localGroupId.value || props.groupId,
    };

    if (props.onSave) {
      await props.onSave(payload);
    } else {
      emit("save", payload);
    }

    close();
  } catch (e: any) {
    alert(e.message || "保存失败，请重试");
  } finally {
    isSaving.value = false;
  }
};

</script>

<template>
  <div
    v-if="show"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm"
    @click.self="close"
  >
    <div
      class="rounded-2xl shadow-2xl w-full max-w-md overflow-hidden transition-all duration-300"
      :class="isNightDaylightMode ? 'night-settings bg-slate-900/60 backdrop-blur-xl border border-white/10' : 'bg-white'"
    >
      <div
        class="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-white select-none"
      >
        <h3 class="text-lg font-bold text-gray-800">{{ data ? "修改项目" : "添加新项目" }}</h3>

        <div class="flex items-center gap-2 ml-auto mr-4">
          <GroupSelector v-model="localGroupId" />
          <div class="w-px h-4 bg-gray-200 mx-1"></div>
          <span class="text-xs font-bold text-gray-500">公开</span>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="form.isPublic" class="sr-only peer" />
            <div
              class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-gray-900"
            ></div>
          </label>
        </div>

        <button @click="close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">
          &times;
        </button>
      </div>

      <div class="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-sm font-medium text-gray-600 mb-1"
              >标题 <span class="text-red-500">*</span></label
            >
            <div class="relative">
              <input
                v-model="form.title"
                type="text"
                class="w-full px-4 py-2 rounded-lg border border-gray-200 focus:border-gray-900 outline-none transition-colors pr-24"
                placeholder="例如：我的博客"
              />
              <button
                @click="networkMatch"
                class="absolute right-1 top-1 bottom-1 px-3 bg-gray-50 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-100 flex items-center gap-1 transition-colors"
                title="根据标题搜索网络图标库"
              >
                匹配图标
              </button>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-600 mb-1">标题颜色</label>
            <div class="flex items-center h-[42px] px-2 border border-gray-200 rounded-lg bg-white">
              <input
                v-model="form.titleColor"
                type="color"
                class="w-8 h-8 rounded cursor-pointer border-none p-0 bg-transparent"
                title="选择标题颜色"
              />
              <button
                v-if="form.titleColor"
                @click="form.titleColor = ''"
                class="ml-2 text-xs text-gray-400 hover:text-red-500"
                title="清除颜色"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        <div v-if="!isVertical">
          <label class="block text-xs font-medium text-gray-500 mb-1"
            >描述 (水平模式显示，每行对应一行文字)</label
          >
          <textarea
            v-model="mergedDescription"
            @input="autoResize"
            class="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-gray-900 outline-none transition-colors text-sm resize-none overflow-hidden"
            placeholder="第一行 (上)
第二行 (中)
第三行 (下)"
            rows="3"
          ></textarea>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1"
            >外网链接 <span class="text-red-500">*</span>
            <button
              @click="addBackupUrl"
              class="ml-2 text-xs text-gray-500 hover:text-gray-900 hover:underline"
              title="添加备用外网地址"
            >
              + 备用地址
            </button>
          </label>
          <div class="relative">
            <input
              v-model="form.url"
              type="text"
              class="w-full px-4 py-2 rounded-lg border border-gray-200 focus:border-gray-900 outline-none transition-colors pr-24"
              placeholder="https://example.com"
            />
            <button
              @click="domainMatch"
              class="absolute right-1 top-1 bottom-1 px-3 bg-gray-50 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-100 flex items-center gap-1 transition-colors"
              title="根据链接二级域名匹配图标"
            >
              匹配图标
            </button>
          </div>
          <!-- Backup URLs -->
          <div v-if="form.backupUrls && form.backupUrls.length > 0" class="space-y-2 mt-2">
            <div
              v-for="(item, index) in form.backupUrls"
              :key="'backup-wan-' + index"
              class="flex flex-col sm:flex-row gap-2 items-start sm:items-center p-2 bg-gray-50 rounded-lg border border-gray-100"
            >
              <!-- Name Field -->
              <div class="relative flex-1 w-full sm:w-auto">
                <input
                  v-model="item.name"
                  type="text"
                  maxlength="50"
                  class="w-full px-3 py-2 rounded-lg border focus:border-gray-900 outline-none transition-colors text-sm pr-8"
                  :class="[
                    form.backupUrls.filter(
                      (i, idx) => i.name && i.name === item.name && idx !== index,
                    ).length > 0
                      ? 'border-red-300'
                      : 'border-gray-200',
                  ]"
                  placeholder="名称"
                  @keydown.enter.prevent
                  @keydown.tab="focusNextInput($event)"
                />
                <button
                  v-if="item.name"
                  @click="item.name = ''"
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 rounded-full p-0.5"
                  title="清除"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    class="w-3 h-3"
                  >
                    <path
                      d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                    />
                  </svg>
                </button>
              </div>

              <!-- URL Field -->
              <div class="relative flex-[2] w-full sm:w-auto">
                <input
                  v-model="item.url"
                  type="text"
                  maxlength="500"
                  class="w-full px-3 py-2 rounded-lg border focus:border-gray-900 outline-none transition-colors text-sm pr-8"
                  :class="isValidUrl(item.url) ? 'border-gray-200' : 'border-red-300 bg-red-50'"
                  placeholder="请输入完整URL地址"
                  @keydown.enter.prevent
                />
                <button
                  v-if="item.url"
                  @click="item.url = ''"
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 rounded-full p-0.5"
                  title="清除"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    class="w-3 h-3"
                  >
                    <path
                      d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                    />
                  </svg>
                </button>
              </div>

              <button
                @click="removeBackupUrl(index)"
                class="text-gray-400 hover:text-red-500 p-2 sm:p-1 self-end sm:self-center"
                title="删除"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1"
            >内网链接 <span class="text-gray-400 text-xs">(选填，内网访问时优先跳转)</span>
            <button
              @click="addBackupLanUrl"
              class="ml-2 text-xs text-gray-500 hover:text-gray-900 hover:underline"
              title="添加备用内网地址"
            >
              + 备用地址
            </button>
          </label>
          <input
            v-model="form.lanUrl"
            type="text"
            placeholder="http://192.168.1.x:8080"
            class="w-full px-4 py-2 rounded-lg border border-gray-200 focus:border-gray-900 outline-none transition-colors"
          />
          <!-- Backup LAN URLs -->
          <div v-if="form.backupLanUrls && form.backupLanUrls.length > 0" class="space-y-2 mt-2">
            <div
              v-for="(item, index) in form.backupLanUrls"
              :key="'backup-lan-' + index"
              class="flex flex-col sm:flex-row gap-2 items-start sm:items-center p-2 bg-gray-50 rounded-lg border border-gray-100"
            >
              <!-- Name Field -->
              <div class="relative flex-1 w-full sm:w-auto">
                <input
                  v-model="item.name"
                  type="text"
                  maxlength="50"
                  class="w-full px-3 py-2 rounded-lg border focus:border-gray-900 outline-none transition-colors text-sm pr-8"
                  :class="[
                    form.backupLanUrls.filter(
                      (i, idx) => i.name && i.name === item.name && idx !== index,
                    ).length > 0
                      ? 'border-red-300'
                      : 'border-gray-200',
                  ]"
                  placeholder="名称"
                  @keydown.enter.prevent
                  @keydown.tab="focusNextInput($event)"
                />
                <button
                  v-if="item.name"
                  @click="item.name = ''"
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 rounded-full p-0.5"
                  title="清除"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    class="w-3 h-3"
                  >
                    <path
                      d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                    />
                  </svg>
                </button>
              </div>

              <!-- URL Field -->
              <div class="relative flex-[2] w-full sm:w-auto">
                <input
                  v-model="item.url"
                  type="text"
                  maxlength="500"
                  class="w-full px-3 py-2 rounded-lg border focus:border-gray-900 outline-none transition-colors text-sm pr-8"
                  :class="isValidUrl(item.url) ? 'border-gray-200' : 'border-red-300 bg-red-50'"
                  placeholder="请输入完整URL地址"
                  @keydown.enter.prevent
                />
                <button
                  v-if="item.url"
                  @click="item.url = ''"
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 rounded-full p-0.5"
                  title="清除"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    class="w-3 h-3"
                  >
                    <path
                      d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                    />
                  </svg>
                </button>
              </div>

              <button
                @click="removeBackupLanUrl(index)"
                class="text-gray-400 hover:text-red-500 p-2 sm:p-1 self-end sm:self-center"
                title="删除"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        <div>
          <div class="flex items-start justify-between gap-4 mb-3">
            <div class="flex-1">
              <div class="flex items-center gap-4 mb-2">
                <label class="text-sm font-medium text-gray-600">图标样式</label>
                <div class="flex bg-gray-100 p-0.5 rounded-lg text-xs">
                  <button
                    @click="iconType = 'image'"
                    class="px-3 py-1 rounded-md transition-all"
                    :class="
                      iconType === 'image'
                        ? 'bg-white text-gray-800 shadow-sm font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    "
                  >
                    图片
                  </button>
                  <button
                    @click="iconType = 'emoji'"
                    class="px-3 py-1 rounded-md transition-all"
                    :class="
                      iconType === 'emoji'
                        ? 'bg-white text-gray-800 shadow-sm font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    "
                  >
                    Emoji
                  </button>
                </div>
              </div>

              <label
                v-if="iconType === 'image'"
                class="flex items-center gap-2 text-xs text-gray-600 mb-2 select-none"
              >
                <input
                  v-model="saveIconToLocal"
                  type="checkbox"
                  class="w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-gray-500"
                />
                <span>保存到本地缓存（推荐，配置更小）</span>
              </label>

              <div class="flex justify-start items-center gap-2">
                <button
                  @click="autoAdaptIcon"
                  :disabled="isFetching"
                  class="text-xs flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all"
                  :class="
                    isFetching
                      ? 'bg-gray-100 text-gray-400'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  "
                >
                  <span
                    v-if="isFetching"
                    class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                  ></span>
                  {{ isFetching ? "适配中..." : "本地匹配" }}
                </button>

                <button
                  @click="autoFetchIcon"
                  :disabled="isFetching"
                  class="text-xs flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all"
                  :class="
                    isFetching
                      ? 'bg-gray-100 text-gray-400'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  "
                >
                  <span
                    v-if="isFetching"
                    class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                  ></span>
                  {{ isFetching ? "正在获取..." : "自动抓取" }}
                </button>
              </div>
            </div>

            <!-- 图标预览区域 -->
            <div
              class="shrink-0 w-16 h-16 rounded-xl border bg-gray-50 flex items-center justify-center overflow-hidden shadow-sm"
            >
              <template v-if="iconType === 'image'">
                <img
                  v-if="form.icon"
                  :src="store.getAssetUrl(form.icon)"
                  class="w-full h-full object-cover transition-transform duration-200"
                  :style="{ transform: `scale(${(form.iconSize ?? 100) / 100})` }"
                  @error="handleIconError"
                  @load="onImgLoad"
                />
                <span v-else class="text-gray-300 text-xs">预览</span>
              </template>
              <template v-else>
                <span
                  v-if="form.icon"
                  class="text-3xl transition-transform duration-200"
                  :style="{ transform: `scale(${(form.iconSize ?? 100) / 100})` }"
                >{{ form.icon }}</span>
                <span v-else class="text-gray-300 text-xs">Emoji</span>
              </template>
            </div>
          </div>

          <div v-if="iconType === 'emoji'" class="relative animate-fade-in">
            <input
              v-model="form.icon"
              type="text"
              class="w-full px-4 py-2 rounded-lg border border-gray-200 focus:border-gray-900 outline-none pr-20 text-xl"
              placeholder="输入 Emoji"
            />
            <button
              @click="randomEmoji"
              class="absolute right-1 top-1 bottom-1 px-3 bg-gray-50 text-gray-600 text-xs font-medium rounded-md hover:bg-gray-100 flex items-center gap-1 transition-colors"
            >
              随机
            </button>
          </div>

          <div v-else class="space-y-3 animate-fade-in">
            <div class="relative">
              <input
                v-model="form.icon"
                type="text"
                placeholder="图片 URL 地址..."
                class="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none"
                @focus="iconInputFocused = true"
                @blur="onIconInputBlur"
              />
            </div>

            <div
              class="text-xs text-gray-400 text-center flex items-center gap-2 before:h-px before:bg-gray-200 before:flex-1 after:h-px after:bg-gray-200 after:flex-1"
            >
              或
            </div>

            <IconUploader v-model="form.icon" />
          </div>

          <!-- Icon Size Slider (Shared) -->
          <div
            class="flex items-center gap-2 bg-gray-50 px-2 py-1.5 rounded-lg border border-gray-100 mt-3"
          >
            <span class="text-xs text-gray-400 whitespace-nowrap">缩放</span>
            <input
              type="range"
              v-model.number="form.iconSize"
              min="20"
              max="200"
              step="5"
              class="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
            />
            <span class="text-xs text-gray-500 w-8 text-right">{{ form.iconSize }}%</span>
          </div>
        </div>

        <div class="pt-4 border-t border-gray-100">
          <label class="block text-sm font-medium text-gray-600 mb-2"
            >卡片背景
            <span class="text-xs text-gray-400 font-normal">(可选，支持模糊和遮罩效果)</span></label
          >
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <input
                v-model="form.backgroundImage"
                type="text"
                placeholder="背景图 URL..."
                class="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none"
              />
              <button
                v-if="form.backgroundImage"
                @click="form.backgroundImage = ''"
                class="text-gray-400 hover:text-red-500 px-2"
                title="清除背景"
              >
                ✕
              </button>
            </div>
            <IconUploader
              v-model="form.backgroundImage"
              :crop="false"
              :uploadOnly="true"
              :previewStyle="{
                filter: `blur(${form.backgroundBlur ?? 6}px)`,
                transform: 'scale(1.1)',
              }"
              :overlayStyle="{
                backgroundColor: `rgba(0,0,0,${form.backgroundMask ?? 0.3})`,
              }"
            />

            <div
              v-if="form.backgroundImage"
              class="grid grid-cols-2 gap-4 mt-2 p-3 bg-gray-50 rounded-lg"
            >
              <div>
                <label class="block text-xs text-gray-500 mb-1 flex justify-between">
                  <span>模糊半径</span>
                  <span>{{ form.backgroundBlur }}px</span>
                </label>
                <input
                  type="range"
                  v-model.number="form.backgroundBlur"
                  min="0"
                  max="20"
                  step="1"
                  class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                />
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-1 flex justify-between">
                  <span>遮罩浓度</span>
                  <span>{{ Math.round((form.backgroundMask || 0) * 100) }}%</span>
                </label>
                <input
                  type="range"
                  v-model.number="form.backgroundMask"
                  min="0"
                  max="1"
                  step="0.1"
                  class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-400"
                />
              </div>
              <div class="col-span-2 text-right">
                <button
                  @click="
                    form.backgroundImage = '';
                    form.backgroundBlur = 6;
                    form.backgroundMask = 0.3;
                  "
                  class="text-xs text-red-500 hover:text-red-700 underline"
                >
                  移除背景
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="px-6 py-4 bg-white flex justify-end gap-3 border-t border-gray-100">
        <button
          @click="close"
          class="px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors text-sm font-medium"
        >
          取消
        </button>
        <button
          @click="submit"
          :disabled="isSaving"
          class="px-6 py-2 rounded-lg bg-gray-900 text-white hover:bg-black transition-all active:scale-95 text-sm font-medium"
        >
          {{ isSaving ? "保存中..." : data ? "保存修改" : "确认添加" }}
        </button>
      </div>
    </div>

    <IconSelectionModal
      v-model:show="showIconSelection"
      :candidates="iconCandidates"
      :title="form.title"
      :source="searchSource"
      @select="onIconSelect"
      @cancel-link="showIconSelection = false"
    />
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.night-settings {
  color: #f8fafc;
}
.night-settings :deep(.bg-white\/90),
.night-settings :deep(.bg-white\/80),
.night-settings :deep(.bg-white\/70),
.night-settings :deep(.bg-white\/60),
.night-settings :deep(.bg-white),
.night-settings :deep(.bg-gray-50),
.night-settings :deep(.bg-gray-100),
.night-settings :deep(.bg-white\/90):hover,
.night-settings :deep(.bg-white\/80):hover,
.night-settings :deep(.bg-white\/70):hover,
.night-settings :deep(.bg-white\/60):hover,
.night-settings :deep(.bg-white):hover,
.night-settings :deep(.bg-gray-50):hover,
.night-settings :deep(.bg-gray-100):hover {
  background-color: rgba(15, 23, 42, 0.55) !important;
  backdrop-filter: blur(12px);
}
/* 夜间模式：侧栏等使用 hover:bg-gray-50 的按钮悬停时用深色背景，避免与浅色文字同色 */
.night-settings :deep(.hover\:bg-gray-50):hover,
.night-settings :deep(.hover\:bg-gray-100):hover {
  background-color: rgba(15, 23, 42, 0.55) !important;
  backdrop-filter: blur(8px);
}
.night-settings :deep(.text-gray-900),
.night-settings :deep(.text-gray-800),
.night-settings :deep(.text-gray-700),
.night-settings :deep(.text-gray-600),
.night-settings :deep(.text-gray-500),
.night-settings :deep(.text-gray-400) {
  color: #f8fafc !important;
  text-shadow: 0 0 2px rgba(255, 255, 255, 0.6);
}
.night-settings :deep(.border-gray-100),
.night-settings :deep(.border-gray-200),
.night-settings :deep(.border-gray-300),
.night-settings :deep(.border-gray-400) {
  border-color: rgba(255, 255, 255, 0.12) !important;
}
.night-settings :deep(input::placeholder),
.night-settings :deep(textarea::placeholder) {
  color: rgba(248, 250, 252, 0.6);
}
</style>
