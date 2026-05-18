import { useEffect, useRef } from 'react';
import type { DebugLogEvent } from '../../../shared/types';

type Props = {
  /** Lines to render, oldest-first. App caps at MAX_LOG_LINES per id
   * before passing the slice down. */
  lines: readonly DebugLogEvent[];
};

/** Fixed-height monospace log viewer with sticky-scroll. Stays pinned
 * to the bottom as new lines arrive UNLESS the user has scrolled up
 * (in which case auto-scroll pauses, so they can read older lines
 * without being yanked back). Scrolling back to the bottom resumes.
 *
 * Per-download log buffer + line cap live in App.tsx — this component
 * is pure presentation. */
export const LogBox = ({ lines }: Props): React.JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks whether the viewport is at (or very near) the bottom. A
  // ref, not state — we only need it for the next render's decision,
  // and avoiding re-renders on scroll is important for big buffers.
  const stickToBottomRef = useRef(true);

  // Re-pin to bottom on each new line iff we were already pinned.
  // useLayoutEffect would feel snappier but useEffect avoids the
  // double-flush; the small delay is invisible. `lines` is the
  // re-run trigger even though the body only reads refs — biome's
  // useExhaustiveDependencies would prefer it dropped, but then the
  // effect would only run once and the auto-scroll would never fire.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines drives the re-scroll trigger
  useEffect(() => {
    if (stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    // 8px slack so the "near bottom" decision survives a Retina /
    // sub-pixel rounding nudge. Bigger threshold would fire too
    // eagerly when the user scrolls up by a couple lines.
    const NEAR_BOTTOM_PX = 8;
    stickToBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="mt-3 h-48 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] leading-relaxed text-neutral-400"
    >
      {lines.map((line, idx) => (
        // Lines aren't independently identifiable (timestamp + phase
        // + message could repeat for throttled progress ticks), so
        // use index. Buffer is append-only + bounded, so the
        // index-as-key risk (reorder mis-renders) is moot. Empty
        // state isn't handled here — DownloadRow only mounts LogBox
        // when there's at least one line.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only bounded buffer
        <div key={idx} className={LINE_CLASS[line.phase] ?? 'text-neutral-400'}>
          <span className="text-neutral-600">[{line.phase}]</span> {line.message}
        </div>
      ))}
    </div>
  );
};

// Phase → text color. Errors red, lifecycle events neutral, yt-dlp
// chatter a touch dimmer so the structured phases pop visually.
const LINE_CLASS: Partial<Record<DebugLogEvent['phase'], string>> = {
  error: 'text-red-400',
  ytdlp: 'text-neutral-500',
  'download:progress': 'text-neutral-500',
};
