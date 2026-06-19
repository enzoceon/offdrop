// IndexedDB-backed local history of received transfers.
const DB = "offdrop";
const STORE = "items";
let dbPromise: Promise<IDBDatabase> | null = null;

export interface HistoryItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  receivedAt: number;
  blob: Blob;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function saveItem(item: HistoryItem): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listItems(): Promise<HistoryItem[]> {
  const db = await openDB();
  const items = await new Promise<HistoryItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as HistoryItem[]);
    req.onerror = () => reject(req.error);
  });
  return items.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function deleteItem(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
