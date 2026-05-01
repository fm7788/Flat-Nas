type RuntimeConfig = {
  basePath?: string;
  backendBaseUrl?: string;
  apiBaseUrl?: string;
  wsBaseUrl?: string;
};

declare global {
  interface Window {
    __FLATNAS_RUNTIME_CONFIG__?: RuntimeConfig;
  }

  interface ImportMetaEnv {
    readonly VITE_APP_BASE_PATH?: string;
    readonly VITE_BACKEND_BASE_URL?: string;
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_WS_BASE_URL?: string;
  }
}

const APP_LOCAL_PREFIXES = ["/assets", "/icons", "/favicon.ico", "/default-wallpaper.svg", "/rain-texture.png"];
const BACKEND_PREFIXES = ["/api", "/backgrounds", "/mobile_backgrounds", "/icon-cache", "/music", "/public", "/proxy", "/socket.io"];

const isBlank = (value: unknown) => String(value ?? "").trim() === "";

const firstNonBlank = (...values: Array<unknown>) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
};

const hasScheme = (value: string) => /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);

const isAbsoluteLike = (value: string) => hasScheme(value) || value.startsWith("//");

const isSpecialUrl = (value: string) =>
  value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("mailto:") || value.startsWith("tel:");

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const trimLeadingSlash = (value: string) => value.replace(/^\/+/, "");

const matchesPrefix = (value: string, prefix: string) => value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`);

const normalizeBasePath = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw || raw === "/" || raw === "./") return "";
  if (isAbsoluteLike(raw)) {
    try {
      const url = new URL(raw, "http://localhost");
      return normalizeBasePath(url.pathname);
    } catch {
      return "";
    }
  }
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return trimTrailingSlash(withLeadingSlash);
};

const normalizeBaseUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!isAbsoluteLike(raw)) {
    return trimTrailingSlash(raw.startsWith("/") ? raw : `/${raw}`);
  }
  return trimTrailingSlash(raw);
};

const splitPathQueryHash = (value: string) => {
  const match = String(value || "").match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] || "",
    search: match?.[2] || "",
    hash: match?.[3] || "",
  };
};

const joinBaseAndPath = (base: string, pathWithQueryHash: string) => {
  if (!base) return pathWithQueryHash || "/";
  if (!pathWithQueryHash || pathWithQueryHash === "/") return base;
  const { pathname, search, hash } = splitPathQueryHash(pathWithQueryHash);
  if (!pathname || pathname === "/") return `${base}${search}${hash}`;
  return `${trimTrailingSlash(base)}${pathname.startsWith("/") ? pathname : `/${pathname}`}${search}${hash}`;
};

const stripApiSuffix = (value: string) => {
  const raw = normalizeBaseUrl(value);
  if (!raw) return "";
  if (isAbsoluteLike(raw)) {
    try {
      const url = new URL(raw);
      url.pathname = url.pathname.replace(/\/api(?:\/v\d+)?\/?$/i, "") || "/";
      const text = trimTrailingSlash(url.toString());
      return text.endsWith("/") ? text.slice(0, -1) : text;
    } catch {
      return raw.replace(/\/api(?:\/v\d+)?\/?$/i, "");
    }
  }
  return raw.replace(/\/api(?:\/v\d+)?\/?$/i, "");
};

const getRuntimeConfig = (): RuntimeConfig => {
  if (typeof window === "undefined") return {};
  return window.__FLATNAS_RUNTIME_CONFIG__ || {};
};

const detectBasePathFromLocation = () => {
  if (typeof window === "undefined") return "";
  let pathname = window.location.pathname || "/";
  if (pathname === "/" || pathname === "/index.html") return "";
  if (pathname.endsWith("/index.html")) pathname = pathname.slice(0, -"/index.html".length) || "/";
  return normalizeBasePath(pathname);
};

export const getAppBasePath = () => {
  const runtime = getRuntimeConfig();
  const builtBase = typeof import.meta.env.BASE_URL === "string" ? import.meta.env.BASE_URL : "/";
  return normalizeBasePath(
    firstNonBlank(runtime.basePath, import.meta.env.VITE_APP_BASE_PATH, builtBase !== "./" ? builtBase : "", detectBasePathFromLocation()),
  );
};

export const getAppOrigin = () => {
  if (typeof window === "undefined") return "";
  return window.location.origin;
};

export const getBackendBaseUrl = () => {
  const runtime = getRuntimeConfig();
  const explicitBackend = normalizeBaseUrl(firstNonBlank(runtime.backendBaseUrl, import.meta.env.VITE_BACKEND_BASE_URL));
  if (explicitBackend) return explicitBackend;
  const explicitApi = normalizeBaseUrl(firstNonBlank(runtime.apiBaseUrl, import.meta.env.VITE_API_BASE_URL));
  if (explicitApi) return stripApiSuffix(explicitApi);
  return getAppBasePath();
};

export const getApiBaseUrl = () => {
  const runtime = getRuntimeConfig();
  const explicitApi = normalizeBaseUrl(firstNonBlank(runtime.apiBaseUrl, import.meta.env.VITE_API_BASE_URL));
  if (explicitApi) return explicitApi;
  return joinBaseAndPath(getBackendBaseUrl(), "/api");
};

const deriveWsBase = () => {
  const runtime = getRuntimeConfig();
  const explicitWs = normalizeBaseUrl(firstNonBlank(runtime.wsBaseUrl, import.meta.env.VITE_WS_BASE_URL));
  if (explicitWs) return explicitWs;

  const explicitApi = normalizeBaseUrl(firstNonBlank(runtime.apiBaseUrl, import.meta.env.VITE_API_BASE_URL));
  if (explicitApi) {
    const derived = joinBaseAndPath(stripApiSuffix(explicitApi), "/ws");
    return derived.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  }

  const backendBase = getBackendBaseUrl();
  if (backendBase && isAbsoluteLike(backendBase)) {
    return joinBaseAndPath(
      backendBase.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:"),
      "/ws",
    );
  }

  if (typeof window === "undefined") return "";
  const wsOrigin = window.location.origin.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return joinBaseAndPath(wsOrigin, joinBaseAndPath(backendBase, "/ws"));
};

export const toAppUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw || isSpecialUrl(raw) || isAbsoluteLike(raw) || !raw.startsWith("/")) return raw;
  return joinBaseAndPath(getAppBasePath(), raw);
};

export const toBackendUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw || isSpecialUrl(raw) || isAbsoluteLike(raw) || !raw.startsWith("/")) return raw;
  return joinBaseAndPath(getBackendBaseUrl(), raw);
};

export const toApiUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw || isSpecialUrl(raw) || isAbsoluteLike(raw) || !raw.startsWith("/")) return raw;
  if (!matchesPrefix(raw, "/api")) return raw;
  const apiBase = getApiBaseUrl();
  const suffix = raw.slice("/api".length);
  return suffix ? joinBaseAndPath(apiBase, suffix) : apiBase;
};

export const toWsUrl = (value = "/ws") => {
  const raw = String(value || "").trim();
  if (!raw || isSpecialUrl(raw) || isAbsoluteLike(raw)) return raw;
  const wsBase = deriveWsBase();
  if (!matchesPrefix(raw, "/ws")) {
    return raw.startsWith("/") ? joinBaseAndPath(wsBase, raw) : raw;
  }
  const suffix = raw.slice("/ws".length);
  return suffix ? joinBaseAndPath(wsBase, suffix) : wsBase;
};

export const resolveManagedUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw || isSpecialUrl(raw)) return raw;
  if (isAbsoluteLike(raw)) {
    if (typeof window === "undefined") return raw;
    try {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return raw;
      return resolveManagedUrl(`${url.pathname}${url.search}${url.hash}`);
    } catch {
      return raw;
    }
  }
  if (!raw.startsWith("/")) return raw;
  if (matchesPrefix(raw, "/ws")) return toWsUrl(raw);
  if (matchesPrefix(raw, "/api")) return toApiUrl(raw);
  if (BACKEND_PREFIXES.some((prefix) => matchesPrefix(raw, prefix))) return toBackendUrl(raw);
  if (APP_LOCAL_PREFIXES.some((prefix) => matchesPrefix(raw, prefix))) return toAppUrl(raw);
  return toAppUrl(raw);
};

export const installFetchUrlPatch = () => {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const patchedFlag = "__flatnasFetchPatched__";
  if ((window.fetch as typeof window.fetch & { [patchedFlag]?: boolean })[patchedFlag]) return;

  const nativeFetch = window.fetch.bind(window);
  const patchedFetch: typeof window.fetch & { [patchedFlag]?: boolean } = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof Request !== "undefined" && input instanceof Request) {
      const rewritten = resolveManagedUrl(input.url);
      if (rewritten !== input.url) {
        return nativeFetch(new Request(rewritten, input), init);
      }
      return nativeFetch(input, init);
    }
    if (input instanceof URL) {
      const rewritten = resolveManagedUrl(input.toString());
      return nativeFetch(rewritten, init);
    }
    if (typeof input === "string") {
      return nativeFetch(resolveManagedUrl(input), init);
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch & { [patchedFlag]?: boolean };

  patchedFetch[patchedFlag] = true;
  window.fetch = patchedFetch;
};

export const hasExplicitRuntimeNetworkBase = () => {
  const runtime = getRuntimeConfig();
  return !isBlank(runtime.backendBaseUrl) || !isBlank(runtime.apiBaseUrl) || !isBlank(runtime.wsBaseUrl) ||
    !isBlank(import.meta.env.VITE_BACKEND_BASE_URL) || !isBlank(import.meta.env.VITE_API_BASE_URL) || !isBlank(import.meta.env.VITE_WS_BASE_URL);
};
