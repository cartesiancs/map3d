export type Theme = 'light' | 'dark';
export function readPreference<T extends string>(key:string, values:readonly T[], fallback:T):T {
  try {
    const value=localStorage.getItem(key);
    return values.includes(value as T) ? value as T : fallback;
  } catch { return fallback; }
}
export function savePreference(key:string,value:string) {
  try { localStorage.setItem(key,value); } catch { /* Preferences still work when storage is unavailable. */ }
}
