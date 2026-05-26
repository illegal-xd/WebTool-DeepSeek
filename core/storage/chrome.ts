export async function getLocalValue<T>(
  key: string,
  fallback: T,
  normalize?: (raw: unknown) => T,
): Promise<T> {
  try {
    const data = await chrome.storage.local.get(key) as Record<string, unknown>;
    const raw = data[key];
    if (raw === undefined) return fallback;
    return normalize ? normalize(raw) : raw as T;
  } catch {
    return fallback;
  }
}

export async function setLocalValue(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocalValue(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

export async function getSessionValue<T>(
  key: string,
  fallback: T,
  normalize?: (raw: unknown) => T,
): Promise<T> {
  try {
    const data = await chrome.storage.session.get(key) as Record<string, unknown>;
    const raw = data[key];
    if (raw === undefined) return fallback;
    return normalize ? normalize(raw) : raw as T;
  } catch {
    return fallback;
  }
}

export async function setSessionValue(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}
