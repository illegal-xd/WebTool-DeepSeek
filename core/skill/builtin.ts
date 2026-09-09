import { MEMORY_UPDATE_SCHEMA, MEMORY_DELETE_SCHEMA } from '../templates';
import {
  SKILL_MEMORY_INSTRUCTIONS,
  SKILL_ULTRA_THINK_INSTRUCTIONS,
  SKILL_FRONTEND_DESIGN_INSTRUCTIONS,
  SKILL_DOC_COAUTHORING_INSTRUCTIONS,
  SKILL_BRAND_GUIDELINES_INSTRUCTIONS,
  SKILL_SKILL_CREATOR_INSTRUCTIONS,
  SKILL_ALGORITHMIC_ART_INSTRUCTIONS,
  SKILL_CANVAS_DESIGN_INSTRUCTIONS,
  SKILL_PPTX_DESIGN_INSTRUCTIONS,
} from '../templates/skills';
import type { Skill } from '../types';

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'memory',
    description: '记忆管理：/memory save <内容> | /memory list | /memory update | /memory delete',
    instructions: fillSkillSchemas(SKILL_MEMORY_INSTRUCTIONS),
    source: 'builtin',
    memoryEnabled: true,
  },
  {
    name: 'ultra-think',
    description: '极致深度思考模式。强制 AI 以最大推理力度分析问题，全面分解根因，严格压力测试所有路径、边界情况和对抗场景。',
    instructions: SKILL_ULTRA_THINK_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
  },
  {
    name: 'frontend-design',
    description: '创建有设计感的前端界面，避免 AI 生成的千篇一律风格。适用于需要构建网页、组件或应用界面的场景。',
    instructions: SKILL_FRONTEND_DESIGN_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'doc-coauthoring',
    description: '协作式文档创作，使用三阶段方法论（采集、创作、审查）产出高质量文档。适用于写文章、报告、方案等需要深思熟虑的写作任务。',
    instructions: SKILL_DOC_COAUTHORING_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'brand-guidelines',
    description: '品牌视觉规范设计与应用。帮助定义配色系统、字体搭配、设计变量，并输出可直接使用的 CSS 变量或 Tailwind 配置。',
    instructions: SKILL_BRAND_GUIDELINES_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'skill-creator',
    description: '创建和优化 AI Skill。通过需求访谈、指令编写、测试验证三步流程，帮助用户设计高质量的 Skill 定义。',
    instructions: SKILL_SKILL_CREATOR_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'algorithmic-art',
    description: '使用 p5.js 创作算法驱动的生成艺术。适用于需要创作数据可视化、动态图形、交互式视觉作品的场景。',
    instructions: SKILL_ALGORITHMIC_ART_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'canvas-design',
    description: '创作博物馆级、杂志级品质的视觉设计。强调设计哲学先行，每个决策都有意识。适用于需要高品质视觉输出的场景。',
    instructions: SKILL_CANVAS_DESIGN_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
  {
    name: 'pptx-design',
    description: '演示文稿设计专家。提供专业配色方案、排版规则和布局建议，帮助创建有视觉冲击力的演示内容。',
    instructions: SKILL_PPTX_DESIGN_INSTRUCTIONS,
    source: 'builtin',
    memoryEnabled: false,
    metadata: { author: 'anthropic', version: '1.0.0' },
  },
];

/** 将 skill 指令模板中的工具 schema 占位符填充为实际 JSON 字符串。 */
function fillSkillSchemas(instructions: string): string {
  return instructions
    .replace('{{memoryUpdateSchema}}', MEMORY_UPDATE_SCHEMA)
    .replace('{{memoryDeleteSchema}}', MEMORY_DELETE_SCHEMA);
}
