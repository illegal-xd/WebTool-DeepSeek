import Dexie, { type EntityTable } from 'dexie';
import type { Memory, NewMemory } from '../types';
import { normalizeMemoryScope } from '../weighting';

const db = new Dexie('DeepSeekPP') as Dexie & {
  memories: EntityTable<Memory, 'id'>;
};

db.version(1).stores({
  memories: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt',
});

db.version(2)
  .stores({
    memories: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId',
  })
  .upgrade((tx) => {
    return tx
      .table('memories')
      .toCollection()
      .modify((memory: Record<string, unknown>) => {
        memory.syncId = crypto.randomUUID();
      });
  });

db.version(3)
  .stores({
    memories: '++id, type, scope, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId, expiresAt',
  })
  .upgrade((tx) => {
    return tx
      .table('memories')
      .toCollection()
      .modify((memory: Partial<Memory>) => {
        memory.scope = normalizeMemoryScope(memory as Memory);
      });
  });

// v4：软删除新增 archivedAt 索引。保留声明，保证已安装 v4 的旧库沿版本链正常升级。
db.version(4).stores({
  memories: '++id, type, scope, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId, expiresAt, archivedAt',
});

// v5：移除已废弃的 expiresAt 索引（字段已从 Memory 类型删除，仅清理历史索引残留）。
db.version(5).stores({
  memories: '++id, type, scope, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId, archivedAt',
});

function normalizeMemory(memory: Memory): Memory {
  return {
    ...memory,
    scope: normalizeMemoryScope(memory),
  };
}

/**
 * 读取记忆。默认只返回未归档条目；includeArchived=true 时连归档（软删除）一起返回，
 * 用于导出备份与 WebDAV 合并（避免归档条目在合并时被远端旧副本复活）。
 */
export async function getAllMemories(includeArchived = false): Promise<Memory[]> {
  const memories = await db.memories.toArray();
  return memories
    .filter((memory) => includeArchived || !memory.archivedAt)
    .map(normalizeMemory);
}

export async function getMemoryById(id: number): Promise<Memory | undefined> {
  const memory = await db.memories.get(id);
  return memory ? normalizeMemory(memory) : undefined;
}

export async function saveMemory(
  mem: NewMemory,
): Promise<number> {
  const now = Date.now();
  const { syncId: memSyncId, ...rest } = mem;
  const entry: Omit<Memory, 'id'> = {
    ...rest,
    syncId: memSyncId ?? crypto.randomUUID(),
    scope: normalizeMemoryScope(mem as Memory),
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
  };
  return db.memories.add(entry) as Promise<number>;
}

export async function updateMemory(mem: Memory): Promise<void> {
  if (mem.id == null) return;
  await db.memories.update(mem.id, { ...mem, scope: normalizeMemoryScope(mem), updatedAt: Date.now() });
}

export async function deleteMemory(id: number): Promise<void> {
  await db.memories.delete(id);
}

/** 恢复归档记忆（清除软删除标记）。 */
export async function restoreMemory(id: number): Promise<void> {
  const now = Date.now();
  await db.memories
    .where('id')
    .equals(id)
    .modify((memory) => {
      delete memory.archivedAt;
      memory.updatedAt = now;
    });
}

export async function touchMemories(ids: number[]): Promise<void> {
  const now = Date.now();
  await db.memories
    .where('id')
    .anyOf(ids)
    .modify((m) => {
      m.accessCount++;
      m.lastAccessedAt = now;
    });
}

export async function replaceAllMemories(memories: Omit<Memory, 'id'>[]): Promise<void> {
  await db.transaction('rw', db.memories, async () => {
    await db.memories.clear();
    await db.memories.bulkAdd(memories as Memory[]);
  });
}

const STALE_THRESHOLD_DAYS = 90;
const MIN_ACCESS_FOR_RETENTION = 3;

/**
 * 归档长期未命中且访问次数低的旧记忆 —— 软删除：
 * 只写 archivedAt 标记（不参与注入与列表），数据保留在库、导出与 WebDAV 同步中，可恢复。
 * 同步刷新 updatedAt，避免合并时被远端旧副本覆盖回未归档状态。
 */
export async function archiveStaleMemories(): Promise<number> {
  const threshold = Date.now() - STALE_THRESHOLD_DAYS * 86_400_000;
  const stale = await db.memories
    .where('lastAccessedAt')
    .below(threshold)
    .filter((m) => !m.pinned && !m.archivedAt && m.accessCount < MIN_ACCESS_FOR_RETENTION)
    .toArray();

  if (stale.length === 0) return 0;

  const ids = stale.map((m) => m.id!).filter(Boolean);
  const now = Date.now();
  await db.memories.where('id').anyOf(ids).modify({ archivedAt: now, updatedAt: now });
  return ids.length;
}

export { db };
