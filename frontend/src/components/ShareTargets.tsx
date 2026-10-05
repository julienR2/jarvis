import { useEffect, useState } from 'react'
import { AppWindow, ChevronDown, ChevronRight, ChevronUp, Hash, Link2, MessageSquare, Pin, Plus, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api, type Conversation, type Section, type ShareTarget, type Webhook } from '../api'
import { useChatStore } from '../stores/chatStore'

/**
 * Where shared content can go. The share screen lists the pinned ones first,
 * then the same tree as the sidebar — topics and their chats, the loose chats,
 * and the webhooks, which run their prompt on what was shared.
 */
export type ShareDestination =
  | { kind: 'new' }
  /** A new chat filed under the topic. */
  | { kind: 'section'; section: Section }
  | { kind: 'conversation'; conv: Conversation }
  | { kind: 'webhook'; webhook: Webhook }

function targetOf(dest: ShareDestination): ShareTarget | null {
  switch (dest.kind) {
    case 'new': return null
    case 'section': return { kind: 'section', target_id: dest.section.id }
    case 'conversation': return { kind: 'conversation', target_id: dest.conv.id }
    case 'webhook': return { kind: 'webhook', target_id: dest.webhook.id }
  }
}

export function destinationLabel(dest: ShareDestination): string {
  switch (dest.kind) {
    case 'new': return 'New conversation'
    case 'section': return `New chat in ${dest.section.name}`
    case 'conversation': return dest.conv.title
    case 'webhook': return dest.webhook.name
  }
}

function DestinationIcon({ dest }: { dest: ShareDestination }) {
  const Icon =
    dest.kind === 'new' ? Plus
      : dest.kind === 'section' ? Hash
        : dest.kind === 'webhook' ? Link2
          : dest.conv.app_path ? AppWindow
            : MessageSquare
  return <Icon size={14} className='shrink-0 text-text-muted' />
}

/** Everything the tree lists, and the pins over it. */
export function useShareCatalogue() {
  const chats = useChatStore(
    useShallow((s) =>
      s.order.map((id) => s.conversations[id]).filter((c): c is Conversation => !!c && c.kind !== 'thread'),
    ),
  )
  const sections = useChatStore(useShallow((s) => s.sections))
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null)
  const [pins, setPinsState] = useState<ShareTarget[] | null>(null)

  useEffect(() => {
    api.getWebhooks().then(setWebhooks).catch(() => setWebhooks([]))
    api.getShareTargets().then(setPinsState).catch(() => setPinsState([]))
  }, [])

  function resolve(pin: ShareTarget): ShareDestination | null {
    if (pin.kind === 'section') {
      const section = sections.find((s) => s.id === pin.target_id)
      return section ? { kind: 'section', section } : null
    }
    if (pin.kind === 'webhook') {
      const webhook = webhooks?.find((w) => w.id === pin.target_id)
      return webhook ? { kind: 'webhook', webhook } : null
    }
    const conv = chats.find((c) => c.id === pin.target_id)
    return conv ? { kind: 'conversation', conv } : null
  }

  function isPinned(dest: ShareDestination): boolean {
    const t = targetOf(dest)
    return !!t && !!pins?.some((p) => p.kind === t.kind && p.target_id === t.target_id)
  }

  async function setPins(next: ShareTarget[]) {
    const before = pins
    setPinsState(next)
    try {
      setPinsState(await api.setShareTargets(next))
    } catch {
      setPinsState(before)
      window.__jarvisToast?.error("Couldn't save the share sheet's pins.")
    }
  }

  function togglePin(dest: ShareDestination) {
    const t = targetOf(dest)
    if (!t || !pins) return
    setPins(
      isPinned(dest)
        ? pins.filter((p) => !(p.kind === t.kind && p.target_id === t.target_id))
        : [...pins, t],
    )
  }

  const resolved = (pins ?? [])
    .map((p) => ({ pin: p, dest: resolve(p) }))
    .filter((x): x is { pin: ShareTarget; dest: ShareDestination } => !!x.dest)

  return {
    chats,
    sections,
    webhooks: webhooks ?? [],
    pins: resolved,
    loaded: webhooks !== null && pins !== null,
    isPinned,
    togglePin,
    setPins,
  }
}

export type ShareCatalogue = ReturnType<typeof useShareCatalogue>

/** One compact row: the tree has to fit a phone's share screen. */
function TargetRow({
  dest,
  label,
  hint,
  indent,
  disabled,
  onPick,
  action,
}: {
  dest: ShareDestination
  label?: string
  hint?: string
  indent?: boolean
  disabled?: boolean
  onPick: () => void
  action?: React.ReactNode
}) {
  return (
    <div className={`flex items-center rounded-lg hover:bg-surface2 transition-colors ${indent ? 'pl-5' : ''}`}>
      <button
        onClick={onPick}
        disabled={disabled}
        className='flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left disabled:opacity-50'
      >
        <DestinationIcon dest={dest} />
        <span className='flex-1 min-w-0 text-sm text-text-primary truncate'>{label ?? destinationLabel(dest)}</span>
        {hint && <span className='shrink-0 text-[11px] text-text-muted'>{hint}</span>}
      </button>
      {action && <div className='shrink-0 pr-1'>{action}</div>}
    </div>
  )
}

function GroupHeader({
  label,
  icon,
  open,
  onToggle,
  action,
}: {
  label: string
  icon?: React.ReactNode
  open: boolean
  onToggle: () => void
  action?: React.ReactNode
}) {
  return (
    <div className='h-8 flex items-center pr-1'>
      <button
        onClick={onToggle}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
        className='flex-1 self-stretch flex items-center gap-1.5 pl-1.5 min-w-0 text-[11px] font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary transition-colors'
      >
        <ChevronRight size={11} className={`shrink-0 text-text-muted/50 transition-transform ${open ? 'rotate-90' : ''}`} />
        {icon}
        <span className='truncate'>{label}</span>
      </button>
      {action}
    </div>
  )
}

/** Stand-in key of the topic-less chats, open from the start. */
const CHATS_KEY = '__chats__'
const WEBHOOKS_KEY = '__webhooks__'

/**
 * The sidebar's tree, folded small. Topics start closed — a share screen has
 * to show the whole outline at once — and open on tap; their `+` starts a new
 * chat in them. `action` puts something at the end of every row (Settings'
 * pin toggle); without it a topic's trailing control is that `+`.
 */
export function ShareTree({
  catalogue,
  onPick,
  action,
  disabled,
  showNew = true,
}: {
  catalogue: ShareCatalogue
  onPick: (dest: ShareDestination) => void
  action?: (dest: ShareDestination) => React.ReactNode
  disabled?: boolean
  showNew?: boolean
}) {
  const [open, setOpen] = useState<string[]>([CHATS_KEY, WEBHOOKS_KEY])
  const toggle = (key: string) =>
    setOpen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  const row = (dest: ShareDestination, extra: { hint?: string; indent?: boolean } = {}) => (
    <TargetRow
      key={`${dest.kind}:${targetOf(dest)?.target_id ?? ''}`}
      dest={dest}
      disabled={disabled}
      onPick={() => onPick(dest)}
      action={action?.(dest)}
      {...extra}
    />
  )

  const loose = catalogue.chats.filter((c) => !c.section_id)

  return (
    <div className='flex flex-col'>
      {showNew && row({ kind: 'new' })}

      {catalogue.sections.map((section) => {
        const dest: ShareDestination = { kind: 'section', section }
        const isOpen = open.includes(section.id)
        const convs = catalogue.chats.filter((c) => c.section_id === section.id)
        return (
          <div key={section.id} className='flex flex-col'>
            <GroupHeader
              label={section.name}
              open={isOpen}
              onToggle={() => toggle(section.id)}
              action={
                action?.(dest) ?? (
                  <button
                    onClick={() => onPick(dest)}
                    disabled={disabled}
                    title={`New chat in ${section.name}`}
                    aria-label={`New chat in ${section.name}`}
                    className='p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors disabled:opacity-50'
                  >
                    <Plus size={14} />
                  </button>
                )
              }
            />
            {isOpen && convs.map((conv) => row({ kind: 'conversation', conv }, { indent: true }))}
            {isOpen && convs.length === 0 && (
              <div className='pl-7 py-1 text-[11px] text-text-muted/70 italic'>No chats</div>
            )}
          </div>
        )
      })}

      {loose.length > 0 && (
        <>
          <GroupHeader label='Chats' open={open.includes(CHATS_KEY)} onToggle={() => toggle(CHATS_KEY)} />
          {open.includes(CHATS_KEY) && loose.map((conv) => row({ kind: 'conversation', conv }, { indent: true }))}
        </>
      )}

      {catalogue.webhooks.length > 0 && (
        <>
          <GroupHeader
            label='Webhooks'
            icon={<Link2 size={11} className='shrink-0' />}
            open={open.includes(WEBHOOKS_KEY)}
            onToggle={() => toggle(WEBHOOKS_KEY)}
          />
          {open.includes(WEBHOOKS_KEY) &&
            catalogue.webhooks.map((webhook) =>
              row({ kind: 'webhook', webhook }, { indent: true, hint: webhook.enabled ? undefined : 'Off' }),
            )}
        </>
      )}
    </div>
  )
}

/** The pinned destinations, in order, ahead of the tree. */
export function PinnedTargets({
  catalogue,
  onPick,
  disabled,
}: {
  catalogue: ShareCatalogue
  onPick: (dest: ShareDestination) => void
  disabled?: boolean
}) {
  if (catalogue.pins.length === 0) return null
  return (
    <div className='flex flex-col' data-testid='share-pinned'>
      <div className='h-8 flex items-center gap-1.5 pl-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted'>
        <Pin size={11} className='shrink-0' />
        Pinned
      </div>
      {catalogue.pins.map(({ pin, dest }) => (
        <TargetRow
          key={`${pin.kind}:${pin.target_id}`}
          dest={dest}
          disabled={disabled}
          onPick={() => onPick(dest)}
        />
      ))}
    </div>
  )
}

/**
 * Settings › General › Share sheet: what the share screen lists first. Pins
 * are ordered here and picked from the same tree the share screen shows.
 */
export function ShareSheetSettings() {
  const catalogue = useShareCatalogue()
  const [adding, setAdding] = useState(false)
  const { pins, setPins } = catalogue

  function move(i: number, by: -1 | 1) {
    const next = pins.map((p) => p.pin)
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setPins(next)
  }

  const iconButton = 'p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className='rounded-2xl border border-border bg-surface divide-y divide-border'>
      <div className='px-4 py-3 text-xs text-text-muted'>
        Listed first when you share to Jarvis from another app. A webhook runs its prompt on what was shared.
      </div>
      {catalogue.loaded && pins.length === 0 && (
        <div className='px-4 py-3 text-sm text-text-muted'>Nothing pinned.</div>
      )}
      {pins.length > 0 && (
        <div className='px-2 py-1.5 flex flex-col' data-testid='share-pins'>
          {pins.map(({ pin, dest }, i) => (
            <div key={`${pin.kind}:${pin.target_id}`} className='flex items-center gap-2 pl-2 rounded-lg'>
              <DestinationIcon dest={dest} />
              <span className='flex-1 min-w-0 text-sm text-text-primary truncate py-1.5'>{destinationLabel(dest)}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0} className={iconButton} aria-label='Move up'>
                <ChevronUp size={14} />
              </button>
              <button onClick={() => move(i, 1)} disabled={i === pins.length - 1} className={iconButton} aria-label='Move down'>
                <ChevronDown size={14} />
              </button>
              <button onClick={() => catalogue.togglePin(dest)} className={iconButton} aria-label='Unpin'>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className='px-2 py-1.5'>
        <button
          onClick={() => setAdding((a) => !a)}
          className='w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-surface2 transition-colors'
        >
          <Pin size={14} />
          <span className='flex-1 text-left'>{adding ? 'Done' : 'Pin a chat, topic or webhook'}</span>
          <ChevronRight size={12} className={`transition-transform ${adding ? 'rotate-90' : ''}`} />
        </button>
        {adding && (
          <div className='mt-1 max-h-96 overflow-y-auto' data-testid='share-pin-tree'>
            <ShareTree
              catalogue={catalogue}
              showNew={false}
              onPick={catalogue.togglePin}
              action={(dest) => {
                const pinned = catalogue.isPinned(dest)
                return (
                  <button
                    onClick={() => catalogue.togglePin(dest)}
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${destinationLabel(dest)}`}
                    aria-pressed={pinned}
                    className={`p-1.5 rounded-md transition-colors hover:bg-surface2 ${pinned ? 'text-accent' : 'text-text-muted/60 hover:text-text-primary'}`}
                  >
                    <Pin size={14} className={pinned ? 'fill-current' : ''} />
                  </button>
                )
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
