import { useEffect, useState } from "react";

export function usePreference<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      return valid(stored) ? stored : fallback;
    } catch { return fallback; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
  }, [key, value]);
  return [value, setValue] as const;
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");