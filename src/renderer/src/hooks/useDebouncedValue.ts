import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after `delayMs` of stability.
 * Rapid changes to `value` reset the timer; the returned value only flips
 * when the input has held still for the full delay (trailing-edge debounce).
 *
 * Use this in preference to a setTimeout-in-useEffect ad hoc whenever the
 * caller's downstream is shaped as "react to a debounced value", which most
 * debounced UI work is (URL field → fetch, search box → query, slider →
 * commit, etc.). The hook stays trivial — useEffect's own cleanup lifecycle
 * is already a debounce mechanism — so we deliberately don't pull in
 * `lodash.debounce` or similar.
 *
 * Type parameter `T` is pass-through; equality uses React's default
 * Object.is, so primitive strings / numbers / booleans flip exactly when
 * their content changes. For object values pass a stable reference (or
 * memoize beforehand) to avoid spurious resets.
 */
export const useDebouncedValue = <T>(value: T, delayMs: number): T => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return (): void => {
      clearTimeout(handle);
    };
  }, [value, delayMs]);

  return debounced;
};
