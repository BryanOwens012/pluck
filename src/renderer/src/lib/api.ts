/**
 * Re-exports the contextBridge-exposed API from a single import location, so
 * components don't reach for `window.pluck` directly. Keeps tests / Storybook
 * easier to mock later by giving us one surface to swap.
 */
export const api = window.pluck;
