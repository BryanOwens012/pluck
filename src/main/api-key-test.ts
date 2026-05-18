import Anthropic from '@anthropic-ai/sdk';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { SecretName } from './secrets';

export type TestResult = { ok: true } | { ok: false; error: string };

/** Anthropic key test: list models. Lightweight, doesn't consume tokens.
 * `client.models.list()` returns a page; we ignore the result and only
 * care about whether the call rejects. */
const testAnthropic = async (key: string): Promise<TestResult> => {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyApiError(err, 'Anthropic') };
  }
};

/** ElevenLabs key test: fetch the authenticated user. The /v1/user
 * endpoint exists specifically for this kind of validation and doesn't
 * eat any voice-quota. */
const testElevenLabs = async (key: string): Promise<TestResult> => {
  try {
    const client = new ElevenLabsClient({ apiKey: key });
    await client.user.get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyApiError(err, 'ElevenLabs') };
  }
};

/** Test a key against the provider's cheapest validation endpoint. The
 * key is never persisted by this function — the renderer calls saveKey
 * separately after the user clicks Save. */
export const testApiKey = (name: SecretName, key: string): Promise<TestResult> => {
  switch (name) {
    case 'anthropic':
      return testAnthropic(key);
    case 'elevenlabs':
      return testElevenLabs(key);
  }
};

/** Sanitise SDK error messages for renderer display. Both SDKs include
 * HTTP status + body on auth failures; the body can contain machine-
 * readable detail we don't want to leak verbatim. Strip to the gist. */
const friendlyApiError = (err: unknown, provider: string): string => {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api')) {
      return `${provider} rejected this key.`;
    }
    if (msg.includes('429')) {
      return `${provider} rate-limited the test. Try again in a minute.`;
    }
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
      return 'Network error. Check your connection.';
    }
  }
  return `Couldn't verify the ${provider} key.`;
};
