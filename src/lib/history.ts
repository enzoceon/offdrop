import { openDB, type IDBPDatabase } from "idb";

// IndexedDB-backed local history of transfers.
const DB = "offdrop";
const STORE = "items";
let dbPromise: Promise<IDBPDatabase> | null = null;

export interface HistoryItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  receivedAt: number;
  direction?: "sent" | "received";
  durationMs?: number;
  valid?: boolean;
  blob?: Blob;
}

function getDB(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB(DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    },
  });
  return dbPromise;
}

export async function saveItem(item: HistoryItem): Promise<void> {
  const db = await getDB();
  await db.put(STORE, item);
}

export async function listItems(): Promise<HistoryItem[]> {
  const db = await getDB();
  const items = (await db.getAll(STORE)) as HistoryItem[];
  return items.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function deleteItem(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, id);
}
