import assert from 'node:assert/strict';
import test from 'node:test';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 10);

async function loadCleanup() {
  try {
    return await import('../core/tool/cache.ts');
  } catch (error) {
    assert.fail(`工具缓存清理 API 必须存在: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createStorage(initial) {
  const data = structuredClone(initial);
  return {
    data,
    async get() {
      return structuredClone(data);
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

test('删除 dpp_tool_exec_ 键中超过 15 天的记录并保留其他数据', async () => {
  const { clearExpiredToolExecutionCache } = await loadCleanup();
  const storage = createStorage({
    dpp_tool_exec_chat1: [
      { id: 'expired', timestamp: NOW - 16 * DAY_MS },
      { id: 'boundary', timestamp: NOW - 15 * DAY_MS },
      { id: 'recent', timestamp: NOW - DAY_MS },
      { id: 'future', timestamp: NOW + DAY_MS },
      { id: 'missing' },
      { id: 'invalid', timestamp: 'not-a-number' },
    ],
    unrelated: [{ id: 'old', timestamp: NOW - 100 * DAY_MS }],
  });

  const result = await clearExpiredToolExecutionCache(storage, NOW);

  assert.deepEqual(result, { deletedRecords: 1, removedKeys: 0 });
  assert.deepEqual(storage.data.dpp_tool_exec_chat1.map((record) => record.id), [
    'boundary',
    'recent',
    'future',
    'missing',
    'invalid',
  ]);
  assert.equal(storage.data.unrelated.length, 1);
});

test('清理后没有记录的目标键会被移除，非数组目标值保持不变', async () => {
  const { clearExpiredToolExecutionCache } = await loadCleanup();
  const storage = createStorage({
    dpp_tool_exec_empty: [{ timestamp: NOW - 16 * DAY_MS }],
    dpp_tool_exec_malformed: { timestamp: NOW - 20 * DAY_MS },
  });

  const result = await clearExpiredToolExecutionCache(storage, NOW);

  assert.deepEqual(result, { deletedRecords: 1, removedKeys: 1 });
  assert.equal('dpp_tool_exec_empty' in storage.data, false);
  assert.deepEqual(storage.data.dpp_tool_exec_malformed, { timestamp: NOW - 20 * DAY_MS });
});
