type FetchWithRecoveryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onNetworkRecovery?: (attempt: number, reason: string) => void;
};

const isNetworkError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError && /network|fetch|load|failed/i.test(error.message)) return true;
  return false;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fetchWithRecovery = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchWithRecoveryOptions = {},
): Promise<Response> => {
  const { timeoutMs = 8000, maxRetries = 1, retryDelayMs = 1500, onNetworkRecovery } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return response;
    } catch (error) {
      lastError = error;
      window.clearTimeout(timer);

      if (attempt < maxRetries && isNetworkError(error)) {
        const reason = error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error";
        onNetworkRecovery?.(attempt, reason);
        await wait(retryDelayMs);
        continue;
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw lastError;
};

export const installNetworkFetchPatch = () => {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const patchedFlag = "__flatnasNetworkFetchPatched__";
  if ((window.fetch as typeof window.fetch & { [patchedFlag]?: boolean })[patchedFlag]) return;

  const nativeFetch = window.fetch.bind(window);
  const networkErrorListeners = new Set<(url: string, error: unknown) => void>();

  const patchedFetch: typeof window.fetch & { [patchedFlag]?: boolean } = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const controller = new AbortController();
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isApiCall = urlStr.includes("/api/");

    return nativeFetch(input, { ...init, signal: controller.signal }).catch(async (error) => {
      if (isApiCall && isNetworkError(error)) {
        networkErrorListeners.forEach((fn) => fn(urlStr, error));
      }
      throw error;
    });
  }) as typeof window.fetch & { [patchedFlag]?: boolean };

  patchedFetch[patchedFlag] = true;
  (patchedFetch as typeof window.fetch & { [patchedFlag]: boolean; addNetworkErrorListener?: typeof networkErrorListeners.add; removeNetworkErrorListener?: typeof networkErrorListeners.delete }).addNetworkErrorListener = (fn) => networkErrorListeners.add(fn);
  (patchedFetch as typeof window.fetch & { [patchedFlag]: boolean; removeNetworkErrorListener?: typeof networkErrorListeners.delete }).removeNetworkErrorListener = (fn) => networkErrorListeners.delete(fn);

  window.fetch = patchedFetch;
};
