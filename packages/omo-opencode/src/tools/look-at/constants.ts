export const MULTIMODAL_LOOKER_AGENT = "multimodal-looker" as const

export const LOOK_AT_DESCRIPTION = `Delegate basic media extraction to a separate multimodal model only when the current model cannot accept the file directly. If the current model supports image or PDF input, use Read so the original media stays in the current context without lossy re-description. NEVER use for visual precision, aesthetic evaluation, or exact accuracy.`
