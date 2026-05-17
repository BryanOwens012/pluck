import type { PluckAPI } from './index';

declare global {
  interface Window {
    pluck: PluckAPI;
  }
}
