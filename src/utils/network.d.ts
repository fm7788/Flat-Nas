export function isInternalNetwork(url: unknown, internalDomains?: string): boolean;
export function getNetworkConfig(appConfig?: {
  internalDomains?: string;
  forceNetworkMode?: "auto" | "lan" | "wan" | "latency";
  latencyThresholdMs?: number;
}): {
  internalDomains: string;
  forceNetworkMode: "auto" | "lan" | "wan" | "latency";
  latencyThresholdMs: number;
};
