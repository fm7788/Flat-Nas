import { openDB, type IDBPDatabase } from 'idb';
import { ref, type Ref } from 'vue';

const DB_NAME = 'flatnas-memo-db';
const STORE_NAME = 'memos';
const HISTORY_STORE = 'memo_versions';
const DB_VERSION = 2;

interface MemoData {
  id: string | number;
  content: string; // The rich text HTML
  simple?: string; // Plain text
  mode: 'simple' | 'rich';
  updatedAt: number;
  checksum: string;
}

export interface MemoVersion {
  id: string;
  widgetId: string | number;
  content: string;
  mode: 'simple' | 'rich';
  updatedAt: number;
  checksum: string;
}

// Simple checksum (DJB2)
function generateChecksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Mock Sentry
const reportError = (error: unknown, context: string) => {
  console.error(`[Sentry Report] ${context}:`, error);
  const sentry = (window as {
    Sentry?: {
      captureException: (err: unknown, options?: { tags?: Record<string, string> }) => void;
    };
  }).Sentry;
  if (sentry) sentry.captureException(error, { tags: { context } });
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
          store.createIndex('by-widget', 'widgetId');
        }
      },
    });
  }
  return dbPromise;
}

const lastVersionChecksum = new Map<string | number, string>();

export function useMemoPersistence(
  widgetId: string | number,
  localData: Ref<string>,
  mode: Ref<'simple' | 'rich'>
) {
  const status = ref<'idle' | 'saving' | 'success' | 'error'>('idle');
  const progress = ref(0);

  const saveToIndexedDB = async (retryCount = 0) => {
    status.value = 'saving';
    progress.value = 30;

    try {
      const db = await getDB();
      const content = localData.value;
      const checksum = generateChecksum(content);

      const data: MemoData = {
        id: widgetId,
        content,
        mode: mode.value,
        updatedAt: Date.now(),
        checksum
      };

      progress.value = 60;
      await db.put(STORE_NAME, data);

      // Verify
      const saved = await db.get(STORE_NAME, widgetId);
      if (!saved || saved.checksum !== checksum) {
        throw new Error('Checksum validation failed');
      }
      lastVersionChecksum.set(widgetId, checksum);

      progress.value = 100;
      status.value = 'success';

      // Reset status after animation
      setTimeout(() => {
        status.value = 'idle';
        progress.value = 0;
      }, 1200);

    } catch (e) {
      console.error(`Save failed (attempt ${retryCount + 1})`, e);
      if (retryCount < 3) {
        setTimeout(() => saveToIndexedDB(retryCount + 1), 500 * (retryCount + 1));
      } else {
        status.value = 'error';
        reportError(e, 'MemoPersistenceSave');
      }
    }
  };

  const loadFromIndexedDB = async () => {
    try {
      const db = await getDB();
      const data = await db.get(STORE_NAME, widgetId);
      if (data) {
        // Validate checksum
        const currentChecksum = generateChecksum(data.content);
        if (currentChecksum === data.checksum) {
          localData.value = data.content;
          mode.value = data.mode;
          lastVersionChecksum.set(widgetId, data.checksum);
        } else {
          reportError(new Error('Data corruption detected on load'), 'MemoPersistenceLoad');
        }
      } else {
        // Fallback migration: import legacy LocalStorage cache if present
        const legacyKey = `flatnas-memo-backup-${widgetId}`;
        const legacyValue = localStorage.getItem(legacyKey);
        if (legacyValue && legacyValue.length > 0) {
          // Heuristic: if contains HTML tags, treat as rich
          const importMode: 'simple' | 'rich' = /<[^>]+>/.test(legacyValue) ? 'rich' : 'simple';
          localData.value = legacyValue;
          mode.value = importMode;
          // Persist into IndexedDB immediately
          const checksum = generateChecksum(legacyValue);
          const imported: MemoData = {
            id: widgetId,
            content: legacyValue,
            mode: importMode,
            updatedAt: Date.now(),
            checksum,
          };
          await db.put(STORE_NAME, imported);
          lastVersionChecksum.set(widgetId, checksum);
          // Clean up legacy key to avoid confusion
          try { localStorage.removeItem(legacyKey); } catch {}
        }
      }
    } catch (e) {
      reportError(e, 'MemoPersistenceLoad');
    }
  };

  const saveVersionSnapshot = async (force = false) => {
    try {
      const db = await getDB();
      const content = localData.value;
      const checksum = generateChecksum(content);
      const lastChecksum = lastVersionChecksum.get(widgetId);
      if (!force && checksum === lastChecksum) return;
      const updatedAt = Date.now();
      const data: MemoVersion = {
        id: `${widgetId}-${updatedAt}-${Math.random().toString(36).slice(2, 8)}`,
        widgetId,
        content,
        mode: mode.value,
        updatedAt,
        checksum
      };
      await db.put(HISTORY_STORE, data);
      lastVersionChecksum.set(widgetId, checksum);
    } catch (e) {
      reportError(e, 'MemoPersistenceSnapshot');
    }
  };

  const loadVersions = async () => {
    try {
      const db = await getDB();
      const items = await db.getAllFromIndex(HISTORY_STORE, 'by-widget', widgetId);
      return (items as MemoVersion[]).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      reportError(e, 'MemoPersistenceHistoryLoad');
      return [];
    }
  };

  const deleteVersion = async (versionId: string) => {
    try {
      const db = await getDB();
      await db.delete(HISTORY_STORE, versionId);
    } catch (e) {
      reportError(e, 'MemoPersistenceHistoryDelete');
    }
  };

  return {
    saveToIndexedDB,
    loadFromIndexedDB,
    saveVersionSnapshot,
    loadVersions,
    deleteVersion,
    status,
    progress
  };
}
