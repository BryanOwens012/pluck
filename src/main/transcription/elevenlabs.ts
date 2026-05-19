import { createReadStream } from 'node:fs';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

/** ElevenLabs Speech-to-Text model. `scribe_v2` is the current
 * top-tier accuracy model; `scribe_v1` is the older / cheaper
 * option. We default to v2 for transcription quality. */
const STT_MODEL_ID = 'scribe_v2';

/** Send an audio file to ElevenLabs' speech-to-text endpoint and
 * return the SRT content as a string. ElevenLabs has built-in SRT
 * formatting via `additionalFormats: [{ format: 'srt', ... }]` —
 * cleaner than fetching word timestamps and formatting client-side.
 *
 * Note on `additionalFormats`: even when requested, the SDK still
 * returns the full transcript (text + words) in the primary
 * response. The SRT lives in `additionalFormats[0].content` (we
 * find by `requestedFormat === 'srt'`). If for any reason the
 * provider doesn't return SRT (model change, server-side flag),
 * the caller falls back to formatting from the word timestamps —
 * but in practice scribe_v2 + srt is reliable.
 *
 * Throws with the underlying SDK error message on auth / network /
 * rate-limit failures so the orchestrator can route it to the
 * row's transcriptionStatus.error state. */
export const transcribeToSrt = async (apiKey: string, audioPath: string): Promise<string> => {
  const client = new ElevenLabsClient({ apiKey });
  // The SDK accepts a Readable stream as the file. createReadStream
  // streams the bytes off disk rather than buffering the whole file
  // into memory — important for hour-long audio clips.
  const fileStream = createReadStream(audioPath);
  const response = await client.speechToText.convert({
    modelId: STT_MODEL_ID,
    file: fileStream,
    timestampsGranularity: 'word',
    additionalFormats: [
      {
        format: 'srt',
        // ElevenLabs' SRT formatter defaults are reasonable; we
        // pin a max-segment-duration cap so cues don't run on
        // unreasonably long during long pauseless stretches. 7s
        // is the upper bound recommended for caption readability.
        maxSegmentDurationS: 7,
      },
    ],
  });

  if ('additionalFormats' in response && Array.isArray(response.additionalFormats)) {
    const srtEntry = response.additionalFormats.find(
      (f) => f !== undefined && f.requestedFormat === 'srt',
    );
    if (srtEntry && typeof srtEntry.content === 'string' && srtEntry.content.length > 0) {
      // ElevenLabs returns SRT as plain UTF-8 text; the
      // `isBase64Encoded` flag is false for srt/txt/html formats.
      // Trust the flag rather than always-decoding; defense in
      // depth — if base64 we decode it.
      return srtEntry.isBase64Encoded
        ? Buffer.from(srtEntry.content, 'base64').toString('utf-8')
        : srtEntry.content;
    }
  }

  throw new Error('ElevenLabs returned a response without SRT content');
};
