/**
 * Build-time feature flags. Plain consts (not env-driven) — every site
 * that branches on a flag is grep-able and the compiled bundle is the
 * source of truth for what's on / off in a release.
 *
 * Re-enabling a flag is a one-line edit here. To find every gated
 * surface, grep for the flag name across the repo.
 */

/** AI surfaces (transcription, AI prompt UI, the Anthropic +
 * ElevenLabs Settings rows, the API-key Welcome screen). Flipping
 * this to `true` exposes the API keys section in Settings so the
 * user can save their ElevenLabs / Anthropic keys; the per-feature
 * runtime toggles in `Settings.transcriptionEnabled` (and a future
 * `aiPromptEnabled`) decide which features actually surface in the
 * UI. Anthropic / AI prompt is still "coming soon" copy until the
 * tool-use loop + prompt UI ship. */
export const AI_FEATURES_ENABLED = true;
