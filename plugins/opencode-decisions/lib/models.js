// Decision-model endpoint identifiers.
// These are opaque API IDs, not product branding. Background and vetting notes
// live in research/ at the repository root.
export const DEFAULT_MODEL = { providerID: "opencode", id: "jev-1.13-free" };
export const ENSEMBLE_MODELS = [
  "jev-1.13-free",
  "gpt-6-luna-decision",
  "gemini-decision-1",
];
export const FALLBACK_MODEL = "jev-1.13";
