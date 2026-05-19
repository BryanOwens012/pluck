/**
 * Build-time feature flags. Plain consts (not env-driven) — every site
 * that branches on a flag is grep-able and the compiled bundle is the
 * source of truth for what's on / off in a release.
 *
 * Re-enabling a flag is a one-line edit here. To find every gated
 * surface, grep for the flag name across the repo.
 */

/** AI surfaces (transcription, AI prompt UI, the Anthropic +
 * ElevenLabs Settings rows, the API-key Welcome screen). Off until
 * the AI tool-use loop and the prompt UI ship — keeps the binary
 * shippable as a video downloader without paid-API onboarding noise. */
export const AI_FEATURES_ENABLED = false;
