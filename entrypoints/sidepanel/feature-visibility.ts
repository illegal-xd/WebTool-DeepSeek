export type FeatureVisibility = {
  conversation: boolean;
  mcp: boolean;
};

export const DEFAULT_FEATURE_VISIBILITY: FeatureVisibility = {
  conversation: true,
  mcp: true,
};

const STORAGE_KEY = 'webtool-sidepanel-feature-visibility';
const EVENT_NAME = 'webtool-sidepanel-feature-visibility-change';

export function getFeatureVisibility(): FeatureVisibility {
  if (typeof window === 'undefined') return { ...DEFAULT_FEATURE_VISIBILITY };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeFeatureVisibility(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_FEATURE_VISIBILITY };
  }
}

export function setFeatureVisibility(next: FeatureVisibility): void {
  const normalized = normalizeFeatureVisibility(next);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent<FeatureVisibility>(EVENT_NAME, { detail: normalized }));
}

export function subscribeFeatureVisibility(listener: (visibility: FeatureVisibility) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<FeatureVisibility>).detail ?? getFeatureVisibility());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

function normalizeFeatureVisibility(raw: unknown): FeatureVisibility {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FEATURE_VISIBILITY };
  const value = raw as Partial<FeatureVisibility>;
  return {
    conversation: value.conversation !== false,
    mcp: value.mcp !== false,
  };
}
