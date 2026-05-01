export const INVALID_CITIES = ["中国", "China", "本地", "auto", "定位中...", "未知位置", "Unknown"];

export const DEFAULT_CITY = "Shanghai";

export interface IpResponse {
  success: boolean;
  ip: string;
  location: string;
  country?: string;
  region?: string;
  city?: string;
  queryIp?: string;
}

export interface CachedCityData {
  city: string;
  timestamp: number;
  source?: "auto" | "manual" | "cache" | "fallback";
  confidence?: "high" | "medium" | "low";
}

export function normalizeCityName(city: string): string {
  if (!city) return "";
  return city
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[，。；：、]/g, "")
    .replace(/[\u3000]/g, " ");
}

export function isValidCity(city: string, cityData?: Record<string, string[]> | null): boolean {
  const normalized = normalizeCityName(city);
  if (!normalized) return false;

  const invalidSet = new Set(INVALID_CITIES.map((v) => normalizeCityName(v).toLowerCase()));
  if (invalidSet.has(normalized.toLowerCase())) return false;
  if (normalized.length < 2) return false;

  if (cityData) {
    const allCities = Object.values(cityData).flat();
    if (allCities.includes(normalized)) return true;
  }

  return true;
}

export function resolveCityFromIp(data: IpResponse, cityData?: Record<string, string[]> | null): string | null {
  if (data.city && isValidCity(data.city, cityData)) {
    return normalizeCityName(data.city);
  }
  return null;
}

export function getFallbackCity(lastValid: string | null, cityData?: Record<string, string[]> | null): string {
  if (lastValid && isValidCity(lastValid, cityData)) {
    return normalizeCityName(lastValid);
  }
  return DEFAULT_CITY;
}

export function safeReadCachedCity(cacheStr: string | null): CachedCityData | null {
  if (!cacheStr) return null;
  try {
    const parsed = JSON.parse(cacheStr) as CachedCityData;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.city !== "string" || typeof parsed.timestamp !== "number") return null;
    return {
      city: normalizeCityName(parsed.city),
      timestamp: parsed.timestamp,
      source: parsed.source,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
}

export function safeWriteCachedCity(payload: CachedCityData): void {
  localStorage.setItem("flatnas_auto_city", JSON.stringify(payload));
}

export function formatLocationSource(source: "auto" | "manual" | "cache" | "fallback"): string {
  switch (source) {
    case "auto":
      return "自动定位";
    case "manual":
      return "手动城市";
    case "cache":
      return "缓存城市";
    case "fallback":
      return "默认城市";
    default:
      return source;
  }
}
