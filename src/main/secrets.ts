import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomic-json';

/** Schema version. Bump on any breaking change to the on-disk shape so we
 * can migrate or discard cleanly. Currently v1 — initial schema. */
const SCHEMA_VERSION = 1;

const SECRETS_FILENAME = 'secrets.json';

/** Supported secret names. New providers append here + add a tested IPC
 * branch; the store doesn't care what the names mean. */
export const SECRET_NAMES = ['anthropic', 'elevenlabs'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Thin contract over the Electron safeStorage API. Injected so the store
 * can be unit-tested without booting an Electron app context (where
 * `safeStorage.isEncryptionAvailable()` requires `app.whenReady()`). */
export type Encryptor = {
  isAvailable(): boolean;
  /** Plaintext in → opaque buffer out (Keychain-wrapped on macOS). */
  encrypt(plaintext: string): Promise<Buffer> | Buffer;
  decrypt(ciphertext: Buffer): Promise<string> | string;
};

/** On-disk shape. `entries` keys are SecretName; values are base64-encoded
 * ciphertext buffers (JSON-safe). Storing as base64 avoids the binary-
 * Buffer-in-JSON shenanigans Node's default JSON serializer produces. */
type SecretsFile = {
  version: number;
  entries: Partial<Record<SecretName, string>>;
};

export type SecretsStore = {
  /** True iff the store has a saved value for `name`. Renderer uses this
   * to decide which features to enable; never call from a hot path
   * since each call may touch disk on cold starts. */
  hasKey(name: SecretName): boolean;
  /** Decrypted plaintext for `name`, or undefined if not set. NEVER
   * surface plaintext to the renderer — this is for main-process use
   * (e.g. constructing an SDK client). */
  getKey(name: SecretName): Promise<string | undefined>;
  /** Encrypt + persist. Throws if encryption is unavailable. */
  setKey(name: SecretName, value: string): Promise<void>;
  /** Drop a single key; the file is rewritten without it. */
  deleteKey(name: SecretName): Promise<void>;
  /** Drop everything — used by the Welcome / Settings "delete keys" flow. */
  deleteAll(): Promise<void>;
};

/** Returned when the user's machine has no usable crypto (rare on
 * macOS — happens on a fresh Keychain that hasn't been unlocked, or on
 * Linux without libsecret). Surfaced to the renderer so the Welcome
 * screen can fail closed instead of saving plaintext. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('OS keychain encryption is unavailable. Restart and try again.');
    this.name = 'EncryptionUnavailableError';
  }
}

/** File-backed secrets store. `dir` is typically `app.getPath('userData')`.
 * Loads at construction so `hasKey` is synchronous afterward; the cached
 * ciphertext is rewritten atomically on every set/delete. */
export const createSecretsStore = async (
  dir: string,
  encryptor: Encryptor,
): Promise<SecretsStore> => {
  const filePath = join(dir, SECRETS_FILENAME);

  // entries map holds base64 ciphertext per name. Plaintext is never
  // cached — every getKey() round-trips through decrypt() so a stolen
  // memory dump only reveals encrypted bytes.
  let entries: Partial<Record<SecretName, string>> = {};

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isSecretsFile(parsed)) {
      entries = parsed.entries;
    } else {
      console.error('secrets: schema mismatch, starting clean');
    }
  } catch (err) {
    // ENOENT is the first-run case — silent. Anything else logs and
    // degrades to empty so the app boots; the user can re-enter keys.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('secrets: failed to read, starting clean', err);
    }
  }

  const writeAtomic = async (): Promise<void> => {
    const body: SecretsFile = { version: SCHEMA_VERSION, entries };
    await atomicWriteJson(filePath, body);
  };

  const hasKey = (name: SecretName): boolean => entries[name] !== undefined;

  const getKey = async (name: SecretName): Promise<string | undefined> => {
    const b64 = entries[name];
    if (b64 === undefined) {
      return undefined;
    }
    try {
      return await encryptor.decrypt(Buffer.from(b64, 'base64'));
    } catch (err) {
      // Decrypt failures usually mean the OS keychain identity changed
      // (FileVault rekey, OS reinstall, user account migration). Treat
      // as "no key" rather than crashing — the user can re-enter.
      console.error(`secrets: decrypt failed for ${name}, treating as unset`, err);
      return undefined;
    }
  };

  const setKey = async (name: SecretName, value: string): Promise<void> => {
    if (!encryptor.isAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const ciphertext = await encryptor.encrypt(value);
    entries = { ...entries, [name]: ciphertext.toString('base64') };
    await writeAtomic();
  };

  const deleteKey = async (name: SecretName): Promise<void> => {
    if (entries[name] === undefined) {
      return;
    }
    const next = { ...entries };
    delete next[name];
    entries = next;
    await writeAtomic();
  };

  const deleteAll = async (): Promise<void> => {
    entries = {};
    await writeAtomic();
  };

  return { hasKey, getKey, setKey, deleteKey, deleteAll };
};

const isSecretsFile = (value: unknown): value is SecretsFile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== SCHEMA_VERSION) {
    return false;
  }
  if (typeof obj.entries !== 'object' || obj.entries === null) {
    return false;
  }
  // Every value (if present) must be a base64 string. Reject silently
  // rather than throwing — caller logs the mismatch.
  for (const [name, val] of Object.entries(obj.entries)) {
    if (!SECRET_NAMES.includes(name as SecretName)) {
      return false;
    }
    if (typeof val !== 'string') {
      return false;
    }
  }
  return true;
};
