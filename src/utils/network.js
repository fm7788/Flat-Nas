const extractHost = (input) => {
  const value = typeof input === "string" ? input.trim() : String(input ?? "").trim();
  if (!value) return "";
  if (value.startsWith("[") && value.includes("]")) {
    return value.slice(1, value.indexOf("]"));
  }
  try {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
      return new URL(value).hostname;
    }
    if (value.startsWith("//")) {
      return new URL(`http:${value}`).hostname;
    }
    if (value.includes("/") || value.includes("?") || value.includes("#")) {
      return new URL(`http://${value}`).hostname;
    }
  } catch {
    return value;
  }
  return value;
};

export const isInternalNetwork = (url, internalDomains = "") => {
  const raw = typeof url === "string" ? url.trim() : String(url ?? "").trim();
  if (!raw) return false;
  const host = extractHost(raw);
  const target = host ? host.toLowerCase() : raw.toLowerCase();
  const rawLower = raw.toLowerCase();
  const hostNoBracket = target.replace(/^\[|\]$/g, "");

  if (target.includes("localhost") || target.includes("127.0.0.1")) return true;
  if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[0-1]))\./.test(target)) return true;

  if (hostNoBracket === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(hostNoBracket)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(hostNoBracket)) return true;

  if (target.endsWith(".local")) return true;

  if (internalDomains) {
    const whitelist = String(internalDomains)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of whitelist) {
      const v = item.toLowerCase();
      if (target.includes(v) || rawLower.includes(v)) return true;
    }
  }

  return false;
};

export const getNetworkConfig = (appConfig = {}) => {
  const internalDomains =
    typeof appConfig.internalDomains === "string" ? appConfig.internalDomains : "";
  const forceNetworkMode = appConfig.forceNetworkMode || "auto";
  const raw = appConfig.latencyThresholdMs;
  const base =
    typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 200;
  const latencyThresholdMs = Math.min(30000, Math.max(20, base));
  return { internalDomains, forceNetworkMode, latencyThresholdMs };
};
