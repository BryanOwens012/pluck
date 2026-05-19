import { spawn } from 'node:child_process';

/**
 * Extract the audio track from a video file into a standalone MP3.
 * ElevenLabs accepts video uploads directly but they're 10-30x larger
 * than the audio alone — for a 1-hour 1080p video that's a ~1.5 GB
 * upload vs. ~50 MB for audio. The extraction step keeps the upload
 * portion of the transcription pipeline fast on residential
 * connections.
 *
 * Uses the bundled ffmpeg (same binary the downloader's --ffmpeg-
 * location flag points at). MP3 over Opus/Vorbis because every
 * STT API and major audio player handles it without quirks. CBR
 * 128 kbps is a quality/size sweet spot for speech.
 *
 * Resolves with the output path on success; rejects with the
 * stderr tail on non-zero exit so the caller can surface a useful
 * error string to the renderer.
 */
export const extractAudioToMp3 = (
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-y', // overwrite if exists (caller controls the temp path)
      '-i',
      inputPath,
      '-vn', // drop the video track
      '-acodec',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ar',
      '44100', // 44.1 kHz sample rate
      '-ac',
      '2', // stereo (1 = mono — slight bandwidth savings but
      //     some STT models pick up cues from stereo separation)
      outputPath,
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      // ffmpeg writes progress / version info to stderr even on
      // success. Capture for error diagnostics but don't log; the
      // caller controls verbosity.
      stderr.push(chunk.toString());
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // Truncate to a reasonable tail so the error message isn't
      // multi-page. ffmpeg's last few lines are usually the useful
      // ones (the actual failure reason).
      const tail = stderr.join('').split('\n').slice(-10).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
    });
  });
};
