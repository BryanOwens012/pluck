import { promises as fs } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { TranscriptionStatus } from '../../shared/types';
import { extractAudioToMp3 } from './audio-extractor';
import { transcribeToSrt } from './elevenlabs';

/** Pipeline for turning a completed download into a .srt sitting
 * next to the video file:
 *
 *   1. Extract audio to MP3 (ffmpeg) — 10-30x smaller upload than
 *      the original video.
 *   2. POST the audio to ElevenLabs speech-to-text with
 *      `additionalFormats: [srt]` — the SDK returns the SRT
 *      content directly so no client-side formatting is needed.
 *   3. Write the SRT to `<video stem>.srt` next to the source
 *      video. Resolve with that path.
 *
 * Each step emits a TranscriptionStatus via the `onStatus`
 * callback so the renderer can show a progress badge. Errors at
 * any step propagate as `{state: 'error', message}` plus a thrown
 * Error — the caller decides whether to surface the throw or just
 * rely on the status callback. Both paths land on the same `error`
 * state in the Download row.
 *
 * The audio temp file is cleaned up in `finally` regardless of
 * outcome (success / failure). */
export type TranscribeDeps = {
  /** Path to the bundled ffmpeg binary — same one the downloader
   * uses for the audio-extraction step. */
  ffmpegPath: string;
  /** Per-run scratch directory. We write the extracted audio
   * here, then delete it after the SRT lands on disk. Caller
   * picks the location so tests can point at `os.tmpdir()`. */
  tempBaseDir: string;
};

export const transcribeDownload = async (
  apiKey: string,
  videoPath: string,
  onStatus: (status: TranscriptionStatus) => void,
  deps: TranscribeDeps,
): Promise<string> => {
  const audioPath = join(deps.tempBaseDir, `transcribe-${Date.now()}.mp3`);
  try {
    onStatus({ state: 'extracting_audio' });
    await extractAudioToMp3(deps.ffmpegPath, videoPath, audioPath);

    onStatus({ state: 'uploading' });
    // The SDK call combines upload + transcribe into one HTTP
    // request. We emit 'transcribing' right before because most
    // of the wall-clock time after upload is the model running.
    // Doing both emits is cosmetic — the UI mostly sees
    // 'transcribing' since the upload portion is brief.
    onStatus({ state: 'transcribing' });
    const srtContent = await transcribeToSrt(apiKey, audioPath);

    onStatus({ state: 'writing_srt' });
    // SRT lands next to the video, sharing the same stem.
    // `<video stem>.srt`. Path collisions (existing .srt) are
    // overwritten — re-transcribing should replace the old one,
    // not silently fail.
    const srtPath = computeSrtPath(videoPath);
    await fs.writeFile(srtPath, srtContent, 'utf-8');

    onStatus({ state: 'done', srtPath });
    return srtPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed.';
    onStatus({ state: 'error', message });
    throw err;
  } finally {
    // Best-effort cleanup of the temp audio. Failure to delete
    // (file already gone, permission glitch) is swallowed — the
    // transcript already landed (or didn't); the temp scrap
    // matters less.
    await fs.rm(audioPath, { force: true }).catch(() => {
      // Intentionally swallowed.
    });
  }
};

/** Compute the `.srt` path that sits next to a video file. Same
 * directory, same stem, `.srt` extension. Exported for testing. */
export const computeSrtPath = (videoPath: string): string => {
  const dir = dirname(videoPath);
  const ext = extname(videoPath);
  const base = ext.length > 0 ? videoPath.slice(0, -ext.length) : videoPath;
  const stem = base.split('/').pop() ?? 'transcript';
  return join(dir, `${stem}.srt`);
};
