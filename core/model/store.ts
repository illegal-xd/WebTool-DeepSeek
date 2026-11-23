/**
 * @Deprecated 2026-11-20 Expert 模式已停用。
 *
 * DeepSeek 官方已优化模型侧提示词，插件侧再覆盖 `model_type` 只会造成
 * 与页面选择不一致。本模块保留以便回退，但 `getModelType()` 恒返回 null，
 * 因此注入链路不再写入 `model_type`。确认无需回退后可连同
 * `ModelType` 类型与 `SET_MODEL_TYPE` 消息一并删除。
 */
import type { ModelType } from '../types';

const STORAGE_KEY = 'deepseek_pp_model_type';

export async function getModelType(): Promise<ModelType> {
  // Expert 模式已停用：不再从存储读取，历史值一律视为未设置。
  return null;
}

export async function setModelType(modelType: ModelType): Promise<void> {
  if (modelType === null) {
    await chrome.storage.local.remove(STORAGE_KEY);
  } else {
    await chrome.storage.local.set({ [STORAGE_KEY]: modelType });
  }
}
