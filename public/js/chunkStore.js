/**
 * CloudDrop - IndexedDB 分块存储
 * 接收大文件时把分块写入 IndexedDB 而非驻留内存，避免手机 OOM。
 * 不支持 IndexedDB 的环境（如隐私模式异常）自动回退到内存数组。
 */

const DB_NAME = 'clouddrop-chunks';
const DB_VERSION = 1;
const STORE = 'chunks';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE); // key: `${fileId}:${paddedIndex}`
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    } catch (e) {
      reject(e);
    }
  });
  return dbPromise;
}

/** 固定宽度索引，保证字符串排序与数字顺序一致 */
function chunkKey(fileId, index) {
  return `${fileId}:${String(index).padStart(10, '0')}`;
}

export const chunkStore = {
  /** 检测 IndexedDB 是否可用 */
  async isAvailable() {
    try {
      await openDb();
      return true;
    } catch (e) {
      console.warn('[ChunkStore] IndexedDB unavailable, falling back to memory:', e.message);
      return false;
    }
  },

  /** 写入一个分块 */
  async putChunk(fileId, index, data) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(data, chunkKey(fileId, index));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('chunk put failed'));
      } catch (e) {
        reject(e);
      }
    });
  },

  /** 按序读取全部已存分块（单事务，range getAll） */
  async getAllChunks(fileId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const range = IDBKeyRange.bound(`${fileId}:`, `${fileId}:\uffff`);
        const req = tx.objectStore(STORE).getAll(range);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error('chunk getAll failed'));
      } catch (e) {
        reject(e);
      }
    });
  },

  /** 删除某文件的全部分块（完成/取消/失败后清理，fire-and-forget 安全） */
  async deleteFile(fileId) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const range = IDBKeyRange.bound(`${fileId}:`, `${fileId}:\uffff`);
          tx.objectStore(STORE).delete(range);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve(); // 清理失败不影响主流程
        } catch (e) {
          resolve();
        }
      });
    } catch (e) {
      // 忽略：数据库不可用
    }
  },

  /** 启动时清空整个分块库（上次会话中断的残留，防配额被反复中断吃满） */
  async pruneAll() {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    } catch (e) {
      // 忽略：数据库不可用
    }
  }
};
