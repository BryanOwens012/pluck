import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage, generateDownloadId } from './ipc';
import { YtDlpError, YtDlpPasswordRequiredError } from './ytdlp/types';

describe('generateDownloadId', () => {
  it('matches the documented dl-<time>-<rand> shape', () => {
    expect(generateDownloadId()).toMatch(/^dl-\d+-[a-z0-9]+$/);
  });

  it('produces distinct ids across rapid successive calls', () => {
    // 64 in a tight loop; collision via the random suffix would still be
    // extremely unlikely with a 6-char base-36 tail, but verify nothing's
    // worse than chance.
    const ids = new Set(Array.from({ length: 64 }, () => generateDownloadId()));
    expect(ids.size).toBe(64);
  });
});

describe('friendlyErrorMessage', () => {
  it('maps YtDlpPasswordRequiredError to a password prompt hint', () => {
    expect(friendlyErrorMessage(new YtDlpPasswordRequiredError('zoom auth required'))).toBe(
      'This recording requires a password.',
    );
  });

  it('maps generic YtDlpError to a safe generic message (no stderr leak)', () => {
    const stderr = 'ERROR: /Users/me/secret/path/foo.mp4: Permission denied';
    const message = friendlyErrorMessage(new YtDlpError('boom', stderr));
    expect(message).toBe('Download failed. The site may be unsupported or the URL may be invalid.');
    // Guard against accidental stderr leak via the user-facing message.
    expect(message).not.toContain('Permission');
    expect(message).not.toContain('/Users/');
  });

  it('preserves the message for unknown Error instances', () => {
    expect(friendlyErrorMessage(new Error('disk full'))).toBe('disk full');
  });

  it('falls back to a generic message for non-Error throws', () => {
    expect(friendlyErrorMessage('a string was thrown')).toBe('Download failed.');
    expect(friendlyErrorMessage(null)).toBe('Download failed.');
    expect(friendlyErrorMessage(undefined)).toBe('Download failed.');
    expect(friendlyErrorMessage(42)).toBe('Download failed.');
    expect(friendlyErrorMessage({ message: 'plain object' })).toBe('Download failed.');
  });

  it('preserves error type hierarchy: PasswordRequired wins over generic YtDlpError', () => {
    const err = new YtDlpPasswordRequiredError();
    // Sanity: the password-required error extends YtDlpError, so instanceof
    // order in friendlyErrorMessage matters. Verify the more specific
    // branch fires first.
    expect(err).toBeInstanceOf(YtDlpError);
    expect(friendlyErrorMessage(err)).toBe('This recording requires a password.');
  });
});
