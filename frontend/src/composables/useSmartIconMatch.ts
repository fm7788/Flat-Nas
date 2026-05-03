import { ref, shallowRef, type Ref } from "vue";
import type { AliIcon } from "@/types";
import Fuse from "fuse.js";

export interface SmartIconCandidate {
  url: string;
  source: "ali" | "favicon";
  label?: string;
}

interface RankedSmartIconCandidate extends SmartIconCandidate {
  score: number;
}

export interface SmartIconFormState {
  title?: string;
  url?: string;
  lanUrl?: string;
  icon?: string;
}

interface SmartIconMatchOptions {
  form: Ref<SmartIconFormState>;
  onSelect: (url: string) => void;
  notify?: (message: string) => void;
}

const ALI_ICON_BASE_URLS = [
  "https://nasicon.top",
  "https://2.nasicon.top",
  "https://4.nasicon.top",
  "https://icon-manager.1851365c.er.aliyun-esa.net",
  "https://icon-manager2.1851365c.er.aliyun-esa.net",
  "http://icon-manager3.1851365c.er.aliyun-esa.net",
] as const;

const COMMON_DOMAIN_SUFFIXES = [
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
] as const;

const SMART_MATCH_TIMEOUT_MS = 3000;
const ALI_ICON_LIMIT = 12;

let aliIconsData: AliIcon[] | null = null;
let aliIconsPromise: Promise<AliIcon[] | null> | null = null;

export const resetSmartIconMatchCacheForTests = (): void => {
  aliIconsData = null;
  aliIconsPromise = null;
};

const normalizeKeyword = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, "");

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
};

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

const resolveAliIconLabel = (icon: AliIcon): string => {
  return icon.cnName?.trim() || icon.name?.trim() || icon.domain?.trim() || icon.filename?.trim() || "AliYun";
};

const isPrivateIpv4Host = (host: string): boolean => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
};

const isLikelyLocalHost = (host: string): boolean => {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost.endsWith(".local") ||
    isPrivateIpv4Host(normalizedHost)
  );
};

export const normalizeUserUrl = (input: string): string => {
  const raw = input.trim();
  if (!raw) return "";
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(raw) || raw.startsWith("data:")) {
    return raw;
  }

  const host = raw.split("/")[0]?.trim() ?? "";
  const scheme = isLikelyLocalHost(host) ? "http://" : "https://";
  return `${scheme}${raw}`;
};

export const extractKeywordFromUrl = (input: string): string => {
  try {
    const normalized = normalizeUserUrl(input);
    if (!normalized) return "";

    const hostname = new URL(normalized).hostname.toLowerCase();
    let core = hostname.replace(/^www\./, "");

    for (const suffix of COMMON_DOMAIN_SUFFIXES) {
      if (core.endsWith(suffix)) {
        core = core.slice(0, -suffix.length);
        break;
      }
    }

    if (core.includes(".")) {
      const parts = core.split(".");
      return parts[parts.length - 1] || "";
    }

    return core;
  } catch {
    return "";
  }
};

const loadImageDimensions = (
  src: string,
): Promise<{ width: number; height: number; valid: boolean }> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => resolve({ width: 0, height: 0, valid: false }), SMART_MATCH_TIMEOUT_MS);

    img.onload = () => {
      window.clearTimeout(timer);
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      resolve({
        width,
        height,
        valid: width > 1 && height > 1,
      });
    };

    img.onerror = () => {
      window.clearTimeout(timer);
      resolve({ width: 0, height: 0, valid: false });
    };

    img.src = src;
  });
};

export const validateDataUriIcon = async (input: string): Promise<boolean> => {
  const raw = input.trim();
  if (!raw.startsWith("data:image/")) return false;
  const meta = raw.slice(5, raw.indexOf(",") > 0 ? raw.indexOf(",") : undefined).toLowerCase();
  if (!meta.includes(";base64")) return false;
  const result = await loadImageDimensions(raw);
  return result.valid;
};

export const validateRemoteIconUrl = async (input: string): Promise<boolean> => {
  const raw = input.trim();
  if (!raw) return false;
  const result = await loadImageDimensions(raw);
  return result.valid;
};

export const validateIconCandidate = async (input: string): Promise<boolean> => {
  const raw = input.trim();
  if (!raw) return false;
  if (raw.startsWith("data:")) return validateDataUriIcon(raw);
  return validateRemoteIconUrl(raw);
};

const fetchAliIconsData = async (signal?: AbortSignal): Promise<AliIcon[] | null> => {
  if (aliIconsData) return aliIconsData;
  if (aliIconsPromise) return aliIconsPromise;

  aliIconsPromise = (async () => {
    try {
      const res = await fetch("/api/ali-icons", { signal });
      if (res.ok) {
        const data = await res.json();
        aliIconsData = Array.isArray(data) ? data : null;
        return aliIconsData;
      }
      throw new Error("Proxy failed");
    } catch (e) {
      if (isAbortError(e)) {
        return null;
      }
      console.warn("Proxy fetch failed, trying direct fetch...", e);
      try {
        const results = await Promise.allSettled(
          ALI_ICON_BASE_URLS.map(async (baseUrl) => {
            const res = await fetch(`${baseUrl}/icons.json`, { signal });
            if (!res.ok) throw new Error(`Fetch failed: ${baseUrl}`);
            const data = await res.json();
            if (!Array.isArray(data)) throw new Error(`Invalid icons.json: ${baseUrl}`);
            return normalizeAliIcons(data as AliIcon[], baseUrl);
          }),
        );

        const merged: AliIcon[] = [];
        const seen = new Set<string>();

        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          for (const icon of result.value) {
            const key = icon.downloadUrl || `${icon.name}|${icon.url}|${icon.filename}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(icon);
          }
        }

        aliIconsData = merged.length > 0 ? merged : null;
        return aliIconsData;
      } catch (directErr) {
        if (isAbortError(directErr)) {
          return null;
        }
        console.error("Failed to fetch ali-icons data", directErr);
        aliIconsData = null;
        return null;
      }
    } finally {
      aliIconsPromise = null;
    }
  })();

  return aliIconsPromise;
};

export const pickAliIconsWithFuse = (
  icons: AliIcon[],
  searchTerm: string,
  limit = ALI_ICON_LIMIT,
): string[] => {
  if (!searchTerm.trim()) return [];

  const aliFuse = new Fuse(icons, {
    keys: ["name", "cnName", "domain"],
    threshold: 0.3,
    ignoreLocation: true,
  });

  return aliFuse
    .search(searchTerm)
    .slice(0, limit)
    .map((result) => resolveAliIconUrl(result.item))
    .filter((url): url is string => Boolean(url));
};

const scoreAliIconCandidate = (icon: AliIcon, searchTerm: string, fuseScore?: number): number => {
  const normalizedSearch = normalizeKeyword(searchTerm);
  const candidates = [icon.name, icon.cnName, icon.domain]
    .map((value) => normalizeKeyword(value || ""))
    .filter(Boolean);

  let score = 55;
  if (typeof fuseScore === "number") {
    score += Math.max(0, 30 - fuseScore * 50);
  }

  if (candidates.some((value) => value === normalizedSearch)) {
    score += 35;
  } else if (candidates.some((value) => value.includes(normalizedSearch))) {
    score += 18;
  }

  if (candidates.some((value) => normalizedSearch.includes(value) && value.length >= 3)) {
    score += 8;
  }

  return score;
};

const pickRankedAliIconMatches = (
  icons: AliIcon[],
  searchTerm: string,
  limit = ALI_ICON_LIMIT,
): RankedSmartIconCandidate[] => {
  if (!searchTerm.trim()) return [];

  const aliFuse = new Fuse(icons, {
    keys: ["name", "cnName", "domain"],
    threshold: 0.3,
    ignoreLocation: true,
    includeScore: true,
  });

  return aliFuse
    .search(searchTerm)
    .map((result) => {
      const url = resolveAliIconUrl(result.item);
      return {
        url,
        source: "ali" as const,
        label: resolveAliIconLabel(result.item),
        score: scoreAliIconCandidate(result.item, searchTerm, result.score),
      };
    })
    .filter((candidate) => Boolean(candidate.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

const buildFaviconSourceList = (targetUrl: string): string[] => {
  const normalizedTargetUrl = normalizeUserUrl(targetUrl);
  if (!normalizedTargetUrl) return [];

  const urlObj = new URL(normalizedTargetUrl);
  return [
    `https://www.favicon.vip/get.php?url=${encodeURIComponent(normalizedTargetUrl)}`,
    `https://icon.bqb.cool?url=${encodeURIComponent(normalizedTargetUrl)}`,
    `https://api.afmax.cn/so/ico/index.php?r=${encodeURIComponent(normalizedTargetUrl)}`,
    `https://api.quickso.cn/api/favicon/index.php?url=${encodeURIComponent(normalizedTargetUrl)}`,
    `${urlObj.origin}/favicon.ico`,
  ];
};

const scoreFaviconCandidate = (candidateUrl: string, targetUrl: string): number => {
  const normalizedTargetUrl = normalizeUserUrl(targetUrl);
  if (!normalizedTargetUrl) return 90;

  try {
    const target = new URL(normalizedTargetUrl);
    const candidate = new URL(candidateUrl, target.origin);

    if (candidate.origin === target.origin && candidate.pathname === "/favicon.ico") {
      return 140;
    }
    if (candidate.origin === target.origin) {
      return 130;
    }

    if (candidate.hostname.includes("favicon.vip")) return 115;
    if (candidate.hostname.includes("afmax.cn")) return 110;
    if (candidate.hostname.includes("quickso.cn")) return 108;
    if (candidate.hostname.includes("bqb.cool")) return 105;
  } catch {
    if (candidateUrl.startsWith("data:image/")) return 120;
  }

  return candidateUrl.startsWith("data:image/") ? 118 : 100;
};

const fetchBase64Icon = async (url: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const res = await fetch(`/api/get-icon-base64?url=${encodeURIComponent(url)}`, { signal });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.success || typeof data.icon !== "string" || !data.icon.trim()) {
      return null;
    }

    const icon = data.icon.trim();
    if (!(await validateDataUriIcon(icon))) {
      return null;
    }
    return icon;
  } catch (e) {
    if (isAbortError(e)) {
      return null;
    }
    console.warn("Failed to fetch base64 icon", e);
    return null;
  }
};

const hydrateAliCandidate = async (
  candidate: RankedSmartIconCandidate,
  signal?: AbortSignal,
): Promise<RankedSmartIconCandidate> => {
  if (candidate.source !== "ali") return candidate;
  if (candidate.url.startsWith("data:")) return candidate;

  const proxied = await fetchBase64Icon(candidate.url, signal);
  if (!proxied) return candidate;
  return {
    ...candidate,
    url: proxied,
  };
};

const resolveSearchTerms = (form: SmartIconFormState): string[] => {
  const terms: string[] = [];
  const pushTerm = (value?: string) => {
    const term = value?.trim();
    if (!term || terms.includes(term)) return;
    terms.push(term);
  };

  pushTerm(form.title);

  const targetUrl = form.url?.trim() || form.lanUrl?.trim() || "";
  pushTerm(extractKeywordFromUrl(targetUrl));

  const iconInput = form.icon?.trim() || "";
  if (
    iconInput &&
    !iconInput.startsWith("http") &&
    !iconInput.startsWith("/") &&
    !iconInput.startsWith("data:")
  ) {
    pushTerm(iconInput);
  }

  return terms;
};

export const useSmartIconMatch = ({ form, onSelect, notify }: SmartIconMatchOptions) => {
  const smartMatchCandidates = shallowRef<SmartIconCandidate[]>([]);
  const showSmartMatchModal = ref(false);
  const isSmartMatching = ref(false);
  const activeRunId = ref(0);
  const activeAbortController = shallowRef<AbortController | null>(null);

  const announce = notify ?? ((message: string) => window.alert(message));

  const cancelActiveRun = () => {
    activeRunId.value += 1;
    isSmartMatching.value = false;
    activeAbortController.value?.abort();
    activeAbortController.value = null;
  };

  const closeSmartMatchModal = () => {
    cancelActiveRun();
    showSmartMatchModal.value = false;
  };

  const selectSmartMatchCandidate = (candidate: SmartIconCandidate) => {
    cancelActiveRun();
    onSelect(candidate.url);
    showSmartMatchModal.value = false;
  };

  const smartMatchIcons = async () => {
    if (!form.value.title && !form.value.url && !form.value.lanUrl) {
      announce("请先填写标题或链接！");
      return;
    }

    cancelActiveRun();
    const runId = activeRunId.value;
    const abortController = new AbortController();
    activeAbortController.value = abortController;
    isSmartMatching.value = true;
    smartMatchCandidates.value = [];
    showSmartMatchModal.value = true;

    const allCandidates: RankedSmartIconCandidate[] = [];
    const seen = new Set<string>();

    const publishCandidates = () => {
      smartMatchCandidates.value = allCandidates.map(({ url, source, label }) => ({ url, source, label }));
    };

    const addCandidate = async (candidate: RankedSmartIconCandidate): Promise<boolean> => {
      const hydratedCandidate = await hydrateAliCandidate(candidate, abortController.signal);
      const normalizedUrl = hydratedCandidate.url.trim();
      const normalizedCandidate = { ...hydratedCandidate, url: normalizedUrl };
      if (!normalizedUrl || activeRunId.value !== runId || seen.has(normalizedUrl)) {
        return false;
      }

      if (activeRunId.value !== runId) return false;

      // Skip strict validation for ali sources (already from trusted icon library)
      // Only validate favicon and manually entered icons
      if (candidate.source !== "ali" && normalizedUrl.startsWith("http")) {
        if (!(await validateIconCandidate(normalizedUrl))) {
          return false;
        }
      }

      seen.add(normalizedUrl);
      allCandidates.push(normalizedCandidate);
      publishCandidates();
      return true;
    };

    const searchAliTask = async () => {
      try {
        const searchTerms = resolveSearchTerms(form.value);
        if (searchTerms.length === 0) return;

        const icons = await fetchAliIconsData(abortController.signal);
        if (!icons || activeRunId.value !== runId) return;

        const mergedMatches = new Map<string, RankedSmartIconCandidate>();
        const sourceOrderBonus = [18, 10, 4];

        for (const [index, searchTerm] of searchTerms.entries()) {
          const aliMatches = pickRankedAliIconMatches(icons, searchTerm);
          for (const candidate of aliMatches) {
            const boostedCandidate = {
              ...candidate,
              score: candidate.score + (sourceOrderBonus[index] ?? 0),
            };

            const existing = mergedMatches.get(boostedCandidate.url);
            if (!existing || boostedCandidate.score > existing.score) {
              mergedMatches.set(boostedCandidate.url, boostedCandidate);
            }
          }
        }

        const aliMatches = [...mergedMatches.values()].sort((a, b) => b.score - a.score);
        for (const candidate of aliMatches) {
          if (activeRunId.value !== runId) break;
          await addCandidate(candidate);
        }
      } catch (e) {
        if (isAbortError(e)) return;
        console.warn("AliYun search failed", e);
      }
    };

    const fetchFaviconTask = async () => {
      try {
        const targetUrl = form.value.url?.trim() || form.value.lanUrl?.trim() || "";
        const faviconSources = buildFaviconSourceList(targetUrl);
        for (const src of faviconSources) {
          if (activeRunId.value !== runId) break;

          const base64 = await fetchBase64Icon(src, abortController.signal);
          if (
            base64 &&
            (await addCandidate({
              url: base64,
              source: "favicon",
              score: scoreFaviconCandidate(src, targetUrl),
            }))
          ) {
            break;
          }

          if (
            await addCandidate({
              url: src,
              source: "favicon",
              score: scoreFaviconCandidate(src, targetUrl),
            })
          ) {
            break;
          }
        }
      } catch (e) {
        if (isAbortError(e)) return;
        console.warn("Favicon fetch failed", e);
      }
    };

    await Promise.allSettled([searchAliTask(), fetchFaviconTask()]);

    if (activeRunId.value !== runId) return;

    activeAbortController.value = null;
    isSmartMatching.value = false;
    if (allCandidates.length === 0) {
      announce("未找到匹配的图标，请手动上传或输入图标URL");
      showSmartMatchModal.value = false;
    }
  };

  return {
    smartMatchCandidates,
    showSmartMatchModal,
    isSmartMatching,
    smartMatchIcons,
    selectSmartMatchCandidate,
    closeSmartMatchModal,
  };
};
