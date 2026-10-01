import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Repeat } from 'lucide-react'
import type { Attachment, Effort } from '../api'
import { ContentTitle } from '../components/ContentLayout'
import ChatInput from '../components/ChatInput'
import { DEFAULT_EFFORT, useModelCatalogue } from '../components/ModelSelector'
import { RoutineFields } from '../components/RoutineSettings'
import { useChatStore } from '../stores/chatStore'
import { createRoutine, draftProblem, type RoutineSettingsDraft } from '../lib/routines'

/**
 * A new routine is a new thread: its settings on top, and its prompt written
 * in the composer, like the first message of a chat. Sending creates the
 * routine and opens its thread, where it will run.
 *
 * `?kind=cron|webhook` picks the trigger, `?conversation_id=` the chat it
 * reports into (set when started from a chat).
 */
export default function NewRoutinePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const catalogueDefault = useModelCatalogue().default
  const [draft, setDraft] = useState<RoutineSettingsDraft>(() => ({
    kind: params.get('kind') === 'webhook' ? 'webhook' : 'cron',
    name: '',
    schedule: '',
    conversation_id: params.get('conversation_id'),
    notify: 'auto',
    enabled: true,
  }))
  const [picked, setPicked] = useState<{ model?: string; effort?: Effort }>({})
  const model = picked.model ?? catalogueDefault
  const effort = picked.effort ?? DEFAULT_EFFORT
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function create(prompt: string, attachments: Attachment[]) {
    if (attachments.length) window.__jarvisToast?.info('A routine’s prompt keeps text only — the files were left out.')
    // The composer empties on send: a failed create puts the text back.
    const restore = (message: string) => {
      setError(message)
      setText('')
      setTimeout(() => setText(prompt), 0)
    }
    const problem = draftProblem(draft) ?? (prompt.trim() ? null : 'Write what it should do')
    if (problem) return restore(problem)
    setError('')
    setSaving(true)
    try {
      const row = await createRoutine(draft, prompt, model, effort)
      await useChatStore.getState().loadConversations()
      navigate(row.thread_id ? `/c/${row.thread_id}` : '/routines', { replace: true })
    } catch (err: any) {
      restore(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='flex flex-col h-full' data-testid='new-routine'>
      <ContentTitle>
        <span className='flex items-center gap-2'><Repeat size={14} className='text-text-muted' /> New routine</span>
      </ContentTitle>
      <div className='shrink-0 border-b border-border bg-bg-alt/60'>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-4'>
          <RoutineFields draft={draft} onChange={setDraft} isNew />
        </div>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto'>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-10 text-center text-sm text-text-muted'>
          <p>Write below what Jarvis should do on each run, as you would ask in a chat.</p>
          <p className='mt-1 text-xs'>
            Sending creates the routine and opens its thread — every run happens there. When there is nothing worth telling, a run stays quiet.
          </p>
          {error && <p className='mt-4 text-xs text-danger' role='alert'>{error}</p>}
        </div>
      </div>
      <ChatInput
        onSend={create}
        onSendAudio={async () => {}}
        dictateOnly
        onCancel={() => {}}
        isProcessing={saving}
        autoFocus
        placeholder='What should Jarvis do on each run?'
        initialText={text}
        model={model}
        effort={effort}
        onModelChange={(m) => setPicked((p) => ({ ...p, model: m }))}
        onEffortChange={(e) => setPicked((p) => ({ ...p, effort: e }))}
      />
    </div>
  )
}
