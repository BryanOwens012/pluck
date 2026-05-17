/**
 * Shared types. Must contain ONLY type declarations — no runtime imports of
 * electron, node, or DOM APIs. Both the main and renderer processes import
 * from here.
 */

export type Format = 'best' | '1080p' | '720p' | 'audio_mp3';

export type DownloadRequest = {
  url: string;
  format: Format;
  /** Optional. If omitted, main process falls back to its configured default
   * (~/Downloads/Pluck until PR 6 introduces the settings-driven path). */
  outputFolder?: string;
  videoPassword?: string;
};

export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'transcribing';

export type Download = {
  id: string;
  url: string;
  title?: string;
  sourceSite?: string;
  durationSec?: number;
  /** Remote https URL for a preview thumbnail, populated after the metadata
   * pre-pass. Renderer loads it directly; CSP permits `img-src https:`. */
  thumbnailUrl?: string;
  format: Format;
  outputFolder: string;
  filePath?: string;
  status: DownloadStatus;
  /** 0–100 */
  progress: number;
  speed?: string;
  eta?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  /** Path to .srt if transcribed. */
  transcriptPath?: string;
};

export type TranscriptionStatus =
  | { state: 'idle' }
  | { state: 'extracting_audio' }
  | { state: 'uploading' }
  | { state: 'transcribing'; progress?: number }
  | { state: 'writing_srt' }
  | { state: 'done'; srtPath: string }
  | { state: 'error'; message: string };

export type AIToolCall = {
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type AIResponse = {
  /** Claude's final natural-language reply. */
  text: string;
  /** What Claude did, for UI display. */
  toolCalls: AIToolCall[];
};
