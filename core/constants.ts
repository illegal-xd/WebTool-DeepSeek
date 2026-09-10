export const DEEPSEEK_API_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

export const MEMORY_TOKEN_BUDGET = 3000;

/**
 * 单条记忆注入上限（占总 Token 预算比例）。超过该比例的单条记忆不参与注入，
 * 避免「一条长文档记忆撑爆整轮预算并挤掉其他记忆」。
 */
export const MEMORY_SINGLE_ENTRY_MAX_RATIO = 0.5;

/**
 * 关键词命中计分上限（tag / name / content）。命中数原先按词频无界累加，
 * 长文本会以数百分的差距霸榜；对齐检索侧 bm25 的「长度归一」思想，改为饱和计分。
 */
export const MEMORY_KEYWORD_MAX_HITS = {
  tag: 6,
  name: 5,
  content: 20,
} as const;

export const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '里', '之', '中', '与', '而', '为',
  '以', '及', '等', '被', '把', '让', '给', '从', '向', '对', '但', '如果', '因为',
  '所以', '虽然', '可以', '能', '想', '知道', '时候', '没', '什么', '怎么', '这个',
  '那个', '还', '过', '吗', '呢', '吧', '啊', '嗯', '哦', '呀', '啦', '使用',
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'she', 'or', 'an', 'will', 'my', 'one', 'all',
  'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who',
  'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'no', 'just',
  'him', 'know', 'take', 'into', 'your', 'some', 'could', 'them', 'than',
  'other', 'been', 'has', 'its', 'use', 'two', 'how', 'our', 'way',
]);

export const TOOL_CALL_REGEX = /<(memory_save|memory_update|memory_delete)>\s*([\s\S]*?)\s*<\/\1>/g;

// Legacy DSML regex (kept for backward compatibility)
export const TOOL_CALLS_BLOCK_REGEX = /<｜DSML｜tool_calls>\s*[\s\S]*?\s*<\/｜DSML｜tool_calls>/g;
export const INVOKE_REGEX = /<｜DSML｜invoke name="([^"]+)">\s*([\s\S]*?)\s*<\/｜DSML｜invoke>/g;
export const PARAMETER_REGEX = /<｜DSML｜parameter name="([^"]+)" string="(true|false)">([\s\S]*?)<\/｜DSML｜parameter>/g;

export const SKILL_TRIGGER_REGEX = /^\/(\S+)\s*([\s\S]*)$/;
