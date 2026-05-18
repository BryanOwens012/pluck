import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecretsStore,
  EncryptionUnavailableError,
  type Encryptor,
  type SecretName,
} from './secrets';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pluck-secrets-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Reversible XOR-encryptor for tests. Real safeStorage would use the OS
 * keychain; this lets us assert round-trip + treat the ciphertext as
 * opaque bytes without an Electron context. The XOR byte is deliberately
 * non-zero so plaintext doesn't survive in the base64. */
const xorEncryptor = (): Encryptor => {
  const XOR = 0x5a;
  const xor = (buf: Buffer): Buffer => Buffer.from(buf.map((b) => b ^ XOR));
  return {
    isAvailable: () => true,
    encrypt: (plaintext) => xor(Buffer.from(plaintext, 'utf-8')),
    decrypt: (ciphertext) => xor(ciphertext).toString('utf-8'),
  };
};

describe('createSecretsStore', () => {
  it('returns hasKey=false for every name on first run', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    expect(store.hasKey('anthropic')).toBe(false);
    expect(store.hasKey('elevenlabs')).toBe(false);
    expect(await store.getKey('anthropic')).toBeUndefined();
  });

  it('round-trips a saved key through set → get', async () => {
    const a = await createSecretsStore(dir, xorEncryptor());
    await a.setKey('anthropic', 'sk-test-12345');
    expect(a.hasKey('anthropic')).toBe(true);
    expect(await a.getKey('anthropic')).toBe('sk-test-12345');

    // Fresh store from the same dir — proves persistence + decryption
    // round-trip across reloads.
    const b = await createSecretsStore(dir, xorEncryptor());
    expect(b.hasKey('anthropic')).toBe(true);
    expect(await b.getKey('anthropic')).toBe('sk-test-12345');
  });

  it('keeps multiple keys independent', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    await store.setKey('anthropic', 'sk-ant');
    await store.setKey('elevenlabs', 'sk-el');
    expect(await store.getKey('anthropic')).toBe('sk-ant');
    expect(await store.getKey('elevenlabs')).toBe('sk-el');
  });

  it('deleteKey drops one without touching the others', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    await store.setKey('anthropic', 'sk-ant');
    await store.setKey('elevenlabs', 'sk-el');
    await store.deleteKey('anthropic');
    expect(store.hasKey('anthropic')).toBe(false);
    expect(await store.getKey('anthropic')).toBeUndefined();
    expect(await store.getKey('elevenlabs')).toBe('sk-el');
  });

  it('deleteAll wipes every key', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    await store.setKey('anthropic', 'sk-ant');
    await store.setKey('elevenlabs', 'sk-el');
    await store.deleteAll();
    expect(store.hasKey('anthropic')).toBe(false);
    expect(store.hasKey('elevenlabs')).toBe(false);
  });

  it('persists ciphertext on disk, not plaintext', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    await store.setKey('anthropic', 'sk-secret-do-not-log');
    const raw = await fs.readFile(join(dir, 'secrets.json'), 'utf-8');
    // Plaintext must never appear in the file — that's the whole point.
    expect(raw).not.toContain('sk-secret-do-not-log');
    expect(raw).not.toContain('secret');
    // But the structure should be readable JSON.
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.entries.anthropic).toBe('string');
  });

  it('uses an atomic write (sibling .tmp + rename)', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    const renameSpy = vi.spyOn(fs, 'rename');
    await store.setKey('anthropic', 'sk-x');
    expect(renameSpy).toHaveBeenCalledOnce();
    const [from, to] = renameSpy.mock.calls[0] ?? [];
    expect(from).toMatch(/secrets\.json\.tmp$/);
    expect(to).toMatch(/secrets\.json$/);
    renameSpy.mockRestore();
  });

  it('throws EncryptionUnavailableError when the OS keychain is unavailable', async () => {
    const broken: Encryptor = {
      ...xorEncryptor(),
      isAvailable: () => false,
    };
    const store = await createSecretsStore(dir, broken);
    await expect(store.setKey('anthropic', 'sk-x')).rejects.toBeInstanceOf(
      EncryptionUnavailableError,
    );
  });

  it('treats a decrypt failure as "key not set" (FileVault rekey / OS migration)', async () => {
    // Save with one encryptor, load with another that throws on decrypt.
    // Simulates the user's OS keychain identity changing between sessions.
    const writer = await createSecretsStore(dir, xorEncryptor());
    await writer.setKey('anthropic', 'sk-x');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDecryptor: Encryptor = {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: () => {
        throw new Error('decrypt failed');
      },
    };
    const reader = await createSecretsStore(dir, brokenDecryptor);
    // hasKey still true (file says there's a value) — but get returns
    // undefined so callers degrade to "no key" rather than crashing.
    expect(reader.hasKey('anthropic')).toBe(true);
    expect(await reader.getKey('anthropic')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns empty store on corrupt JSON, does not throw', async () => {
    await fs.writeFile(join(dir, 'secrets.json'), '{not valid json', 'utf-8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await createSecretsStore(dir, xorEncryptor());
    expect(store.hasKey('anthropic')).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns empty store on schema mismatch (wrong version / bad entries)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await fs.writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 999, entries: {} }),
      'utf-8',
    );
    expect((await createSecretsStore(dir, xorEncryptor())).hasKey('anthropic')).toBe(false);

    await fs.writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 1, entries: { unknown_provider: 'x' } }),
      'utf-8',
    );
    expect((await createSecretsStore(dir, xorEncryptor())).hasKey('anthropic')).toBe(false);

    errorSpy.mockRestore();
  });

  it('deleteKey on a missing name is a no-op (no disk write)', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    const renameSpy = vi.spyOn(fs, 'rename');
    await store.deleteKey('anthropic' as SecretName);
    expect(renameSpy).not.toHaveBeenCalled();
    renameSpy.mockRestore();
  });

  it('overwriting a key replaces the prior ciphertext', async () => {
    const store = await createSecretsStore(dir, xorEncryptor());
    await store.setKey('anthropic', 'first');
    await store.setKey('anthropic', 'second');
    expect(await store.getKey('anthropic')).toBe('second');
  });
});
