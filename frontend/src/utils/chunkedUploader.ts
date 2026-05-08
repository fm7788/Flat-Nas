type UploadSessionState = {
  fileKey: string;
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: Set<number>;
  createdAt: number;
};

type UploadCallbacks = {
  onProgress?: (bytesUploaded: number, totalBytes: number, uploadedChunks: number, totalChunks: number) => void;
  onComplete?: (result: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  onPause?: (reason: string) => void;
  onResume?: () => void;
};

type GetHeadersFn = () => Record<string, string>;

const STORAGE_KEY_PREFIX = "flatnas-upload-session:";
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CHUNK_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const isNetworkError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError && /network|fetch|load|failed/i.test(error.message)) return true;
  return false;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const serializeSession = (state: UploadSessionState): string => {
  return JSON.stringify({
    ...state,
    uploadedChunks: Array.from(state.uploadedChunks),
  });
};

const deserializeSession = (raw: string): UploadSessionState | null => {
  try {
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.createdAt > SESSION_TTL_MS) return null;
    return {
      ...parsed,
      uploadedChunks: new Set<number>(Array.isArray(parsed.uploadedChunks) ? parsed.uploadedChunks : []),
    };
  } catch {
    return null;
  }
};

const persistSession = (state: UploadSessionState) => {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + state.fileKey, serializeSession(state));
  } catch {
    // Storage full or unavailable, ignore
  }
};

const loadSession = (fileKey: string): UploadSessionState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + fileKey);
    return raw ? deserializeSession(raw) : null;
  } catch {
    return null;
  }
};

const removeSession = (fileKey: string) => {
  try {
    localStorage.removeItem(STORAGE_KEY_PREFIX + fileKey);
  } catch {
    // Ignore
  }
};

export class ChunkedUploader {
  private state: UploadSessionState | null = null;
  private callbacks: UploadCallbacks;
  private getHeaders: GetHeadersFn;
  private controller: AbortController | null = null;
  private isPaused = false;
  private isActive = false;
  private currentFile: File | null = null;

  constructor(getHeaders: GetHeadersFn, callbacks: UploadCallbacks = {}) {
    this.getHeaders = getHeaders;
    this.callbacks = callbacks;
  }

  async start(file: File, existingSessionKey?: string): Promise<void> {
    this.currentFile = file;
    const fileKey = existingSessionKey || this.generateFileKey(file);

    const existing = loadSession(fileKey);
    if (existing && existing.uploadId) {
      const recovered = await this.tryResumeSession(existing);
      if (recovered) return;
    }

    await this.initNewUpload(file, fileKey);
  }

  async pause(reason = "user_action"): Promise<void> {
    this.isPaused = true;
    this.controller?.abort();
    this.callbacks.onPause?.(reason);
  }

  async resume(): Promise<void> {
    if (!this.state) return;
    this.isPaused = false;
    this.callbacks.onResume?.();
    await this.uploadRemainingChunks();
  }

  async cancel(): Promise<void> {
    this.isPaused = true;
    this.controller?.abort();
    this.isActive = false;

    if (this.state?.uploadId) {
      try {
        await fetch("/api/transfer/upload/cancel", {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({ uploadId: this.state.uploadId }),
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    if (this.state) {
      removeSession(this.state.fileKey);
      this.state = null;
    }
  }

  getState(): UploadSessionState | null {
    return this.state;
  }

  isUploading(): boolean {
    return this.isActive && !this.isPaused;
  }

  private generateFileKey(file: File): string {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  private async initNewUpload(file: File, fileKey: string): Promise<void> {
    const headers = this.getHeaders();
    const initRes = await fetch("/api/transfer/upload/init", {
      method: "POST",
      headers,
      body: JSON.stringify({
        fileName: file.name,
        size: file.size,
        mime: file.type || "",
        fileKey,
        chunkSize: CHUNK_SIZE,
      }),
    });

    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.success) {
      throw new Error(initData.error || `HTTP ${initRes.status}`);
    }

    this.state = {
      fileKey,
      uploadId: String(initData.uploadId || ""),
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || "",
      chunkSize: Number(initData.chunkSize || CHUNK_SIZE),
      totalChunks: Number(initData.totalChunks || 0),
      uploadedChunks: new Set(),
      createdAt: Date.now(),
    };

    persistSession(this.state);
    await this.uploadRemainingChunks(file);
  }

  private async tryResumeSession(existing: UploadSessionState): Promise<boolean> {
    try {
      const statusRes = await fetch(
        `/api/transfer/upload/status?uploadId=${encodeURIComponent(existing.uploadId)}`,
        { headers: this.getHeaders() },
      );

      if (!statusRes.ok) {
        removeSession(existing.fileKey);
        return false;
      }

      const statusData = await statusRes.json().catch(() => ({}));
      if (!statusData.success) {
        removeSession(existing.fileKey);
        return false;
      }

      const serverUploaded = new Set<number>(
        Array.isArray(statusData.uploaded) ? statusData.uploaded.map((n: unknown) => Number(n)) : [],
      );

      this.state = {
        ...existing,
        totalChunks: Number(statusData.totalChunks || existing.totalChunks),
        chunkSize: Number(statusData.chunkSize || existing.chunkSize),
        uploadedChunks: serverUploaded,
      };

      persistSession(this.state);

      const doneBytes = this.getUploadedBytes();
      this.callbacks.onProgress?.(doneBytes, this.state.fileSize, serverUploaded.size, this.state.totalChunks);

      await this.uploadRemainingChunks();
      return true;
    } catch (e) {
      if (isNetworkError(e)) {
        this.callbacks.onPause?.("network_unavailable");
        return false;
      }
      removeSession(existing.fileKey);
      return false;
    }
  }

  private async uploadRemainingChunks(file?: File): Promise<void> {
    const actualFile = file ?? this.currentFile;
    if (!this.state || !actualFile) return;

    this.isActive = true;
    this.isPaused = false;
    this.controller = new AbortController();

    const { uploadId, totalChunks, chunkSize, fileSize, uploadedChunks } = this.state;

    for (let i = 0; i < totalChunks; i++) {
      if (uploadedChunks.has(i)) continue;
      if (this.isPaused || !this.isActive) return;

      const start = i * chunkSize;
      const end = Math.min(fileSize, start + chunkSize);
      const blob = actualFile.slice(start, end);

      let attempt = 0;
      let success = false;

      while (attempt < MAX_CHUNK_RETRIES && !this.isPaused) {
        attempt++;
        try {
          const form = new FormData();
          form.append("uploadId", uploadId);
          form.append("index", String(i));
          form.append("chunk", blob, `${this.state.fileName}.part`);

          const chunkHeaders = this.getHeaders();
          delete chunkHeaders["Content-Type"];

          const r = await fetch("/api/transfer/upload/chunk", {
            method: "POST",
            headers: chunkHeaders,
            body: form,
            signal: this.controller.signal,
          });

          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);

          uploadedChunks.add(i);
          persistSession(this.state);

          const doneBytes = this.getUploadedBytes();
          this.callbacks.onProgress?.(doneBytes, fileSize, uploadedChunks.size, totalChunks);

          success = true;
          break;
        } catch (e: unknown) {
          if (this.controller?.signal.aborted || this.isPaused) return;

          if (isNetworkError(e)) {
            if (attempt < MAX_CHUNK_RETRIES) {
              const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
              await wait(delay);
              continue;
            }
            this.isPaused = true;
            this.callbacks.onPause?.("network_error");
            return;
          }

          if (attempt >= MAX_CHUNK_RETRIES) {
            this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          await wait(RETRY_BASE_DELAY_MS * attempt);
        }
      }

      if (!success) return;
    }

    if (!this.isPaused && this.isActive) {
      await this.completeUpload();
    }
  }

  private async completeUpload(): Promise<void> {
    if (!this.state) return;

    try {
      const completeRes = await fetch("/api/transfer/upload/complete", {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ uploadId: this.state.uploadId }),
      });

      const completeData = await completeRes.json().catch(() => ({}));
      if (!completeRes.ok || !completeData.success) {
        throw new Error(completeData.error || `HTTP ${completeRes.status}`);
      }

      removeSession(this.state.fileKey);
      this.isActive = false;
      this.state = null;
      this.callbacks.onComplete?.(completeData);
    } catch (e) {
      this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private getUploadedBytes(): number {
    if (!this.state) return 0;
    return Math.min(this.state.fileSize, this.state.uploadedChunks.size * this.state.chunkSize);
  }
}
