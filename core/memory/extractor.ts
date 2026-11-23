import type { MemoryScope, MemoryType } from '../types';
import type { MemoryCandidate } from './candidates';
import { segmentText } from './selector';

/**
 * 规则式记忆提炼（无网络、零成本）。
 *
 * 只识别用户显式表达长期信息的句式（「记住…」「以后别…」「我喜欢…」），
 * 产出候选进入待确认队列，绝不直接写入记忆库。
 * 采用规则而非模型的原因：可解释（reason 即命中句式）、无额外 API 调用、
 * 也不会把模型幻觉变成长期记忆。
 */
interface PatternRule {
  regex: RegExp;
  reason: string;
  type: MemoryType;
  scope: MemoryScope;
}

const RULES: PatternRule[] = [
  { regex: /(?:请|帮我)?记住[:：,，]?\s*([^\n。！？]{4,120})/, reason: '用户明确要求记住', type: 'user', scope: 'permanent' },
  { regex: /以后(?:都|请|不要|别|要)([^\n。！？]{2,80})/, reason: '用户给出长期行为要求', type: 'feedback', scope: 'permanent' },
  { regex: /我(?:最|比较|更)?(?:喜欢|偏好|习惯|常用|习惯用)([^\n。！？]{2,80})/, reason: '用户表达长期偏好', type: 'user', scope: 'permanent' },
  { regex: /我的(?:名字|职业|公司|项目|目标|背景|技术栈)(?:是|叫)([^\n。！？]{2,80})/, reason: '用户画像信息', type: 'user', scope: 'permanent' },
  { regex: /(?:我们|我)(?:现在|目前)(?:在|正)?(?:做|开发|使用|用)([^\n。！？]{2,80})/, reason: '当前项目/技术上下文', type: 'topic', scope: 'contextual' },
];

const MAX_CANDIDATES_PER_TURN = 3;
const MAX_TAGS = 4;
const MAX_NAME_LENGTH = 24;

export interface ExtractionResult {
  candidates: MemoryCandidate[];
  /** 命中但被判为低可信（疑问句、过短）被丢弃的条数。 */
  rejected: number;
}

export function extractMemoryCandidates(userPrompt: string, now = Date.now()): ExtractionResult {
  const text = userPrompt.trim();
  if (text.length < 4) return { candidates: [], rejected: 0 };

  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const rule of RULES) {
    const match = rule.regex.exec(text);
    if (!match) continue;

    const captured = (match[1] ?? '').trim();
    if (captured.length < 2) { rejected += 1; continue; }
    // 疑问句不是陈述性事实，跳过以免把提问当成偏好。
    if (/[？?]\s*$/.test(captured) || /^(吗|呢|什么|怎么|为什么)/.test(captured)) {
      rejected += 1;
      continue;
    }

    const key = captured.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      id: crypto.randomUUID(),
      type: rule.type,
      scope: rule.scope,
      name: buildName(captured),
      content: captured,
      tags: buildTags(captured),
      reason: rule.reason,
      sourceText: text.slice(0, 200),
      createdAt: now,
      status: 'pending',
    });

    if (candidates.length >= MAX_CANDIDATES_PER_TURN) break;
  }

  return { candidates, rejected };
}

function buildName(content: string): string {
  const cleaned = content.replace(/^[：:,，\s]+/, '').trim();
  return cleaned.length > MAX_NAME_LENGTH ? `${cleaned.slice(0, MAX_NAME_LENGTH)}…` : cleaned;
}

function buildTags(content: string): string[] {
  return [...new Set(segmentText(content))].slice(0, MAX_TAGS);
}
