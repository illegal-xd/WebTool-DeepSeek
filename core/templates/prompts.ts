/**
 * 提示词模板 — 单一事实源
 *
 * 所有注入 DeepSeek 的提示词文本集中在本文件，便于手动维护与调整。
 * 分区：
 *   - 系统模板：SYSTEM_TEMPLATE_CHAT / SYSTEM_TEMPLATE_THINKING
 *   - 工具 schema：MEMORY_*_SCHEMA（历史 JSON 字符串）
 *   - 注入片段：用户输入包装 / 记忆背景 / 工具说明 / 格式提醒
 */

// ─── 系统模板（记忆注入主模板） ────────────────────────────────────

/**
 * 系统模板（普通模式）。
 * 设计原则：中性化角色声明，不做能力限制；记忆与工具作为「附加上下文」；
 * 明确保持原生能力（联网搜索/推理）不变。
 */
export const SYSTEM_TEMPLATE_CHAT = `{{memoryContext}}

### 可用工具

本环境支持以下辅助工具（可调用也可不调用，不影响正常回答）：

<memory_save>{"type": "user", "name": "标题", "content": "要保存的内容", "tags": ["标签1", "标签2"]}</memory_save>

工具调用格式：工具名 + JSON 载荷（可选）：

{{tools}}

## 使用说明

- 你的其他能力（联网搜索、实时信息获取、推理）保持正常，用户的问题请优先按你本来的方式处理。
- 未注入「已知信息」不代表记忆库为空；当用户要求查看、检索或引用历史记忆，且存在记忆查询或列表工具时，应主动调用对应工具确认。
- 若用户明确要求"记住"或对话中有值得长期保留的信息，可在回复任意位置调用 memory_save 工具保存，不影响回答本身。
- 若「已知信息」中出现与某项预设高度相关的记忆，请结合该预设的指令与记忆内容一同回答。

`;

export const SYSTEM_TEMPLATE_THINKING = `{{memoryContext}}

### 可用工具

本环境支持以下辅助工具（可调用也可不调用，不影响正常回答）：

<memory_save>{"type": "user", "name": "标题", "content": "要保存的内容", "tags": ["标签1", "标签2"]}</memory_save>

工具调用格式：工具名 + JSON 载荷（可选）：

{{tools}}

## 使用说明

- 你的其他能力（联网搜索、实时信息获取、推理）保持正常，用户的问题请优先按你本来的方式处理。
- 未注入「已知信息」不代表记忆库为空；当用户要求查看、检索或引用历史记忆，且存在记忆查询或列表工具时，应主动调用对应工具确认。
- 若用户明确要求"记住"或对话中有值得长期保留的信息，可在回复任意位置调用 memory_save 工具保存。
- 若「已知信息」中出现与某项预设高度相关的记忆，请结合该预设的指令与记忆内容一同回答。

`;

// ─── 工具 schema（历史 JSON 字符串，供 builtin skill 与兼容使用） ──

// @Iteration: [v0.6] 私有常量无任何引用，迁出 constants.ts 集中管理；改为
// 推荐使用 MEMORY_TOOL_DESCRIPTORS（core/tool/memory.ts）结构化定义。
export const MEMORY_SAVE_SCHEMA = '{"type": "function", "function": {"name": "memory_save", "description": "保存一条新的长期记忆", "parameters": {"type": "object", "properties": {"type": {"type": "string", "enum": ["user", "feedback", "topic", "reference"], "description": "记忆类型：user=身份角色偏好, feedback=行为纠正, topic=讨论要点, reference=外部资源链接"}, "name": {"type": "string", "description": "简短标题"}, "content": {"type": "string", "description": "要保存的内容"}, "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"}}, "required": ["type", "name", "content", "tags"]}}}';

export const MEMORY_UPDATE_SCHEMA = '{"type": "function", "function": {"name": "memory_update", "description": "更新已有记忆", "parameters": {"type": "object", "properties": {"id": {"type": "integer", "description": "记忆ID"}, "type": {"type": "string", "enum": ["user", "feedback", "topic", "reference"], "description": "记忆类型"}, "name": {"type": "string", "description": "更新后的标题"}, "content": {"type": "string", "description": "更新后的内容"}, "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"}}, "required": ["id", "type", "name", "content", "tags"]}}}';

export const MEMORY_DELETE_SCHEMA = '{"type": "function", "function": {"name": "memory_delete", "description": "删除记忆", "parameters": {"type": "object", "properties": {"id": {"type": "integer", "description": "记忆ID"}}, "required": ["id"]}}}';

// ─── 注入片段：用户输入包装 ────────────────────────────────────────

/** 用户输入前缀（已弃用重述包装；用户输入原样输出。保留导出以兼容覆盖白名单） */
export const USER_INPUT_PREFIX = '';

/** 记忆背景包装（用于 #记忆名 手动注入路径）格式模板 */
export const MEMORY_BACKGROUND_TEMPLATE = '背景信息（记忆：{{memoryName}}）：\n{{memoryContent}}';

// ─── 注入片段：工具说明（共享文本，供系统模板与自定义工具说明复用） ──

export const TOOLS_SECTION_HEADING = '## 工具';

export const TOOL_INTRO_LINE =
  '你拥有以下工具，可用于帮助回答用户的问题。可以使用 XML 块调用工具，格式为：工具名 + JSON 载荷：';

export const TOOL_EXAMPLE_LINE =
  '<memory_save>{"type": "user", "name": "标题", "content": "要保存的内容", "tags": ["标签1", "标签2"]}</memory_save>';

export const TOOL_SCHEMAS_HEADING = '### 可用工具 Schema';

export const TOOL_MUST_FOLLOW_LINE =
  '你必须严格按照上述工具名与参数 Schema 的定义来调用工具。';

// ─── 注入片段：工具 schema 渲染与格式提醒 ──────────────────────────

/**
 * 单个工具 schema 块模板。占位符：{{invocationName}}/{{title}}/{{description}}/
 * {{examplePayload}}/{{inputSchema}}（跨平台安全，避免与 payload 内 ${} 冲突）。
 */
export const TOOL_SCHEMA_TEMPLATE = `### 工具 {{invocationName}}
标题：{{title}}
描述：{{description}}
{{invocationName}} 的合法调用格式：
<{{invocationName}}>
{{examplePayload}}
</{{invocationName}}>
非法格式：<invoke name="{{invocationName}}">...</invoke>、<tool_call>...</tool_call>
参数 Schema：{{inputSchema}}`;

/**
 * 工具调用格式提醒（注入末尾的轻量 reminder）。占位符：{{names}}。
 */
export const TOOL_FORMAT_REMINDER_TEMPLATE = `

---
工具调用格式提醒：
可用的工具标签名：{{names}}
调用工具时，请仅使用工具名对应的直接 XML 标签，JSON 作为标签正文。
不要使用 <invoke name="...">、<tool_call>、Markdown 代码块或其他包裹格式。`;

// ─── 注入片段：指令块分隔符 ────────────────────────────────────────

export const INSTRUCTION_SEPARATOR = '\n\n---\n\n';

// ─── 自动续聊：工具结果回传 ────────────────────────────────────────

export interface ContinuationToolResult {
  name: string;
  ok: boolean;
  summary: string;
  detail?: string;
}

/**
 * 构造自动续聊提示词：把本轮工具执行结果以结构化 JSON 回传给模型，
 * 指示其基于结果继续工作。原始任务已在 DeepSeek 对话链中，无需重复。
 */
export function buildAutoContinuationPrompt(
  results: ContinuationToolResult[],
  toolNames: string[] = [],
): string {
  const compact = results.map((r) => ({
    tool: r.name,
    ok: r.ok,
    summary: r.summary,
    ...(r.detail ? { detail: r.detail.slice(0, 2000) } : {}),
  }));
  const lines = [
    '<tool_results>',
    JSON.stringify(compact, null, 2),
    '</tool_results>',
    '以上工具调用已执行完成。请根据执行结果继续完成任务：如需调用更多工具请继续输出对应的工具标签；若任务已完成，请直接向用户总结结果。',
  ];
  if (toolNames.length > 0) {
    lines.push(`\n可用工具标签名：${toolNames.join('、')}`);
    lines.push('调用工具时，请仅使用工具名对应的直接 XML 标签，JSON 作为标签正文。不要使用 <invoke name="...">、Markdown 代码块或其他包裹格式。');
  }
  return lines.join('\n');
}
