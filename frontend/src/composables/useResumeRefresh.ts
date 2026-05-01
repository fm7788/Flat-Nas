import { onMounted, onUnmounted } from "vue";

type UseResumeRefreshOptions = {
  onVisible?: () => void;
  onHidden?: () => void;
  onOnline?: () => void;
  enabled?: () => boolean;
};

export function useResumeRefresh(options: UseResumeRefreshOptions) {
  const canRun = () => (options.enabled ? options.enabled() : true);

  const handleVisibilityChange = () => {
    if (!canRun()) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      options.onHidden?.();
      return;
    }
    options.onVisible?.();
  };

  const handleOnline = () => {
    if (!canRun()) return;
    options.onOnline?.();
  };

  onMounted(() => {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
    }
  });

  onUnmounted(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleOnline);
    }
  });
}
