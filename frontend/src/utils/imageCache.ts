
// Utility for caching images in IndexedDB
const DB_NAME = 'FlatNasImageCache';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const MAX_CACHE_AGE = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;

interface CachedImage {
  url: string;
  blob: Blob;
  timestamp: number;
  etag?: string;
}

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
  });
};

const pruneCache = async (): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const entries: Array<{ url: string; timestamp: number }> = [];
  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const value = cursor.value as CachedImage;
      entries.push({
        url: value.url,
        timestamp: typeof value.timestamp === 'number' ? value.timestamp : 0,
      });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const now = Date.now();
  const toDelete = new Set<string>();
  for (const entry of entries) {
    if (now - entry.timestamp > MAX_CACHE_AGE) toDelete.add(entry.url);
  }
  const remaining = entries.filter((e) => !toDelete.has(e.url));
  if (remaining.length > MAX_CACHE_ENTRIES) {
    remaining.sort((a, b) => b.timestamp - a.timestamp);
    for (const entry of remaining.slice(MAX_CACHE_ENTRIES)) {
      toDelete.add(entry.url);
    }
  }
  for (const url of toDelete) {
    store.delete(url);
    localStorage.removeItem(`cache_meta_${url}`);
  }
};

export const cacheImage = async (url: string, blob: Blob, etag?: string): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  
  await new Promise<void>((resolve, reject) => {
    const request = store.put({
      url,
      blob,
      timestamp: Date.now(),
      etag
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  
  // Also store key in localStorage for quick lookup/expiration check
  localStorage.setItem(`cache_meta_${url}`, JSON.stringify({
    timestamp: Date.now(),
    etag
  }));
  await pruneCache();
};

export const getCachedImage = async (url: string): Promise<Blob | null> => {
  // Check localStorage first for expiration (24h)
  const metaStr = localStorage.getItem(`cache_meta_${url}`);
  if (metaStr) {
    const meta = JSON.parse(metaStr);
    const now = Date.now();
    if (now - meta.timestamp > MAX_CACHE_AGE) {
      // Expired
      localStorage.removeItem(`cache_meta_${url}`);
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(url);
      } catch {
        return null;
      }
      return null;
    }
  } else {
    // No meta, assuming no cache or cleared
    return null;
  }

  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get(url);
    request.onsuccess = () => {
      const result = request.result as CachedImage;
      resolve(result ? result.blob : null);
    };
    request.onerror = () => reject(request.error);
  });
};
