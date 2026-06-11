import assert from 'node:assert/strict';
import { getVisibleTabsForFeatureVisibility } from '../entrypoints/sidepanel/App.tsx';

assert.deepEqual(
  getVisibleTabsForFeatureVisibility({ conversation: true, mcp: true }).map((tab) => tab.key),
  ['memory', 'skill', 'preset', 'mcp', 'conversation', 'settings'],
);

assert.deepEqual(
  getVisibleTabsForFeatureVisibility({ conversation: false, mcp: true }).map((tab) => tab.key),
  ['memory', 'skill', 'preset', 'mcp', 'settings'],
);

assert.deepEqual(
  getVisibleTabsForFeatureVisibility({ conversation: true, mcp: false }).map((tab) => tab.key),
  ['memory', 'skill', 'preset', 'conversation', 'settings'],
);

console.log('ok - sidepanel memory tab remains visible independently of custom memory mode');
