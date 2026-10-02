import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Hash, Maximize2, X } from 'lucide-react'
import { api, type Attachment, type Effort, type ReplyTo } from '../api'
import { useChatStore } from '../stores/chatStore'
import { useIsDesktop } from '../hooks/useIsDesktop'
import ChatInput from './ChatInput'
import ChatView from './ChatView'
import { DEFAULT_EFFORT, useModelCatalogue } from './ModelSelector'

export type ThreadPanelState =
  | { kind: 'new'; quote: ReplyTo }
  | { kind: 'open'; id: string }

/**
 * A thread beside its chat, as Slack draws one: the chat stays where it is,
 * the thread opens in the side pane (the app's place, when the chat has one)
 * and, on a phone, over the whole screen.
 *
 * A new thread isn't created until its first message is sent — opening the
 * panel and changing your mind leaves nothing behind. Sending forks the chat
 * (the thread knows everything said so far) and replies to the passage.
 */
export default function ThreadPanel({
  parentId,
  state,
  onClose,
  onOpened,
}: {
  parentId: string
  state: ThreadPanelState
  onClose: () => void
  /** The new thread exists: show it. */
  onOpened: (id: string) => void
}) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const parent = useChatStore((s) => s.conversations[parentId])
  const thread = useChatStore((s) => (state.kind === 'open' ? s.conversations[state.id] : undefined))

  return (
    <div className='flex h-full min-w-0 flex-col bg-bg' data-testid='thread-panel'>
      <div className='flex h-12 shrink-0 items-center gap-2 border-b border-border px-3'>
        {!isDesktop && (
          <button type='button' onClick={onClose} aria-label='Back to the chat' className='rounded-lg p-1.5 text-text-muted hover:bg-surface2 hover:text-text-primary'>
            <ArrowLeft size={16} />
          </button>
        )}
        <div className='flex min-w-0 flex-1 items-baseline gap-2'>
          <span className='shrink-0 text-sm font-semibold text-text-primary'>Thread</span>
          <span className='truncate text-[12px] text-text-muted'>
            {thread ? thread.title : parent?.title}
          </span>
        </div>
        {state.kind === 'open' && (
          <button type='button' onClick={() => navigate(`/c/${state.id}`)} title='Open as a full chat' className='rounded-lg p-1.5 text-text-muted hover:bg-surface2 hover:text-text-primary'>
            <Maximize2 size={14} />
          </button>
        )}
        {isDesktop && (
          <button type='button' onClick={onClose} aria-label='Close the thread' className='rounded-lg p-1.5 text-text-muted hover:bg-surface2 hover:text-text-primary'>
            <X size={16} />
          </button>
        )}
      </div>
      <div className='flex min-h-0 flex-1 flex-col'>
        {state.kind === 'open' ? (
          <ChatView key={state.id} conversationId={state.id} embedded />
        ) : (
          <NewThread parentId={parentId} quote={state.quote} onOpened={onOpened} />
        )}
      </div>
    </div>
  )
}

function NewThread({ parentId, quote, onOpened }: { parentId: string; quote: ReplyTo; onOpened: (id: string) => void }) {
  const parent = useChatStore((s) => s.conversations[parentId])
  const fallback = useModelCatalogue().default
  const [picked, setPicked] = useState<{ model?: string; effort?: Effort }>({})
  const model = picked.model ?? parent?.model ?? fallback
  const effort = picked.effort ?? parent?.effort ?? DEFAULT_EFFORT
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  async function send(text: string, attachments: Attachment[]) {
    if (!text.trim() && attachments.length === 0) return
    setSending(true)
    setError('')
    try {
      const thread = await api.createThread(parentId, { content: text, reply_to: quote, model, effort, attachments })
      await useChatStore.getState().loadConversations()
      onOpened(thread.id)
    } catch (err: any) {
      setError(err.message ?? 'Could not start the thread')
      setSending(false)
    }
  }

  return (
    <>
      <div className='flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 py-6'>
        <div className='mx-auto w-full max-w-2xl'>
          <p className='mb-3 text-[12px] leading-relaxed text-text-muted'>
            <Hash size={12} className='mr-1 inline -mt-0.5' />
            A thread from {parent ? <span className='text-text-secondary'>{parent.title}</span> : 'this chat'}. It knows everything said there so far.
          </p>
          <blockquote
            className='cursor-pointer rounded-xl border-l-[3px] border-accent/60 bg-surface2/60 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-text-secondary hover:bg-surface2'
            title='Show it in the chat'
            onClick={() => document.querySelector(`[data-message-id="${CSS.escape(quote.message_id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
          >
            <span className='line-clamp-6 whitespace-pre-wrap'>{quote.text}</span>
          </blockquote>
          {error && <p className='mt-3 text-[12px] text-danger' role='alert'>{error}</p>}
        </div>
      </div>
      <ChatInput
        onSend={send}
        onSendAudio={async (blob) => {
          const { transcript } = await api.transcribeAudio(blob)
          if (transcript.trim()) await send(transcript.trim(), [])
        }}
        onCancel={() => {}}
        isProcessing={sending}
        autoFocus
        placeholder='Reply in a thread…'
        model={model}
        effort={effort}
        onModelChange={(m) => setPicked((p) => ({ ...p, model: m }))}
        onEffortChange={(e) => setPicked((p) => ({ ...p, effort: e }))}
      />
    </>
  )
}
