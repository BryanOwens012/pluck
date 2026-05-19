import type { PlaylistContext, PlaylistEntry } from '../../../shared/types';
import { fetchPlaylistEntries } from '../../ytdlp/runner';
import type { RunnerDeps } from '../../ytdlp/types';

/** Shape of the IPC-facing playlist enumerator — same as the inner
 * `fetchPlaylistEntries` minus the deps + cookies args (closed over
 * at factory time). The IPC handler holds a reference to this. */
export type EnumeratePlaylist = (
  url: string,
) => Promise<{ entries: PlaylistEntry[]; context: PlaylistContext | undefined }>;

/** Bind yt-dlp deps + a live `cookiesFromBrowser` reader to produce a
 * single-arg enumerator. Living in `downloader/playlist/` keeps app
 * boot in `index.ts` from inlining the closure and clarifies that
 * this is the "playlist enumeration" boundary even though the spawn
 * itself lives in `ytdlp/runner.ts`.
 *
 * Cookies are read at call time (not capture time) so a settings
 * change between paste and click takes effect on the next enumerate
 * without rebuilding anything. */
export const createPlaylistEnumerator = (
  runnerDeps: RunnerDeps,
  opts: { getCookiesFromBrowser: () => string | undefined },
): EnumeratePlaylist => {
  return (url) =>
    fetchPlaylistEntries(url, runnerDeps, {
      cookiesFromBrowser: opts.getCookiesFromBrowser(),
    });
};
