/**
 * Build-time feature flags. Plain consts (not env-driven) — every site
 * that branches on a flag is grep-able and the compiled bundle is the
 * source of truth for what's on / off in a release.
 *
 * Re-enabling a flag is a one-line edit here. To find every gated
 * surface, grep for the flag name across the repo.
 *
 * **Both AI provider flags default to `false`** so the shippable alpha
 * binary doesn't surface any paid-API onboarding noise. Flip on a
 * per-provider basis when the corresponding feature is ready to ship.
 */

/** Enables the ElevenLabs API-key row in Settings and the user-facing
 * `Settings.transcriptionEnabled` toggle that gates the per-row
 * Transcribe button. With this off, transcription is invisible to
 * the user even if they had a key saved from a previous build. */
export const ELEVENLABS_ENABLED = false;

/** Enables the Anthropic API-key row in Settings. The AI-prompt UI
 * the key powers is still "coming soon" — the row exists today only
 * so a user with the flag on can save their key ahead of the
 * feature shipping. */
export const ANTHROPIC_ENABLED = false;

/** The "API keys" section in Settings is visible iff at least one
 * provider is enabled. Both off → the whole section is hidden
 * (no header, no help text). Derived so call sites don't have to
 * repeat the OR. */
export const ANY_AI_PROVIDER_ENABLED = ELEVENLABS_ENABLED || ANTHROPIC_ENABLED;
