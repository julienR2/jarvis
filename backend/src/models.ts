// Single source of truth for the backend's default Claude model.
//
// The DB stores `null` in a row's `model` column when no model was explicitly
// chosen — that null is the "use the global default" marker. resolveModel()
// turns it into a concrete id at invocation time, so switching the default is a
// one-line edit here (keep it in sync with DEFAULT_MODEL in
// frontend/src/components/ModelSelector.tsx, which drives the picker UI).
//
// The `update-claude-cli` skill edits this constant automatically when a new
// model generation ships. Nothing else in the backend should hardcode a model id.
export const DEFAULT_MODEL = 'claude-opus-5'

/** Resolve a stored/optional model id, falling back to the global default. */
export function resolveModel(model?: string | null): string {
  return model ?? DEFAULT_MODEL
}
