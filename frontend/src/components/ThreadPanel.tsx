import { useState } from 'react'
import { Hash } from 'lucide-react'
import { api, type Attachment, type Effort, type ReplyTo } from '../api'
import { useChatStore } from '../stores/chatStore'
import ChatInput from './ChatInput'
import { settleUploads, spoken } from '../lib/drafts'
import ChatView from './ChatView'
import { DEFAULT_EFFORT, useModelCatalogue } from './ModelSelector'

export type ThreadPanelState =
  /** Not created until its first message: from a passage, or blank (no quote). */
  | { kind: 'new'; quote: ReplyTo | null }
  | { kind: 'open'; id: string }

/**
 * A thread beside its chat, as Slack draws one: the chat stays where it is,
 * the thread opens as a tab of the side pane and, on a phone, over the whole
 * screen. The pane's tab strip names it and carries its actions (rename,
 * Done, open as a full chat), so the thread itself is only its messages.
 *
 * A new thread isn't created until its first message is sent — opening the
 * panel and changing your mind leaves nothing behind. Sending forks the chat
 * (the thread knows everything said so far) and replies to the passage.
 */
export default function ThreadPanel({
  parentId,
  state,
  onOpened,
}: {
  parentId: string
  state: ThreadPanelState
  /** The new thread exists: show it. */
  onOpened: (id: string) => void
}) {
  return (
    <div className='flex h-full min-w-0 flex-col bg-bg' data-testid='thread-panel'>
      {state.kind === 'open' ? (
        <ChatView key={state.id} conversationId={state.id} embedded />
      ) : (
        <NewThread parentId={parentId} quote={state.quote} onOpened={onOpened} />
      )}
    </div>
  )
}

function NewThread({ parentId, quote, onOpened }: { parentId: string; quote: ReplyTo | null; onOpened: (id: string) => void }) {
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
      const thread = await api.createThread(parentId, { content: text, ...(quote ? { reply_to: quote } : {}), model, effort, attachments })
      await useChatStore.getState().loadConversations()
      onOpened(thread.id)
    } catch (err: any) {
      setError(err.message ?? 'Could not start the side chat')
      setSending(false)
    }
  }

  return (
    <>
      <div className='flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 py-6'>
        <div className='mx-auto w-full max-w-2xl'>
          <p className='mb-3 text-[12px] leading-relaxed text-text-muted'>
            <Hash size={12} className='mr-1 inline -mt-0.5' />
            A side chat of {parent ? <span className='text-text-secondary'>{parent.title}</span> : 'this chat'}. It knows everything said there so far, and hears what is said there next.
          </p>
          {quote && <blockquote
            className='cursor-pointer rounded-xl border-l-[3px] border-accent/60 bg-surface2/60 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-text-secondary hover:bg-surface2'
            title='Show it in the chat'
            onClick={() => document.querySelector(`[data-message-id="${CSS.escape(quote.message_id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
          >
            <span className='line-clamp-6 whitespace-pre-wrap'>{quote.text}</span>
          </blockquote>}
          {error && <p className='mt-3 text-[12px] text-danger' role='alert'>{error}</p>}
        </div>
      </div>
      <ChatInput
        onSend={send}
        onSendAudio={async (blob, { text, files }) => {
          const [{ transcript }, attachments] = await Promise.all([api.transcribeAudio(blob), settleUploads(files)])
          const words = spoken(text, transcript)
          if (words || attachments.length) await send(words, attachments)
        }}
        onCancel={() => {}}
        isProcessing={sending}
        autoFocus
        placeholder='Write in the side chat…'
        model={model}
        effort={effort}
        onModelChange={(m) => setPicked((p) => ({ ...p, model: m }))}
        onEffortChange={(e) => setPicked((p) => ({ ...p, effort: e }))}
      />
    </>
  )
}
