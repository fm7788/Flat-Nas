type MemorySample = {
  t: number;
  used: number;
  total: number;
  limit: number;
};

type ObjectUrlEntry = {
  url: string;
  size: number;
  createdAt: number;
  lastUsed: number;
  refCount: number;
  key?: string;
  managed: boolean;
};

export type ObjectUrlRuntimeSnapshot = {
  objectUrlCount: number;
  objectUrlBytes: number;
  managedCount: number;
  managedBytes: number;
  unmanagedCount: number;
  unmanagedBytes: number;
  keyCount: number;
  idleManagedCount: number;
  samples: MemorySample[];
};

export type ObjectUrlRuntimeReport = {
  summary: ObjectUrlRuntimeSnapshot;
  largest: Array<{
    key?: string;
    size: number;
    ageMs: number;
    idleMs: number;
    managed: boolean;
  }>;
};

declare global {
  interface Window {
    __flatnasObjectUrlRuntime?: {
      originalCreate: typeof URL.createObjectURL;
      originalRevoke: typeof URL.revokeObjectURL;
      initialized: boolean;
    };
  }
}

const urlMap = new Map<string, ObjectUrlEntry>();
const keyMap = new Map<string, string>();
const listeners = new Set<(snapshot: ObjectUrlRuntimeSnapshot) => void>();
let totalBytes = 0;
let sampleTimer: number | null = null;
let sweepTimer: number | null = null;

const MAX_SAMPLES = 120;
const SAMPLE_INTERVAL = 2000;
const SWEEP_INTERVAL = 30000;
const IDLE_TTL = 2 * 60 * 1000;
const MAX_MANAGED_COUNT = 120;
const MAX_MANAGED_BYTES = 200 * 1024 * 1024;

const getMemorySample = (): MemorySample | null => {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };
  if (!perf.memory) return null;
  return {
    t: Date.now(),
    used: perf.memory.usedJSHeapSize,
    total: perf.memory.totalJSHeapSize,
    limit: perf.memory.jsHeapSizeLimit,
  };
};

const snapshot = (): ObjectUrlRuntimeSnapshot => {
  let managedCount = 0;
  let managedBytes = 0;
  let unmanagedCount = 0;
  let unmanagedBytes = 0;
  let idleManagedCount = 0;
  const now = Date.now();
  for (const entry of urlMap.values()) {
    if (entry.managed) {
      managedCount += 1;
      managedBytes += entry.size;
      if (entry.refCount <= 0 && now - entry.lastUsed >= IDLE_TTL) idleManagedCount += 1;
    } else {
      unmanagedCount += 1;
      unmanagedBytes += entry.size;
    }
  }
  return {
    objectUrlCount: urlMap.size,
    objectUrlBytes: totalBytes,
    managedCount,
    managedBytes,
    unmanagedCount,
    unmanagedBytes,
    keyCount: keyMap.size,
    idleManagedCount,
    samples: samples,
  };
};

const samples: MemorySample[] = [];

const notify = () => {
  const snap = snapshot();
  for (const fn of listeners) fn(snap);
};

const track = (url: string, size: number, managed: boolean, key?: string) => {
  const now = Date.now();
  const existing = urlMap.get(url);
  if (existing) {
    const delta = size - existing.size;
    existing.size = size;
    existing.lastUsed = now;
    if (typeof key === "string") existing.key = key;
    totalBytes += delta;
    return;
  }
  urlMap.set(url, {
    url,
    size,
    createdAt: now,
    lastUsed: now,
    refCount: managed ? 1 : 0,
    key,
    managed,
  });
  totalBytes += size;
};

const untrack = (url: string) => {
  const existing = urlMap.get(url);
  if (!existing) return;
  totalBytes -= existing.size;
  urlMap.delete(url);
};

const createAndTrack = (obj: Blob | MediaSource, managed: boolean, key?: string) => {
  const runtime = window.__flatnasObjectUrlRuntime;
  if (!runtime) return URL.createObjectURL(obj);
  const url = runtime.originalCreate(obj);
  const size = obj instanceof Blob ? obj.size : 0;
  track(url, size, managed, key);
  return url;
};

const sweep = () => {
  const now = Date.now();
  const managedEntries = Array.from(urlMap.values()).filter((e) => e.managed);
  for (const entry of managedEntries) {
    if (entry.refCount > 0) continue;
    if (now - entry.lastUsed < IDLE_TTL) continue;
    if (entry.key) keyMap.delete(entry.key);
    const runtime = window.__flatnasObjectUrlRuntime;
    if (runtime) runtime.originalRevoke(entry.url);
    untrack(entry.url);
  }

  const remaining = Array.from(urlMap.values()).filter((e) => e.managed && e.refCount <= 0);
  const managedBytes = remaining.reduce((sum, e) => sum + e.size, 0);
  if (remaining.length > MAX_MANAGED_COUNT || managedBytes > MAX_MANAGED_BYTES) {
    remaining.sort((a, b) => a.lastUsed - b.lastUsed);
    let count = remaining.length;
    let bytes = managedBytes;
    for (const entry of remaining) {
      if (count <= MAX_MANAGED_COUNT && bytes <= MAX_MANAGED_BYTES) break;
      if (entry.key) keyMap.delete(entry.key);
      const runtime = window.__flatnasObjectUrlRuntime;
      if (runtime) runtime.originalRevoke(entry.url);
      untrack(entry.url);
      count -= 1;
      bytes -= entry.size;
    }
  }
  notify();
};

const startTimers = () => {
  if (!sampleTimer) {
    sampleTimer = window.setInterval(() => {
      const sample = getMemorySample();
      if (sample) {
        samples.push(sample);
        if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
      }
      notify();
    }, SAMPLE_INTERVAL);
  }
  if (!sweepTimer) {
    sweepTimer = window.setInterval(() => {
      sweep();
    }, SWEEP_INTERVAL);
  }
};

export const initObjectUrlRuntime = () => {
  if (!window.__flatnasObjectUrlRuntime) {
    window.__flatnasObjectUrlRuntime = {
      originalCreate: URL.createObjectURL.bind(URL),
      originalRevoke: URL.revokeObjectURL.bind(URL),
      initialized: false,
    };
  }
  const runtime = window.__flatnasObjectUrlRuntime;
  if (!runtime || runtime.initialized) return;
  runtime.initialized = true;
  const originalCreate = runtime.originalCreate;
  const originalRevoke = runtime.originalRevoke;
  URL.createObjectURL = ((obj: Blob | MediaSource) => {
    const url = originalCreate(obj);
    const size = obj instanceof Blob ? obj.size : 0;
    track(url, size, false);
    notify();
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    untrack(url);
    notify();
    return originalRevoke(url);
  }) as typeof URL.revokeObjectURL;
  startTimers();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") sweep();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", sweep);
};

export const subscribeObjectUrlRuntime = (fn: (snapshot: ObjectUrlRuntimeSnapshot) => void) => {
  listeners.add(fn);
  fn(snapshot());
  return () => {
    listeners.delete(fn);
  };
};

export const acquireObjectUrl = (key: string, blob: Blob) => {
  const existingUrl = keyMap.get(key);
  if (existingUrl) {
    const entry = urlMap.get(existingUrl);
    if (entry) {
      entry.lastUsed = Date.now();
      entry.refCount = Math.max(1, entry.refCount);
      notify();
      return existingUrl;
    }
  }
  const url = createAndTrack(blob, true, key);
  keyMap.set(key, url);
  notify();
  return url;
};

export const touchObjectUrl = (key: string) => {
  const url = keyMap.get(key);
  if (!url) return;
  const entry = urlMap.get(url);
  if (!entry) return;
  entry.lastUsed = Date.now();
  notify();
};

export const releaseObjectUrl = (key: string, immediate?: boolean) => {
  const url = keyMap.get(key);
  if (!url) return;
  const entry = urlMap.get(url);
  if (entry) {
    entry.refCount = 0;
    entry.lastUsed = Date.now();
  }
  if (immediate) {
    const runtime = window.__flatnasObjectUrlRuntime;
    if (runtime) runtime.originalRevoke(url);
    untrack(url);
    keyMap.delete(key);
  }
  notify();
};

export const getObjectUrlRuntimeSnapshot = () => snapshot();

export const getObjectUrlRuntimeReport = (limit = 5): ObjectUrlRuntimeReport => {
  const now = Date.now();
  const largest = Array.from(urlMap.values())
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((entry) => ({
      key: entry.key,
      size: entry.size,
      ageMs: now - entry.createdAt,
      idleMs: now - entry.lastUsed,
      managed: entry.managed,
    }));
  return { summary: snapshot(), largest };
};
