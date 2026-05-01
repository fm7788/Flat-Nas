export type NetworkTargetType = "lan" | "overlay" | "wan";

export const NETWORK_PRESET_RULES: Record<string, string[]>;

export const DEFAULT_NETWORK_RULES: string;

export function classifyNetworkTarget(
  url: unknown,
  networkRules?: string,
  internalDomains?: string,
): NetworkTargetType;

export function isInternalNetwork(url: unknown, internalDomains?: string, networkRules?: string): boolean;

export function getNetworkConfig(appConfig?: {
  internalDomains?: string;
  networkRules?: string;
  networkPresets?: Record<string, boolean>;
  latencyThresholdMs?: number;
}, localForceNetworkMode?: "auto" | "lan" | "wan" | "latency"): {
  internalDomains: string;
  networkRules: string;
  forceNetworkMode: "auto" | "lan" | "wan" | "latency";
  latencyThresholdMs: number;
};
