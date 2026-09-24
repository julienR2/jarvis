import { useState, useRef, useSyncExternalStore } from 'react'
import { ChevronDown, Check, Brain } from 'lucide-react'
import GatewayModelPicker from './GatewayModelPicker'
import Popover from './Popover'
import type { Effort } from '../api'

export interface ModelOption {
  id: string
  name: string
  desc: string
  /** Whether the model supports the effort parameter. Haiku does not. */
  effort?: boolean
  /** Output modalities (text, image, audio) — gateway catalogues only. */
  outputs?: string[]
  /** Input modalities accepted (text, file, image, video, audio). */
  inputs?: string[]
  /** What it produces: 'text' runs the agent, otherwise it generates media. */
  kind?: 'text' | 'image' | 'video' | 'audio'
}

/**
 * Fallback catalogue.
 *
 * The real list comes from GET /api/models, which reflects the active provider —
 * a gateway serves a different set entirely. This is what the picker shows
 * before that resolves, and if it fails.
 */
export const MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'Most capable, for long-running agents' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'Most capable — long-running agentic coding & knowledge work' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Best mix of speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, near-frontier', effort: false },
]

// Fetched from the server, then read synchronously by the pickers (which live
// in menus that can't easily be async).
//
// Reactive, because the catalogue changes during a session: switching provider
// swaps an Anthropic shortlist for a gateway's hundreds, and a picker still
// showing the old list would be wrong in a way the user can see.
/** Fallback default; the server's answer replaces it once loaded. */
export const DEFAULT_MODEL = 'claude-opus-5-5'

let liveModels: ModelOption[] = MODELS
let liveAllowCustom = false
let liveAnthropic: ModelOption[] = MODELS
let liveGateway: ModelOption[] = []
let liveDefault: string = DEFAULT_MODEL
let snapshot: Catalogue = {
  models: MODELS,
  default: DEFAULT_MODEL,
  anthropic: MODELS,
  gateway: [],
  allowCustom: false,
}
const listeners = new Set<() => void>()

export interface Catalogue {
  /** Everything selectable, for lookups by id. */
  models: ModelOption[]
  /**
   * What a conversation with no explicit model runs on.
   *
   * Server-decided, because it depends on which providers are configured: with
   * only a gateway it is the gateway's route to the same model, since a bare id
   * would be sent to Anthropic directly and fail.
   */
  default: string
  /** Anthropic's own models — empty when no OAuth token is configured. */
  anthropic: ModelOption[]
  /** The gateway's catalogue — empty when no gateway is configured. */
  gateway: ModelOption[]
  allowCustom: boolean
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getModels(): ModelOption[] { return liveModels }
/**
 * The instance's default model, as the server resolves it.
 *
 * Read this, never `DEFAULT_MODEL`, wherever "no model chosen" has to become a
 * concrete id. The constant is a pre-load fallback compiled in at build time;
 * the real default depends on which providers are configured and which one the
 * owner marked default, so a hardcoded `claude-opus-5` both misreports the
 * model a new chat will run on and, in the cron and webhook forms, pins it.
 */
export function getDefaultModel(): string { return liveDefault }
export function allowsCustomModel(): boolean { return liveAllowCustom }

/**
 * Whether a model id belongs to a gateway rather than Anthropic directly.
 * Mirrors the engine's rule: gateways namespace by vendor, Anthropic doesn't.
 */
export function isGatewayModel(id?: string | null): boolean {
  return !!id && id.includes('/')
}

/** Reactive read for components — re-renders when the catalogue changes. */
export function useModelCatalogue(): Catalogue {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/**
 * Load the catalogue for the active provider.
 *
 * Called at app start and again whenever the connection changes. Failures
 * leave whatever is loaded in place — a stale list beats an empty picker.
 */
export async function loadModelCatalogue(
  fetcher: () => Promise<{
    models: ModelOption[]
    default?: string
    anthropic?: ModelOption[]
    gateway?: ModelOption[]
    allowCustom?: boolean
  }>,
): Promise<void> {
  try {
    const cat = await fetcher()
    if (cat.models?.length) liveModels = cat.models
    liveAnthropic = cat.anthropic ?? cat.models ?? MODELS
    liveGateway = cat.gateway ?? []
    liveAllowCustom = !!cat.allowCustom
    liveDefault = cat.default || DEFAULT_MODEL
    snapshot = {
      models: liveModels,
      default: liveDefault,
      anthropic: liveAnthropic,
      gateway: liveGateway,
      allowCustom: liveAllowCustom,
    }
    listeners.forEach((fn) => fn())
  } catch {
    // keep whatever is loaded
  }
}


/**
 * The visible slice of a model list, with search.
 *
 * A gateway catalogue runs to hundreds of models, so the list is capped and
 * searchable rather than scrolled. The cap applies to search results too: if
 * what you typed isn't in the first few, the query is the thing to fix.
 *
 * Search appears only when there is enough to search — with four Anthropic
 * models a search box is noise.
 */
/**
 * What a model produces, for the picker chip.
 *
 * The catalogue holds two kinds: text models, which run the agent, and media
 * models, whose messages are prompts for a picture or a clip. That difference
 * changes what a conversation does, so it is what the chip says. Text models
 * get no chip — they are the unremarkable case, and a label on everything is a
 * label on nothing.
 */
export function modalityLabel(m: ModelOption): string | null {
  return m.kind && m.kind !== 'text' ? m.kind : null
}

/** Effort is a switch: off = the model's own default (no flag), on = --effort high. */
export const DEFAULT_EFFORT: Effort = 'default'

/**
 * The "Think hard" switch, shared by the chat's ⋯ menu and the routine form.
 * Off, the CLI gets no --effort flag and the model decides; on, it thinks at
 * high effort — slower, for the tasks that deserve it.
 */
export function EffortSwitch({
  effort,
  onChange,
  disabled,
  compact,
}: {
  effort: Effort
  onChange: (e: Effort) => void
  disabled?: boolean
  compact?: boolean
}) {
  const on = effort === 'high'
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(on ? 'default' : 'high')}
      title={disabled ? 'This model has no effort setting' : on ? 'Thinking at high effort — slower, more thorough' : 'The model decides how much to think'}
      className={`w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg disabled:opacity-40 ${compact ? 'text-[13px]' : ''}`}
    >
      <Brain size={14} className={on ? 'text-accent' : ''} />
      <span className='flex-1 text-left'>Think hard</span>
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-border'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${on ? 'left-[14px]' : 'left-0.5'}`} />
      </span>
    </button>
  )
}

/** Haiku uses classic extended thinking, not the effort parameter. */
export function modelSupportsEffort(id: string): boolean {
  return getModels().find((m) => m.id === id)?.effort !== false && !/haiku/i.test(id)
}

export function modelName(id: string): string {
  const known = getModels().find(m => m.id === id)
  if (known) return known.name
  const raw = id.replace(/^claude-/, '').replace(/-\d{8}.*$/, '')
  const [family, ...vParts] = raw.split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${vParts.join('.')}`
}

interface Props {
  model: string
  effort: Effort
  onModelChange: (model: string) => void
  onEffortChange: (effort: Effort) => void
  disabled?: boolean
  /** 'up' prefers above the button (chat input), 'down' below (forms); flips when there's no room. */
  direction?: 'up' | 'down'
  /** A quiet trigger for the chat input; forms keep the filled one. */
  subtle?: boolean
}

export default function ModelSelector({ model, effort, onModelChange, onEffortChange, disabled, direction = 'up', subtle }: Props) {
  const [showMenu, setShowMenu] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const { models: catalogue, anthropic, gateway } = useModelCatalogue()
  const [picking, setPicking] = useState(false)
  const selectedModel = catalogue.find(m => m.id === model) || { id: model, name: modelName(model), desc: '' }
  const supportsEffort = modelSupportsEffort(model)

  return (
    <div className="relative min-w-0">
      <button
        ref={btnRef}
        onClick={() => setShowMenu(v => !v)}
        disabled={disabled}
        title="Model"
        className={subtle
          ? `flex items-center gap-1 min-w-0 max-w-[220px] whitespace-nowrap px-2 py-1.5 rounded-xl text-xs text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors disabled:opacity-30 ${showMenu ? 'bg-surface2 text-text-primary' : ''}`
          : 'flex items-center gap-1.5 min-w-0 max-w-[260px] whitespace-nowrap px-2.5 py-1.5 rounded-xl text-xs font-medium text-text-secondary bg-bg hover:bg-border/60 transition-colors disabled:opacity-30'}
      >
        <span className={`truncate ${subtle ? '' : 'text-text-primary font-semibold'}`} title={selectedModel.name}>{selectedModel.name}</span>
        {supportsEffort && effort === 'high' && (
          <Brain size={11} className="shrink-0 text-accent" />
        )}
        <ChevronDown size={12} className="shrink-0 text-text-muted" />
      </button>

      <Popover
        anchor={btnRef}
        open={showMenu}
        onClose={() => setShowMenu(false)}
        placement={direction === 'up' ? 'top-start' : 'bottom-end'}
        gap={8}
        className="w-64 max-w-[calc(100vw-16px)] bg-surface border border-border rounded-xl shadow-md/5"
      >
          {/* Models list */}
          <div className="p-1">
            {anthropic.map((m, i) => (
              <button
                key={m.id}
                onClick={() => { onModelChange(m.id); setShowMenu(false) }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left ${
                  model === m.id
                    ? 'bg-selected'
                    : 'hover:bg-surface2'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${model === m.id ? 'text-accent' : 'text-text-primary'}`}>{m.name}</div>
                  <div className="text-[11px] text-text-muted truncate">{m.desc}</div>
                </div>
                {model === m.id && <Check size={13} className="text-accent shrink-0" />}
              </button>
            ))}
            {gateway.length > 0 && (
              // Same rule as chat: Anthropic's few are listed, a gateway's
              // hundreds open a searchable picker, and both appear when both
              // are configured.
              <button
                onClick={() => { setShowMenu(false); setPicking(true) }}
                className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg transition-colors ${
                  isGatewayModel(model) ? 'bg-selected' : 'hover:bg-surface2'
                }`}
              >
                <span className='flex-1 min-w-0'>
                  <span
                    className={`block text-sm truncate ${
                      isGatewayModel(model) ? 'text-accent' : 'text-text-primary'
                    }`}
                    title={isGatewayModel(model) ? selectedModel.name : undefined}
                  >
                    {isGatewayModel(model) ? selectedModel.name : 'OpenRouter'}
                  </span>
                  <span className='block text-[11px] text-text-muted truncate'>
                    {gateway.length} models
                  </span>
                </span>
                <ChevronDown size={13} className='shrink-0 -rotate-90 text-text-muted' />
              </button>
            )}
          </div>

          {/* Effort selector */}
          <div className="border-t border-border p-1">
            <EffortSwitch effort={effort} onChange={onEffortChange} disabled={!supportsEffort} />
          </div>
      </Popover>

      {picking && (
        <GatewayModelPicker
          // The gateway's catalogue only. Passing the combined list put
          // Anthropic's models inside the gateway picker, where choosing
          // "Opus 5" silently selected the subscription route instead.
          models={gateway}
          selected={model}
          onSelect={onModelChange}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}
