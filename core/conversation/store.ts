import type { ConversationCategory } from '../types';

const CATEGORY_KEY = 'deepseek_pp_conversation_categories';

export async function getConversationCategories(): Promise<ConversationCategory[]> {
  const data = await chrome.storage.local.get(CATEGORY_KEY) as Record<string, unknown>;
  const stored = data[CATEGORY_KEY];
  return Array.isArray(stored) ? (stored as ConversationCategory[]) : [];
}

export async function saveConversationCategory(category: ConversationCategory): Promise<void> {
  const categories = await getConversationCategories();
  const idx = categories.findIndex((item) => item.id === category.id);
  if (idx >= 0) {
    categories[idx] = category;
  } else {
    categories.push(category);
  }
  await chrome.storage.local.set({ [CATEGORY_KEY]: categories });
}

export async function deleteConversationCategory(id: string): Promise<void> {
  const categories = await getConversationCategories();
  await chrome.storage.local.set({ [CATEGORY_KEY]: categories.filter((item) => item.id !== id) });
}

export async function assignSessionsToCategory(categoryId: string, sessionIds: string[]): Promise<void> {
  const ids = new Set(sessionIds);
  const categories = await getConversationCategories();
  const next = categories.map((category) => {
    if (category.id !== categoryId) return category;
    const merged = new Set(category.sessionIds);
    for (const id of ids) merged.add(id);
    return { ...category, sessionIds: Array.from(merged) };
  });
  await chrome.storage.local.set({ [CATEGORY_KEY]: next });
}

export async function unassignSessionsFromCategory(categoryId: string, sessionIds: string[]): Promise<void> {
  const ids = new Set(sessionIds);
  const categories = await getConversationCategories();
  const next = categories.map((category) => (
    category.id === categoryId
      ? { ...category, sessionIds: category.sessionIds.filter((id) => !ids.has(id)) }
      : category
  ));
  await chrome.storage.local.set({ [CATEGORY_KEY]: next });
}

export function attachCategoryIds<T extends { id: string }>(
  sessions: T[],
  categories: ConversationCategory[],
): Array<T & { categoryIds: string[] }> {
  return sessions.map((session) => ({
    ...session,
    categoryIds: categories
      .filter((category) => category.sessionIds.includes(session.id))
      .map((category) => category.id),
  }));
}
