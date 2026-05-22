/**
 * Tiny visual badge for the source site, rendered next to each download row's
 * extractor label. Deliberately generic — monogram-in-coloured-circle, NOT a
 * reproduction of any site's actual logo or brand mark. The coloured
 * background suggests the site at a glance; the letter inside identifies it
 * without relying on trademarked artwork.
 *
 * `siteKey` is yt-dlp's extractor key (the same string we store in
 * `Download.sourceSite`). Unknown keys get the generic "↗" glyph so the icon
 * is always present and never breaks the row layout.
 */

type SiteGlyph = {
  /** One-letter monogram (or short label) drawn inside the circle. */
  letter: string;
  /** Tailwind classes for the circle background. */
  bgClass: string;
  /** Human-readable label for tooltips. */
  label: string;
};

const GENERIC_GLYPH: SiteGlyph = {
  letter: '↗',
  bgClass: 'bg-neutral-600',
  label: 'External site',
};

const SITE_GLYPHS: Record<string, SiteGlyph> = {
  youtube: { letter: 'Y', bgClass: 'bg-red-600', label: 'YouTube' },
  vimeo: { letter: 'V', bgClass: 'bg-sky-500', label: 'Vimeo' },
  zoom: { letter: 'Z', bgClass: 'bg-blue-600', label: 'Zoom' },
  tiktok: { letter: 'T', bgClass: 'bg-neutral-900', label: 'TikTok' },
  twitter: { letter: 'X', bgClass: 'bg-neutral-900', label: 'X' },
};

/** Resolve a yt-dlp extractor key to one of our known glyphs. Exported so the
 * mapping is testable in isolation. The key match is case-insensitive and
 * trims any suffix yt-dlp appends (e.g. `youtube:tab`, `youtube:playlist`). */
export const resolveSiteGlyph = (siteKey: string | undefined): SiteGlyph => {
  if (!siteKey) {
    return GENERIC_GLYPH;
  }
  const normalized = siteKey.toLowerCase().split(':')[0] ?? '';
  return SITE_GLYPHS[normalized] ?? GENERIC_GLYPH;
};

// Hoisted out of the component so we don't reallocate the template literal on
// every render. Tailwind classes are static.
const ICON_BASE_CLASS =
  'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none text-white';

type Props = {
  /** yt-dlp extractor key, e.g. "youtube" / "vimeo" / "zoom". */
  siteKey: string | undefined;
};

export const SourceSiteIcon = ({ siteKey }: Props): React.JSX.Element => {
  const glyph = resolveSiteGlyph(siteKey);
  return (
    <span
      role="img"
      aria-label={glyph.label}
      title={glyph.label}
      className={`${ICON_BASE_CLASS} ${glyph.bgClass}`}
    >
      {glyph.letter}
    </span>
  );
};
