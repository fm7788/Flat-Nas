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

const isIpv4 = (host) => /^(\d{1,3}\.){3}\d{1,3}$/.test(host);

const isIpv4PrefixLike = (value) => /^\d{1,3}(\.\d{1,3}){0,3}\.?$/.test(String(value || "").trim());

const isPrivateIpv4 = (host) => {
  if (!isIpv4(host)) return false;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
};

const isOverlayIpv4 = (host) => {
  if (!isIpv4(host)) return false;
  // CGNAT range, often used by overlay networks (e.g. tailscale)
  return /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(host);
};

const normalizeRule = (line) => String(line || "").trim();

const parseNetworkRules = (rawRules) => {
  return String(rawRules || "")
    .split("\n")
    .map((line) => normalizeRule(line))
    .filter((line) => line && !line.startsWith("#"));
};

const normalizeRuleHostLike = (value) => {
  let v = String(value || "").trim().toLowerCase();
  if (!v) return "";

  v = v.replace(/^\*\./, "");

  const parsed = extractHost(v);
  if (parsed) {
    v = parsed.toLowerCase();
  }

  v = v.replace(/^\[|\]$/g, "").replace(/^\./, "").replace(/\/$/, "");
  return v;
};

const matchDomainSuffix = (host, suffix) => {
  const normalized = normalizeRuleHostLike(suffix);
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
};

const classifyByRules = (host, rules) => {
  for (const rule of rules) {
    const v = rule.toLowerCase();

    if (v.startsWith("domain_suffix:")) {
      const suffix = v.slice("domain_suffix:".length).trim();
      if (matchDomainSuffix(host, suffix)) {
        if (suffix.includes("ts.net") || suffix.includes("zerotier")) return "overlay";
        if (suffix.includes("trycloudflare.com") || suffix.includes("ngrok.io") || suffix.includes("ngrok-free.app"))
          return "wan";
        return "lan";
      }
      continue;
    }

    if (v.startsWith("host:")) {
      const target = normalizeRuleHostLike(v.slice("host:".length).trim());
      if (target && host === target) return "lan";
      continue;
    }

    if (v.startsWith("ip:")) {
      const rawTarget = v.slice("ip:".length).trim();
      const target = rawTarget.endsWith(".") && isIpv4(rawTarget.slice(0, -1)) ? rawTarget.slice(0, -1) : rawTarget;
      if (target && host === target) return "lan";
      if (target && isIpv4(host) && !isIpv4(target) && isIpv4PrefixLike(target)) {
        const prefix = target.endsWith(".") ? target : `${target}.`;
        if (host.startsWith(prefix)) return "lan";
      }
      continue;
    }

    // Backward compatibility:
    // - ipv4 host: plain rule means ip prefix match (e.g. 192.168.)
    // - domain host: plain rule means domain suffix match (e.g. iepose.cn / *.iepose.cn / http://iepose.cn/)
    if (isIpv4(host) && host.startsWith(v)) return "lan";
    if (matchDomainSuffix(host, v)) return "lan";
  }

  return "wan";
};

export const NETWORK_PRESET_RULES = {
  tailscale: ["domain_suffix:.ts.net", "ip:100.64."],
  zerotier: ["domain_suffix:.zerotier.net"],
  frp: ["# frp 常见为自定义域名，建议补充 host/domain_suffix 规则"],
  cloudflareTunnel: ["domain_suffix:.trycloudflare.com"],
  ngrok: ["domain_suffix:.ngrok.io", "domain_suffix:.ngrok-free.app"],
};

export const DEFAULT_NETWORK_RULES = [
  "# overlay networks",
  ...NETWORK_PRESET_RULES.tailscale,
  ...NETWORK_PRESET_RULES.zerotier,
  "# tunnels (kept as WAN by default)",
  ...NETWORK_PRESET_RULES.cloudflareTunnel,
  ...NETWORK_PRESET_RULES.ngrok,
].join("\n");

export const classifyNetworkTarget = (url, networkRules = "", internalDomains = "") => {
  const raw = typeof url === "string" ? url.trim() : String(url ?? "").trim();
  if (!raw) return "wan";

  const host = extractHost(raw).toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "wan";

  if (host === "::1" || host.includes("localhost") || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return "lan";
  }

  if (isPrivateIpv4(host) || host.endsWith(".local")) return "lan";
  if (isOverlayIpv4(host)) return "overlay";

  const rules = [...parseNetworkRules(networkRules), ...parseNetworkRules(internalDomains)];
  return classifyByRules(host, rules);
};

export const isInternalNetwork = (url, internalDomains = "", networkRules = "") => {
  const type = classifyNetworkTarget(url, networkRules, internalDomains);
  return type === "lan" || type === "overlay";
};

export const buildRulesFromPresets = (presets = {}) => {
  const enabled = Object.entries(presets || {}).filter(([, v]) => !!v);
  if (enabled.length === 0) return "";
  const lines = [];
  for (const [key] of enabled) {
    if (!NETWORK_PRESET_RULES[key]) continue;
    lines.push(...NETWORK_PRESET_RULES[key]);
  }
  return Array.from(new Set(lines)).join("\n");
};

export const getNetworkConfig = (appConfig = {}, localForceNetworkMode) => {
  const internalDomains = typeof appConfig.internalDomains === "string" ? appConfig.internalDomains : "";
  const userRules = typeof appConfig.networkRules === "string" ? appConfig.networkRules : "";
  const presetRules = buildRulesFromPresets(appConfig.networkPresets || {});
  const networkRules = [userRules, presetRules].filter(Boolean).join("\n");
  const mode = typeof localForceNetworkMode === "string" ? localForceNetworkMode : "";
  const forceNetworkMode = ["auto", "lan", "wan", "latency"].includes(mode) ? mode : "auto";
  const raw = appConfig.latencyThresholdMs;
  const base = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 200;
  const latencyThresholdMs = Math.min(30000, Math.max(20, base));
  return { internalDomains, networkRules, forceNetworkMode, latencyThresholdMs };
};
