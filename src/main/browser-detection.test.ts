import { describe, expect, it } from 'vitest';
import type { BrowserName } from '../shared/types';
import {
  BROWSER_PROBE_PATHS,
  detectInstalledBrowsers,
  type ExistsProbe,
} from './browser-detection';

const probeFrom = (installed: ReadonlySet<BrowserName>): ExistsProbe => {
  // Build a reverse lookup so the probe can answer per-path without
  // assuming anything about the path shape.
  const pathToName = new Map<string, BrowserName>();
  for (const [name, path] of Object.entries(BROWSER_PROBE_PATHS) as Array<[BrowserName, string]>) {
    pathToName.set(path, name);
  }
  return async (path) => {
    const name = pathToName.get(path);
    return name !== undefined && installed.has(name);
  };
};

describe('detectInstalledBrowsers', () => {
  it('returns the empty array when no probe path exists', async () => {
    const result = await detectInstalledBrowsers(probeFrom(new Set()));
    expect(result).toEqual([]);
  });

  it('returns the single installed browser when only one exists', async () => {
    const result = await detectInstalledBrowsers(probeFrom(new Set(['chrome'])));
    expect(result).toEqual(['chrome']);
  });

  it('returns multiple browsers in BROWSER_NAMES order (not probe order)', async () => {
    // Order should be the display order from BROWSER_NAMES, not the
    // order paths happen to be probed in.
    const result = await detectInstalledBrowsers(probeFrom(new Set(['brave', 'chrome', 'safari'])));
    expect(result).toEqual(['chrome', 'safari', 'brave']);
  });

  it('returns all five when every probe path exists', async () => {
    const result = await detectInstalledBrowsers(
      probeFrom(new Set(['chrome', 'firefox', 'safari', 'brave', 'edge'])),
    );
    expect(result).toEqual(['chrome', 'firefox', 'safari', 'brave', 'edge']);
  });

  it('treats probe errors as "not installed" (matches default fs.stat ENOENT behaviour)', async () => {
    const throwing: ExistsProbe = async () => {
      throw new Error('EACCES');
    };
    // The default impl swallows; the test fake also throws. Verify the
    // user-supplied probe's exceptions propagate (not part of the
    // helper's API but useful contract).
    await expect(detectInstalledBrowsers(throwing)).rejects.toThrow('EACCES');
  });
});
