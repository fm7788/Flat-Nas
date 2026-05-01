<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useMainStore } from "@/stores/main";
import type { WidgetConfig } from "@/types";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

type DockerApiState = "disabled" | "unavailable" | "ready";

type DockerPort = {
  PublicPort?: number;
  PrivatePort?: number;
};

type DockerStats = {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netIO?: { rx: number; tx: number };
  blockIO?: { read: number; write: number };
};

type InspectLite = {
  networkMode: string;
  ports: number[];
};

type DockerContainer = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: DockerPort[];
  hasUpdate?: boolean;
  stats?: DockerStats;
  mockStartAt?: number;
};

interface DockerInfo {
  OSType: string;
  Architecture: string;
  Containers: number;
  Name: string;
  Images: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

type DockerContainersResponse = {
  success: boolean;
  state?: DockerApiState;
  error?: string;
  data?: DockerContainer[];
  updateStatus?: UpdateCheckStatus;
};

type DockerInfoResponse = {
  success: boolean;
  state?: DockerApiState;
  error?: string;
  info?: DockerInfo;
  version?: { Version?: string };
  socketPath?: string;
};

const store = useMainStore();

// Polling intervals (ms)
const POLL_INTERVAL_MIN = 12000;
const POLL_INTERVAL_MAX = 17000;
const POLL_INTERVAL_ERROR = 36000;

const props = defineProps<{ widget?: WidgetConfig; compact?: boolean }>();

const MB = 1024 * 1024;
const dockerInfo = ref<DockerInfo | null>(null);
const unhealthyCount = computed(
  () =>
    containers.value.filter((c) => c.Status && c.Status.toLowerCase().includes("unhealthy")).length,
);

const MOCK_CONTAINERS: DockerContainer[] = [
  ...[
    {
      Id: "mock-1",
      Names: ["/nginx-proxy"],
      Image: "nginx:latest",
      State: "running",
      Status: "Up 2 hours",
      Ports: [{ PublicPort: 80, PrivatePort: 80 }],
      stats: {
        cpuPercent: 0.5,
        memUsage: 50 * 1024 * 1024,
        memLimit: 1024 * 1024 * 1024,
        memPercent: 4.8,
      },
    },
    {
      Id: "mock-2",
      Names: ["/redis-cache"],
      Image: "redis:alpine",
      State: "running",
      Status: "Up 5 days",
      Ports: [{ PublicPort: 6379, PrivatePort: 6379 }],
      stats: {
        cpuPercent: 0.1,
        memUsage: 20 * 1024 * 1024,
        memLimit: 1024 * 1024 * 1024,
        memPercent: 1.9,
      },
    },
    {
      Id: "mock-3",
      Names: ["/postgres-db"],
      Image: "postgres:15",
      State: "running",
      Status: "Up 12 hours",
      Ports: [{ PublicPort: 5432, PrivatePort: 5432 }],
      stats: {
        cpuPercent: 1.2,
        memUsage: 120 * 1024 * 1024,
        memLimit: 2048 * 1024 * 1024,
        memPercent: 5.8,
      },
    },
    {
      Id: "mock-4",
      Names: ["/stopped-service"],
      Image: "busybox:latest",
      State: "exited",
      Status: "Exited (0) 3 hours ago",
      Ports: [],
    },
    {
      Id: "mock-5",
      Names: ["/internal-worker"],
      Image: "python:3.9-slim",
      State: "running",
      Status: "Up 45 mins",
      Ports: [], // No public ports
      stats: {
        cpuPercent: 45.5,
        memUsage: 300 * 1024 * 1024,
        memLimit: 1024 * 1024 * 1024,
        memPercent: 29.3,
      },
    },
    {
      Id: "mock-6",
      Names: ["/very-long-container-name-for-testing-ui-layout-truncation"],
      Image: "node:18-alpine",
      State: "running",
      Status: "Up 1 day",
      Ports: [
        { PublicPort: 3000, PrivatePort: 3000 },
        { PublicPort: 8080, PrivatePort: 8080 },
      ],
      stats: {
        cpuPercent: 2.5,
        memUsage: 150 * 1024 * 1024,
        memLimit: 1024 * 1024 * 1024,
        memPercent: 14.6,
      },
    },
  ],
  ...Array.from({ length: 44 }, (_, i) => ({
    Id: `mock-extra-${i + 7}`,
    Names: [`/extra-container-${i + 7}`],
    Image: "alpine:latest",
    State: Math.random() > 0.2 ? "running" : "exited",
    Status: "Up 1 hour",
    Ports: [{ PublicPort: 9000 + i, PrivatePort: 80 }],
    stats: {
      cpuPercent: +(Math.random() * 5).toFixed(1),
      memUsage: Math.round((20 + Math.random() * 100) * 1024 * 1024),
      memLimit: 1024 * 1024 * 1024,
      memPercent: 5.0,
    },
  })),
];

const useMock = computed(() => Boolean(props.widget?.data?.useMock));
const autoUpdateEnabled = computed(() => Boolean(props.widget?.data?.autoUpdate));
const isDockerFeatureEnabled = computed(() => Boolean(store.systemConfig.enableDocker));
const containers = ref<DockerContainer[]>([]);
const error = ref("");
const dockerState = ref<DockerApiState>(isDockerFeatureEnabled.value ? "unavailable" : "disabled");
let pollTimer: ReturnType<typeof setInterval> | null = null;

const formatDockerError = (msg: string) => {
  if (!msg) return "";
  if (dockerState.value === "disabled") {
    return "Docker 服务已关闭，请在设置中开启“Docker 服务”总开关。";
  }
  const lower = msg.toLowerCase();
  if (lower.includes("docker is disabled")) {
    return "Docker 服务已关闭，请在设置中开启“Docker 服务”总开关。";
  }
  if (lower.includes("docker not available")) {
    return "Docker 未启用或未配置连接地址。容器部署请挂载 /var/run/docker.sock 并设置 dockerHost=unix:///var/run/docker.sock";
  }
  if (lower.includes("docker.sock") || lower.includes("unix:///var/run/docker.sock")) {
    return "无法连接 Docker Socket，请确认宿主机 Docker 已启动，并在容器中挂载 /var/run/docker.sock";
  }
  if (
    lower.includes("pipe/docker_engine") ||
    lower.includes("open //./pipe/docker_engine") ||
    lower.includes("system cannot find the file specified")
  ) {
    return "未检测到 Docker 引擎，请启动 Docker Desktop 或配置 dockerHost";
  }
  if (lower.includes("elevated privileges")) {
    return "Windows 需要管理员权限访问 Docker 引擎";
  }
  return msg;
};

const errorDisplay = computed(() => formatDockerError(error.value));

const formatDuration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} days`;
  if (h > 0) return `${h} hours`;
  if (m > 0) return `${m} mins`;
  return `${s}s`;
};

const formatBytes = (bytes: number) => {
  if (!bytes || bytes <= 0) return "0B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(k));
  const i = Math.min(Math.max(rawIndex, 0), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + (sizes[i] ?? "B");
};

const performMockAction = (id: string, action: string) => {
  const idx = containers.value.findIndex((c) => c.Id === id);
  if (idx < 0) return;
  const c = containers.value[idx]!;
  if (action === "start") {
    c.State = "running";
    c.mockStartAt = Date.now();
    const memLimit = 1024 * MB;
    const memUsage = Math.round(20 * MB + Math.random() * 80 * MB);
    const cpuPercent = +(Math.random() * 2).toFixed(1);
    const memPercent = +((memUsage / memLimit) * 100).toFixed(1);
    c.stats = { cpuPercent, memUsage, memLimit, memPercent };
    c.Status = `Up ${formatDuration(0)}`;
  } else if (action === "stop") {
    c.State = "exited";
    c.stats = undefined;
    c.Status = "Exited";
  } else if (action === "restart") {
    c.State = "running";
    c.mockStartAt = Date.now();
    const memLimit = 1024 * MB;
    const memUsage = Math.round(20 * MB + Math.random() * 80 * MB);
    const cpuPercent = +(Math.random() * 2).toFixed(1);
    const memPercent = +((memUsage / memLimit) * 100).toFixed(1);
    c.stats = { cpuPercent, memUsage, memLimit, memPercent };
    c.Status = `Up ${formatDuration(0)}`;
  }
  containers.value = [...containers.value];
};

const errorCount = ref(0);
const lastMockUpdate = ref(0);

interface UpdateCheckStatus {
  lastCheck: number;
  isChecking: boolean;
  lastError: string | null;
  checkedCount: number;
  totalCount?: number;
  updateCount: number;
  failures?: { name: string; error: string }[];
}
const updateStatus = ref<UpdateCheckStatus | null>(null);
const isCheckingUpdate = ref(false);

const applyDockerDisabledState = () => {
  dockerState.value = "disabled";
  dockerInfo.value = null;
  updateStatus.value = null;
  containers.value = [];
  errorCount.value = 0;
  error.value = "Docker 服务已关闭";
  stopPolling();
};

const triggerUpdateCheck = async () => {
  if (isCheckingUpdate.value || updateStatus.value?.isChecking) return;
  if (!isDockerFeatureEnabled.value) {
    showToast("请先开启 Docker 服务");
    return;
  }
  if (!autoUpdateEnabled.value) {
    showToast("请先开启自动升级镜像");
    return;
  }
  try {
    isCheckingUpdate.value = true;
    const headers = store.getHeaders();
    await fetch("/api/docker/check-updates", { method: "POST", headers });
    // 立即刷新一次以获取最新状态（变为 isChecking=true）
    setTimeout(fetchContainers, 500);
  } catch (e) {
    console.error("Failed to trigger update check", e);
  } finally {
    isCheckingUpdate.value = false;
  }
};

const isLoading = ref(false);

const fetchContainers = async () => {
  if (!isDockerFeatureEnabled.value) {
    applyDockerDisabledState();
    return;
  }
  if (useMock.value) {
    dockerState.value = "ready";
    if (!containers.value.length) {
      containers.value = JSON.parse(JSON.stringify(MOCK_CONTAINERS)) as DockerContainer[];
      containers.value.forEach((c) => {
        if (c.State === "running") c.mockStartAt = Date.now();
      });
      lastMockUpdate.value = Date.now();
      // 模拟模式下也要触发 prefetch，确保逻辑一致性（虽然 mock 不发请求，但可能涉及状态处理）
      prefetchInspectForContainers(containers.value);
    } else {
      const now = Date.now();
      // Throttle mock updates to match real data frequency (5s)
      if (now - lastMockUpdate.value < 4500) {
        error.value = "";
        return;
      }
      lastMockUpdate.value = now;

      containers.value = containers.value.map((c) => {
        if (c.State === "running") {
          const memLimit = c.stats?.memLimit ?? 1024 * MB;
          const baseMem = c.stats?.memUsage ?? 50 * MB;
          const memUsage = Math.max(
            20 * MB,
            Math.min(memLimit * 0.8, Math.round(baseMem * (1 + (Math.random() - 0.5) * 0.1))),
          );
          const cpuBase = c.stats?.cpuPercent ?? 0.5;
          const cpuPercent = Math.max(
            0,
            Math.min(100, +(cpuBase * (1 + (Math.random() - 0.5) * 0.2)).toFixed(1)),
          );
          const memPercent = +((memUsage / memLimit) * 100).toFixed(1);
          const netIO = c.stats?.netIO || { rx: 0, tx: 0 };
          const blockIO = c.stats?.blockIO || { read: 0, write: 0 };
          // Randomly increase mock stats
          if (Math.random() > 0.5) {
            netIO.rx += Math.floor(Math.random() * 1024 * 10);
            netIO.tx += Math.floor(Math.random() * 1024 * 10);
            blockIO.read += Math.floor(Math.random() * 1024 * 10);
            blockIO.write += Math.floor(Math.random() * 1024 * 10);
          }

          c.stats = { cpuPercent, memUsage, memLimit, memPercent, netIO, blockIO };
          if (c.mockStartAt) c.Status = `Up ${formatDuration(Date.now() - c.mockStartAt)}`;
        }
        return c;
      });
    }
    error.value = "";
    return;
  }
  try {
    isLoading.value = true;
    const headers = store.getHeaders();
    const res = await fetch("/api/docker/containers", { headers });

    if (!res.ok) {
      // 网络请求失败，不停止轮询，只是记录错误
      // 也不清空现有数据，保持显示旧数据
      error.value = "连接异常，正在重试...";
      return;
    }

    const data = (await res.json()) as DockerContainersResponse;
    if (data.success) {
      dockerState.value = data.state || "ready";
      containers.value = (data.data || []) as DockerContainer[];
      if (data.updateStatus) {
        updateStatus.value = data.updateStatus;
      }
      prefetchInspectForContainers(containers.value);
      errorCount.value = 0;
      error.value = "";
    } else {
      if (data.state === "disabled") {
        applyDockerDisabledState();
        return;
      }
      dockerState.value = data.state || "unavailable";
      // 只有明确收到后端说 Docker 不可用时，才清空数据
      if (dockerState.value === "unavailable") {
        // 如果我们之前有数据，尽量保留，除非用户手动刷新或者真的长时间连不上
        // 这里稍微宽容一点：如果之前有数据，不轻易清空，只是标记错误
        // containers.value = []; // 移除这行，尽量保留数据
        error.value = data.error || "Docker 不可用";
        errorCount.value++;

        // 如果 Docker 明确不可用，为了节省资源，直接停止自动轮询
        // 但如果还在启动宽容期内（retryDeadline），则继续尝试
        if (Date.now() < retryDeadline.value) {
          error.value = (data.error || "Docker 不可用") + " (启动检测中...)";
          // 不调用 stopPolling，让 startPolling 继续调度
        } else {
          // 超过宽容期，停止轮询
          // 用户可以通过点击“重试连接”按钮手动重新开始
          stopPolling();
          return;
        }
      } else {
        // 其他业务错误，保留数据，显示错误
        error.value = data.error || "获取数据失败";
      }
    }
  } catch (e: unknown) {
    // 网络层错误（如断网、超时），保留数据，不停止轮询
    // containers.value = []; // 保持旧数据
    const msg = e instanceof Error ? e.message : String(e);
    error.value = "网络连接不稳定: " + msg;
    // 不停止轮询，内网穿透环境下允许失败
  } finally {
    isLoading.value = false;
  }
};

const toastMessage = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const showToast = (msg: string, duration = 2000) => {
  toastMessage.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMessage.value = "";
    toastTimer = null;
  }, duration);
};

const fetchDockerInfo = async (silent = true) => {
  if (!isDockerFeatureEnabled.value) {
    applyDockerDisabledState();
    if (!silent) {
      showToast("Docker 服务已关闭");
    }
    return;
  }
  if (useMock.value) return;
  try {
    const headers = store.getHeaders();
    const res = await fetch("/api/docker/info", { headers });
    const data = (await res.json()) as DockerInfoResponse;
    if (data.success && data.state === "ready") {
      dockerState.value = "ready";
      dockerInfo.value = data.info;
      if (!silent) {
        showToast("✅ Docker 连接成功");
      }
    } else {
      dockerState.value = data.state || "unavailable";
      if (data.state === "disabled") {
        applyDockerDisabledState();
        if (!silent) showToast("Docker 服务已关闭");
        return;
      }
      if (!silent) showToast(`❌ 连接失败: ${data.error}`);
    }
  } catch (e: unknown) {
    if (!silent) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast("❌ 网络错误: " + msg);
    }
  }
};

const retryDeadline = ref(0);
const RETRY_WINDOW = 3 * 60 * 1000; // 3分钟
const RETRY_INTERVAL = 10000; // 10秒

const checkConnection = (silent = false) => {
  if (!isDockerFeatureEnabled.value) {
    applyDockerDisabledState();
    return;
  }
  error.value = "";
  errorCount.value = 0;
  retryDeadline.value = Date.now() + RETRY_WINDOW; // 重置重试窗口
  fetchContainers();
  fetchDockerInfo(silent);
  startPolling();
};

const handleAction = async (id: string, action: string) => {
  if (!isDockerFeatureEnabled.value) {
    showToast("Docker 服务已关闭");
    return;
  }
  if (useMock.value) {
    performMockAction(id, action);
    return;
  }
  try {
    const headers = store.getHeaders();
    const res = await fetch(`/api/docker/container/${id}/${action}`, {
      method: "POST",
      headers,
    });
    if (res.ok) fetchContainers();
  } catch (e) {
    console.error(e);
  }
};

const startPolling = () => {
  if (!isDockerFeatureEnabled.value) return;
  if (pollTimer) clearTimeout(pollTimer);

  const poll = async () => {
    if (document.visibilityState === "hidden") return;

    // 如果之前被标记停止，这里可以根据需求决定是否继续
    // 但根据最新需求，我们尽量不停止，而是降频

    await fetchContainers();
    cleanupCache();

    // 动态频率算法：
    // 1. 错误状态：
    //    a. 启动宽容期内：10秒 (RETRY_INTERVAL)
    //    b. 超过宽容期：30秒 (降频避险)
    // 2. 正常状态：12-17秒随机
    let interval = POLL_INTERVAL_MIN + Math.random() * (POLL_INTERVAL_MAX - POLL_INTERVAL_MIN);

    if (useMock.value) {
      interval = 5000;
    } else if (errorCount.value > 0) {
      if (Date.now() < retryDeadline.value) {
        interval = RETRY_INTERVAL;
      } else {
        interval = POLL_INTERVAL_ERROR;
      }
    }

    // 重新调度下一次轮询
    // 注意：这里必须重新赋值 pollTimer，否则 stopPolling 无法清除新的定时器
    pollTimer = setTimeout(poll, interval);
  };

  // 首次启动给一个 0~2秒 的随机延迟，避免多个组件同时请求
  const initialDelay = Math.random() * 2000;
  pollTimer = setTimeout(poll, initialDelay);
};

const stopPolling = () => {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
};

useResumeRefresh({
  onHidden: () => {
    stopPolling();
  },
  onVisible: () => {
    if (isDockerFeatureEnabled.value) checkConnection(true);
  },
  onOnline: () => {
    if (isDockerFeatureEnabled.value) checkConnection(true);
  },
});

onMounted(() => {
  if (isDockerFeatureEnabled.value) {
    // 恢复自动加载，确保添加到桌面后能自动显示内容
    checkConnection();
  } else {
    applyDockerDisabledState();
  }
});

onUnmounted(() => {
  stopPolling();
});

watch(
  () => store.systemConfig.enableDocker,
  (enabled) => {
    if (enabled) {
      dockerState.value = "unavailable";
      error.value = "";
      checkConnection(true);
    } else {
      applyDockerDisabledState();
    }
  },
);

const inspectCache = ref<Record<string, { ts: number; data: InspectLite }>>({});
const INSPECT_TTL = 60_000;
const inflightInspect = new Set<string>();

const cleanupCache = () => {
  const now = Date.now();
  for (const key in inspectCache.value) {
    const entry = inspectCache.value[key];
    if (entry && now - entry.ts > INSPECT_TTL) {
      delete inspectCache.value[key];
    }
  }
};

const normalizeContainerName = (s: string) =>
  String(s || "")
    .replace(/^\//, "")
    .trim();

const fetchInspectLite = async (id: string): Promise<InspectLite | null> => {
  if (!isDockerFeatureEnabled.value) return null;
  const cached = inspectCache.value[id];
  const now = Date.now();
  if (cached && now - cached.ts < INSPECT_TTL) return cached.data;
  if (inflightInspect.has(id)) return cached ? cached.data : null;
  inflightInspect.add(id);
  try {
    const headers = store.getHeaders();
    const res = await fetch(`/api/docker/container/${encodeURIComponent(id)}/inspect-lite`, {
      headers,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload || !payload.success) return cached ? cached.data : null;
    const data = payload.data as InspectLite;
    if (!data || typeof data.networkMode !== "string" || !Array.isArray(data.ports)) {
      return cached ? cached.data : null;
    }
    inspectCache.value = { ...inspectCache.value, [id]: { ts: now, data } };
    return data;
  } catch {
    return cached ? cached.data : null;
  } finally {
    inflightInspect.delete(id);
  }
};

const getPublishedPorts = (c: DockerContainer): number[] =>
  (c.Ports || [])
    .map((p) => p.PublicPort)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 65535);

const getDetectedPorts = (c: DockerContainer): number[] => {
  const published = getPublishedPorts(c);
  if (published.length > 0) return published;
  const cached = inspectCache.value[c.Id]?.data;
  if (!cached) return [];
  if (cached.networkMode !== "host") return [];
  return (cached.ports || []).filter(
    (p) => typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 65535,
  );
};

// 常见 Web 端口优先级列表
const PREFERRED_PRIVATE_PORTS = [
  80, 443, 8080, 8000, 8096, 3000, 5000, 5001, 5244, 5678, 9000, 9091,
];

const getPreferredPort = (c: DockerContainer): number | null => {
  // 1. 尝试从 Ports 映射中找到 PrivatePort 匹配的
  if (c.Ports && c.Ports.length > 0) {
    // 优先找 PrivatePort 在列表中的
    // 排序：优先列表中的 index 小的优先
    const sorted = [...c.Ports].sort((a, b) => {
      const idxA = a.PrivatePort ? PREFERRED_PRIVATE_PORTS.indexOf(a.PrivatePort) : -1;
      const idxB = b.PrivatePort ? PREFERRED_PRIVATE_PORTS.indexOf(b.PrivatePort) : -1;
      // 如果都在列表中，按列表顺序
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      // 如果有一个在列表中，它优先
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      // 都不在列表中，保持原样 (或者按 PublicPort 排序?)
      return 0;
    });

    const best = sorted.find(
      (p) => typeof p.PublicPort === "number" && p.PublicPort > 0 && p.PublicPort <= 65535,
    );
    if (best) return best.PublicPort!;
  }

  // 2. 如果没有 Ports (Host模式)，尝试从 inspectCache 获取
  const cached = inspectCache.value[c.Id]?.data;
  if (cached && cached.ports && cached.ports.length > 0) {
    const validPorts = cached.ports.filter(
      (p) => typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 65535,
    );
    if (validPorts.length > 0) {
      // 同样尝试匹配优先级
      const sorted = validPorts.sort((a, b) => {
        const idxA = PREFERRED_PRIVATE_PORTS.indexOf(a);
        const idxB = PREFERRED_PRIVATE_PORTS.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
      return sorted[0] ?? null;
    }
  }

  // 3. 最后尝试使用 PrivatePort
  // 有些容器只有 PrivatePort 没有 PublicPort (如 bridge 模式未映射)，
  // 但用户可能通过内网路由访问
  if (c.Ports && c.Ports.length > 0) {
    const sorted = [...c.Ports]
      .filter((p) => p.PrivatePort)
      .sort((a, b) => {
        const idxA = a.PrivatePort ? PREFERRED_PRIVATE_PORTS.indexOf(a.PrivatePort) : -1;
        const idxB = b.PrivatePort ? PREFERRED_PRIVATE_PORTS.indexOf(b.PrivatePort) : -1;
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });

    const first = sorted[0];
    if (first?.PrivatePort) return first.PrivatePort;
  }

  return null;
};

const prefetchInspectForContainers = (list: DockerContainer[]) => {
  if (useMock.value || !isDockerFeatureEnabled.value) return;

  // Cleanup cache: remove entries for containers that no longer exist
  const currentIds = new Set(list.map((c) => c.Id));
  const newCache = { ...inspectCache.value };
  let changed = false;
  for (const id in newCache) {
    if (!currentIds.has(id)) {
      delete newCache[id];
      changed = true;
    }
  }
  if (changed) {
    inspectCache.value = newCache;
  }

  // 找出需要 Inspect 的容器（没有 PublicPort 的容器）
  const targets = list.filter((c) => c && c.Id && getPublishedPorts(c).length === 0);

  // 批量处理策略：每 5 个一组，每组之间增加随机延迟
  // 避免一次性发起几十个请求导致浏览器或后端拥堵
  const CHUNK_SIZE = 5;

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);

    // 计算延迟：
    // 基础延迟：每组间隔 1000ms
    // 随机抖动：0~500ms
    // 第一组延迟很短，后续组逐渐推后
    const delay = i * 200 + Math.random() * 500;

    setTimeout(() => {
      chunk.forEach((c) => {
        void fetchInspectLite(c.Id);
      });
    }, delay);
  }
};

const cleanHost = (host: string) => {
  return host
    .replace(/^https?:\/\//i, "") // 移除协议头
    .replace(/\/+$/, "") // 移除尾部斜杠
    .trim();
};

const getContainerLanUrl = (c: DockerContainer): string => {
  const port = getPreferredPort(c);
  if (!port) return "";
  const lanHost =
    (props.widget?.data && typeof props.widget.data.lanHost === "string"
      ? props.widget.data.lanHost.trim()
      : "") || "";

  const host = cleanHost(lanHost) || window.location.hostname;
  const scheme = port === 443 ? "https" : "http";
  return `${scheme}://${host}:${port}`;
};

const getContainerPublicUrl = (c: DockerContainer): string => {
  const port = getPreferredPort(c);
  if (!port) return "";

  const map =
    (props.widget?.data &&
    typeof (props.widget.data as Record<string, unknown>).publicHosts === "object"
      ? ((props.widget!.data as Record<string, unknown>).publicHosts as Record<string, string>)
      : {}) || {};
  const mapped = map[c.Id]?.trim() || "";
  const globalPublic =
    (props.widget?.data && typeof props.widget.data.publicHost === "string"
      ? props.widget.data.publicHost.trim()
      : "") || "";

  // 1. 如果有单独映射的地址
  if (mapped) {
    // 如果 mapped 看起来像完整的 URL (包含协议或端口)，直接使用
    if (/^https?:\/\//i.test(mapped)) return mapped;
    // 否则假设是 hostname，拼接协议和端口
    const scheme = port === 443 ? "https" : "http";
    return `${scheme}://${cleanHost(mapped)}:${port}`;
  }

  // 2. 如果有全局公网 Host
  if (globalPublic) {
    const scheme = port === 443 ? "https" : "http";
    return `${scheme}://${cleanHost(globalPublic)}:${port}`;
  }

  // 3. 默认回退到当前 Host
  const host = window.location.hostname;
  const scheme = port === 443 ? "https" : "http";
  return `${scheme}://${host}:${port}`;
};

const getDisabledContainers = () => {
  if (!props.widget || !props.widget.data) return [];
  return (props.widget.data.disabledContainers as string[]) || [];
};

const isAutoUpdateDisabled = (id: string) => {
  const list = getDisabledContainers();
  return list.includes(id);
};

const toggleAutoUpdateDisabled = (id: string, disabled: boolean) => {
  if (!props.widget) return;

  const widgetInStore = store.widgets.find((w) => w.id === props.widget!.id);
  if (!widgetInStore) return;

  if (!widgetInStore.data) widgetInStore.data = {};

  const list = new Set(getDisabledContainers());
  if (disabled) {
    list.add(id);
  } else {
    list.delete(id);
  }

  widgetInStore.data.disabledContainers = Array.from(list);
  store.markDirty();

  showToast(disabled ? "已禁止该容器自动升级" : "已恢复该容器自动升级");
};

const openContainerUrl = (c: DockerContainer) => {
  const url = getContainerLanUrl(c);
  if (url) window.open(url, "_blank");
};

const openContainerPublicUrl = (c: DockerContainer) => {
  const url = getContainerPublicUrl(c);
  if (url) window.open(url, "_blank");
};

const addToHome = (c: DockerContainer) => {
  // 1. Find or create "Docker" group
  let dockerGroup = store.groups.find((g) => g.title === "Docker");
  if (!dockerGroup) {
    const newGroupId = Date.now().toString();
    store.groups.push({
      id: newGroupId,
      title: "Docker",
      items: [],
      // Default settings for Docker group
      cardLayout: "horizontal",
      gridGap: 8,
      cardSize: 120,
      iconSize: 48,
      showCardBackground: true,
    });
    dockerGroup = store.groups.find((g) => g.title === "Docker");
  }

  if (!dockerGroup) return; // Should not happen

  const addImpl = async () => {
    let lanUrl = getContainerLanUrl(c);
    let publicUrl = getContainerPublicUrl(c);

    if (!lanUrl && !publicUrl) {
      await fetchInspectLite(c.Id);
      lanUrl = getContainerLanUrl(c);
      publicUrl = getContainerPublicUrl(c);
    }

    if (!lanUrl && !publicUrl) {
      const port = prompt("未检测到端口映射/暴露端口，请手动输入端口号 (例如 8080):")?.trim();
      if (!port) return;
      const portNum = parseInt(port, 10);
      if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return;
      const lanHost =
        (props.widget?.data && typeof props.widget.data.lanHost === "string"
          ? props.widget.data.lanHost.trim()
          : "") || "";
      const host = lanHost || window.location.hostname;
      lanUrl = `http://${host}:${portNum}`;
      publicUrl = `http://${window.location.hostname}:${portNum}`;
    }

    const title = normalizeContainerName(c.Names?.[0] || "Container");

    const exists = dockerGroup.items.some((item) => {
      if (item.containerId && item.containerId === c.Id) return true;
      const n = normalizeContainerName(item.containerName || "");
      if (n && n === title) return true;
      return false;
    });
    if (exists) {
      showToast(`容器 "${title}" 已存在`);
      return;
    }

    const newItem = {
      id: Date.now().toString(),
      title: title,
      url: publicUrl,
      lanUrl: lanUrl,
      icon: "", // We can try to fetch icon later or let user set it
      isPublic: false,
      openInNewTab: true,
      containerId: c.Id,
      containerName: title,
      allowRestart: true,
      allowStop: true,
      description: "Docker Container", // Optional description
    };

    store.addItem(newItem, dockerGroup.id);
    showToast(`已添加 "${title}"`);
  };

  void addImpl();
};

const editingPublicId = ref<string | null>(null);
const publicHostTemp = ref("");
const promptPublicHost = (c: DockerContainer) => {
  const map =
    (props.widget?.data &&
    typeof (props.widget.data as Record<string, unknown>).publicHosts === "object"
      ? ((props.widget!.data as Record<string, unknown>).publicHosts as Record<string, string>)
      : {}) || {};
  publicHostTemp.value = map[c.Id] || "";
  editingPublicId.value = c.Id;
};
const savePublicHost = (c: DockerContainer) => {
  const w = store.widgets.find((x) => x.id === props.widget?.id);
  if (!w) return;
  if (!w.data) w.data = {};
  const map =
    typeof (w.data as Record<string, unknown>).publicHosts === "object"
      ? ((w.data as Record<string, unknown>).publicHosts as Record<string, string>)
      : {};
  map[c.Id] = publicHostTemp.value.trim();
  (w.data as Record<string, unknown>).publicHosts = map;
  store.markDirty();
  editingPublicId.value = null;
};
const cancelPublicHost = () => {
  editingPublicId.value = null;
};

const getStatusColor = (state: string) => {
  if (state === "running") return "bg-green-500";
  if (state === "exited") return "bg-gray-400";
  return "bg-yellow-500";
};
</script>

<template>
  <div
    :class="[
      'w-full h-full flex flex-col overflow-hidden',
      props.compact
        ? ''
        : 'bg-white/80 dark:bg-gray-800/80 backdrop-blur-md rounded-2xl p-4 relative',
    ]"
  >
    <div v-if="!props.compact" class="flex items-center justify-between mb-1 shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-xl">🐳</span>
        <span class="font-bold text-gray-700 dark:text-gray-200">Docker</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          @click="triggerUpdateCheck"
          class="text-[10px] bg-gray-50 text-gray-600 px-2 py-1 rounded hover:bg-gray-100 transition-colors flex items-center"
          :title="
            updateStatus?.isChecking
              ? `正在检测: ${updateStatus.checkedCount} / ${updateStatus.totalCount || '?'}`
              : updateStatus?.lastCheck
                ? `上次检测: ${new Date(updateStatus.lastCheck).toLocaleString()}${
                    updateStatus.failures?.length
                      ? '\n\n检测失败:\n' +
                        updateStatus.failures.map((f) => `- ${f.name}: ${f.error}`).join('\n')
                      : ''
                  }`
                : autoUpdateEnabled
                  ? '检测镜像更新'
                  : '请先开启自动升级镜像'
          "
          :disabled="updateStatus?.isChecking || !autoUpdateEnabled || !isDockerFeatureEnabled"
        >
          <span
            v-if="updateStatus?.isChecking"
            class="animate-spin inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full mr-1"
          ></span>
          <span v-if="updateStatus?.isChecking" class="mr-1">
            {{ updateStatus.checkedCount }}/{{ updateStatus.totalCount || "?" }}
          </span>
          <span
            v-else-if="updateStatus?.failures?.length"
            class="text-yellow-600 flex items-center"
          >
            <span class="mr-1">⚠️</span>
            <span>查更新</span>
          </span>
          <span v-else>
            {{ updateStatus?.isChecking ? "检测中" : "查更新" }}
          </span>
        </button>
        <button
          @click="() => checkConnection(false)"
          :disabled="dockerState === 'disabled'"
          class="text-[10px] bg-blue-50 text-blue-500 px-2 py-1 rounded hover:bg-blue-100 transition-colors disabled:opacity-50"
          title="点击获取 Docker 信息"
        >
          <span
            v-if="isLoading"
            class="animate-spin inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full mr-1"
          ></span>
          {{
            isLoading ? "加载中" : dockerState === "disabled" ? "已关闭" : dockerState !== "ready" ? "连接" : "刷新"
          }}
        </button>
        <div class="text-xs text-gray-500" v-if="containers.length">
          {{ containers.filter((c) => c.State === "running").length }} / {{ containers.length }}
        </div>
      </div>
    </div>

    <!-- 错误提示（如果有数据则只显示在顶部，没数据才全屏显示） -->
    <div
      v-if="error && !containers.length"
      class="flex-1 flex flex-col items-center justify-start pt-10 text-red-500 text-xs text-center p-2 gap-2"
    >
      <span>{{ errorDisplay }}</span>
      <button
        @click="() => checkConnection(false)"
        :disabled="dockerState === 'disabled'"
        class="px-3 py-1 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors text-xs"
      >
        {{ dockerState === "disabled" ? "已关闭" : "重新检测" }}
      </button>
    </div>

    <div
      v-else-if="!containers.length && !error"
      class="flex-1 flex flex-col items-center justify-start pt-10 text-gray-400 text-xs text-center p-2 gap-2"
    >
      <span>{{ dockerState === "disabled" ? "Docker 服务已关闭" : "点击刷新获取容器列表" }}</span>
      <button
        @click="() => checkConnection(false)"
        :disabled="dockerState === 'disabled'"
        class="px-3 py-1 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors text-xs"
      >
        {{ dockerState === "disabled" ? "已关闭" : "获取列表" }}
      </button>
    </div>

    <div v-else class="flex flex-col h-full overflow-hidden relative">
      <!-- 弱网提示 -->
      <div
        v-if="error"
        class="absolute top-0 left-0 right-0 z-10 bg-yellow-50/90 text-yellow-600 text-[10px] px-2 py-0.5 text-center backdrop-blur-sm border-b border-yellow-100"
      >
        {{ errorDisplay }}
      </div>
      <!-- 容器列表 (滚动区域) -->
      <div class="flex-1 overflow-y-auto space-y-1 pr-1 custom-scrollbar min-h-0 pt-1">
        <div
          class="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 pb-1 mb-1"
        >
          <div class="flex gap-2">
            <span
              class="px-1.5 py-0.5 bg-green-100 text-green-700 rounded flex items-center gap-1 text-xs"
              title="Running"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              {{ containers.filter((c) => c.State === "running").length }}
            </span>
            <span
              class="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded flex items-center gap-1 text-xs"
              title="Stopped"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
              {{ containers.filter((c) => c.State !== "running").length }}
            </span>
            <span
              v-if="unhealthyCount > 0"
              class="px-1.5 py-0.5 bg-red-100 text-red-700 rounded flex items-center gap-1 text-xs"
              title="Unhealthy"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
              {{ unhealthyCount }}
            </span>
          </div>
          <div v-if="dockerInfo" class="flex gap-2 text-[10px] text-gray-400 items-center ml-1">
            <span title="Images">IMG:{{ dockerInfo.Images }}</span>
          </div>
        </div>
        <div
          v-for="c in containers"
          :key="c.Id"
          class="flex flex-col gap-1 p-1.5 bg-white rounded-lg border border-black"
        >
          <div class="grid grid-cols-[1fr_auto] gap-2 items-start">
            <div class="flex items-start gap-2 min-w-0">
              <div :class="['w-2 h-2 rounded-full shrink-0 mt-1', getStatusColor(c.State)]"></div>
              <div class="flex flex-col min-w-0 flex-1">
                <div class="flex items-center gap-1 min-w-0">
                  <span class="font-medium text-sm truncate text-black" :title="c.Names?.[0] || ''">
                    {{ (c.Names?.[0] || "").replace(/^\//, "") }}
                  </span>
                  <span
                    v-if="c.hasUpdate"
                    class="text-[9px] bg-red-50 text-red-600 px-1 rounded border border-red-200 shrink-0"
                  >
                    可升级
                  </span>
                </div>
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-[10px] text-black truncate min-w-0 flex-1" :title="c.Image">
                    {{ c.Image }}
                  </span>
                  <button
                    @click="promptPublicHost(c)"
                    class="text-[10px] text-black hover:underline px-1 shrink-0"
                    title="添加外网地址"
                  >
                    添加外网地址
                  </button>
                </div>
                <div v-if="editingPublicId === c.Id" class="flex items-center gap-1 mt-1">
                  <input
                    v-model="publicHostTemp"
                    type="text"
                    placeholder="nas.example.com"
                    class="px-2 py-1 border border-gray-200 rounded text-[10px] focus:border-blue-500 outline-none w-36"
                  />
                  <button
                    @click="savePublicHost(c)"
                    class="text-[10px] text-green-600 hover:underline px-1"
                    title="保存"
                  >
                    保存
                  </button>
                  <button
                    @click="cancelPublicHost"
                    class="text-[10px] text-gray-500 hover:underline px-1"
                    title="取消"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
            <div class="flex flex-col items-end shrink-0">
              <span class="text-[10px] text-black">{{ c.Status }}</span>
              <div
                class="flex flex-wrap justify-end gap-1 mt-0.5"
                v-if="getDetectedPorts(c).length"
              >
                <span
                  v-for="(p, i) in getDetectedPorts(c).slice(0, 2)"
                  :key="i"
                  class="text-[9px] bg-blue-50 text-blue-500 px-1 rounded border border-blue-100"
                >
                  {{ p }}
                </span>
                <span v-if="getDetectedPorts(c).length > 2" class="text-[9px] text-black"
                  >+{{ getDetectedPorts(c).length - 2 }}</span
                >
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2 mt-1">
            <div class="flex flex-col gap-1">
              <div
                class="flex justify-between text-[10px] text-gray-500 dark:text-gray-300 items-end"
              >
                <span>CPU</span>
                <span v-if="c.stats" class="font-mono">{{ c.stats.cpuPercent.toFixed(1) }}%</span>
                <span v-else class="text-gray-300 dark:text-gray-500">--</span>
              </div>
              <div class="h-1.5 bg-gray-100 dark:bg-gray-600 rounded-full overflow-hidden">
                <div
                  class="h-full bg-blue-500 rounded-full transition-all duration-500"
                  :style="{ width: c.stats ? Math.min(c.stats.cpuPercent, 100) + '%' : '0%' }"
                ></div>
              </div>
              <div
                class="flex justify-between text-[9px] text-gray-400 dark:text-gray-400 mt-0.5 font-mono items-center"
              >
                <span>NET</span>
                <span v-if="c.stats && c.stats.netIO" class="tracking-tighter">
                  ↓{{ formatBytes(c.stats.netIO.rx) }} ↑{{ formatBytes(c.stats.netIO.tx) }}
                </span>
                <span v-else class="text-gray-300 dark:text-gray-500">--</span>
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <div
                class="flex justify-between text-[10px] text-gray-500 dark:text-gray-300 items-end"
              >
                <span>MEM</span>
                <span v-if="c.stats" class="font-mono"
                  >{{ (c.stats.memUsage / 1024 / 1024).toFixed(0) }}MB</span
                >
                <span v-else class="text-gray-300 dark:text-gray-500">--</span>
              </div>
              <div class="h-1.5 bg-gray-100 dark:bg-gray-600 rounded-full overflow-hidden">
                <div
                  class="h-full bg-purple-500 rounded-full transition-all duration-500"
                  :style="{ width: c.stats ? Math.min(c.stats.memPercent, 100) + '%' : '0%' }"
                ></div>
              </div>
              <div
                class="flex justify-between text-[9px] text-gray-400 dark:text-gray-400 mt-0.5 font-mono items-center"
              >
                <span>I/O</span>
                <span v-if="c.stats && c.stats.blockIO" class="tracking-tighter">
                  R{{ formatBytes(c.stats.blockIO.read) }} W{{ formatBytes(c.stats.blockIO.write) }}
                </span>
                <span v-else class="text-gray-300 dark:text-gray-500">--</span>
              </div>
            </div>
          </div>

          <div
            class="flex items-center justify-end gap-2 mt-1 pt-1 border-t border-gray-100 dark:border-gray-700"
          >
            <div class="flex flex-wrap items-center gap-1 mr-auto min-w-0">
              <button
                v-if="c.State === 'running' && getPreferredPort(c)"
                @click="openContainerUrl(c)"
                class="px-2 py-1 hover:bg-gray-100 text-black rounded transition-colors text-xs flex items-center gap-1"
                title="内网打开"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M15.75 2.25H21a.75.75 0 01.75.75v5.25a.75.75 0 01-1.5 0V4.81L8.03 17.03a.75.75 0 01-1.06-1.06L19.19 3.75h-3.44a.75.75 0 010-1.5zm-10.5 4.5a1.5 1.5 0 00-1.5 1.5v10.5a1.5 1.5 0 001.5 1.5h10.5a1.5 1.5 0 001.5-1.5V10.5a.75.75 0 011.5 0v8.25a3 3 0 01-3 3H5.25a3 3 0 01-3-3V8.25a3 3 0 013-3h8.25a.75.75 0 010 1.5H5.25z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span>内网打开</span>
              </button>
              <button
                v-if="c.State === 'running' && getPreferredPort(c)"
                @click="openContainerPublicUrl(c)"
                class="px-2 py-1 hover:bg-gray-100 text-black rounded transition-colors text-xs flex items-center gap-1"
                title="外网打开"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M3 4.5A1.5 1.5 0 014.5 3h9A1.5 1.5 0 0115 4.5V9a1.5 1.5 0 01-1.5 1.5H9.31l2.44 2.44a.75.75 0 11-1.06 1.06L7.5 10.31V12a1.5 1.5 0 01-1.5 1.5H1.5A1.5 1.5 0 010 12V4.5A1.5 1.5 0 011.5 3H3v1.5z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span>外网打开</span>
              </button>
              <button
                v-if="c.State === 'running'"
                @click="addToHome(c)"
                class="px-2 py-1 hover:bg-gray-100 text-black rounded transition-colors text-xs flex items-center gap-1"
                title="添加到桌面"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M12 2.25c-5.385 0-9.75 4.365-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 9a.75.75 0 00-1.5 0v2.25H9a.75.75 0 000 1.5h2.25V15a.75.75 0 001.5 0v-2.25H15a.75.75 0 000-1.5h-2.25V9z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span>添加卡片</span>
              </button>

              <label
                class="flex items-center gap-1 cursor-pointer hover:bg-gray-100 px-2 py-1 rounded select-none"
                title="勾选后将跳过此容器的自动升级"
              >
                <input
                  type="checkbox"
                  class="rounded text-blue-600 focus:ring-blue-500 w-3 h-3 cursor-pointer"
                  :checked="isAutoUpdateDisabled(c.Id)"
                  @change="
                    (e) => toggleAutoUpdateDisabled(c.Id, (e.target as HTMLInputElement).checked)
                  "
                />
                <span class="text-xs text-black">禁止自动升级</span>
              </label>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button
                v-if="c.State !== 'running'"
                @click="handleAction(c.Id, 'start')"
                class="p-1 hover:bg-green-100 text-green-600 rounded transition-colors"
                title="启动"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>

              <button
                v-if="c.State === 'running'"
                @click="handleAction(c.Id, 'stop')"
                class="p-1 hover:bg-red-100 text-red-600 rounded transition-colors"
                title="停止"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M4.5 7.5a3 3 0 013-3h9a3 3 0 013 3v9a3 3 0 01-3 3h-9a3 3 0 01-3-3v-9z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>

              <button
                @click="handleAction(c.Id, 'restart')"
                class="p-1 hover:bg-blue-100 text-blue-600 rounded transition-colors"
                title="重启"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    fill-rule="evenodd"
                    d="M4.755 10.059a7.5 7.5 0 0112.548-3.364l1.903 1.903h-3.183a.75.75 0 100 1.5h4.992a.75.75 0 00.75-.75V4.356a.75.75 0 00-1.5 0v3.18l-1.9-1.9A9 9 0 003.306 9.67a.75.75 0 101.45.388zm15.408 3.352a.75.75 0 00-.919.53 7.5 7.5 0 01-12.548 3.364l-1.902-1.903h3.183a.75.75 0 000-1.5H2.984a.75.75 0 00-.75.75v4.992a.75.75 0 001.5 0v-3.18l1.9 1.9a9 9 0 0015.059-4.035.75.75 0 00-.53-.919z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #e5e7eb;
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #d1d5db;
}
</style>
