/** Add a default `https://` scheme to a user-typed URL when it looks
 * like a bare hostname. Lets the user paste `youtube.com/watch?v=X`
 * (or `youtu.be/abc`, `vimeo.com/12345`, etc.) without having to type
 * the scheme themselves.
 *
 * Behavior:
 *
 *   - Already-schemed input (`https://...`, `http://...`,
 *     `javascript:...`, `file://...`) is returned unchanged. The
 *     downstream `isHttpUrl` guard still filters non-http schemes.
 *   - Scheme-less input is prepended with `https://` ONLY when the
 *     result parses as a URL whose hostname contains a dot. This
 *     rules out `localhost`, single-word junk, etc. — we don't want
 *     to convert `not a url` into `https://not a url` and then have
 *     yt-dlp try to fetch it.
 *   - Leading / trailing whitespace is trimmed. An empty input
 *     returns an empty string.
 *
 * Pure function — safe to import from both processes. */
export const normalizeUrl = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  // Any scheme present? Let downstream filters decide whether it's
  // an acceptable one. RFC 3986 allows `.` in scheme names, but no
  // widely-used scheme uses it (`http`, `https`, `file`, `data`,
  // `mailto`, `git+ssh`, `chrome-extension`, ...). Excluding `.`
  // here means `example.com:8080/x` is treated as a scheme-less
  // host:port URL rather than scheme `example.com`.
  if (/^[a-z][a-z0-9+-]*:/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(`https://${trimmed}`);
    // A real domain has at least one dot in the hostname
    // (`youtube.com`, `youtu.be`). `localhost` and bare words don't
    // qualify — those would parse but aren't what the user meant.
    if (parsed.hostname.includes('.')) {
      return `https://${trimmed}`;
    }
  } catch {
    // Falls through to the unchanged return below.
  }
  return trimmed;
};
