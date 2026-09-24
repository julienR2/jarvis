import { useState, useRef, useEffect } from 'react'
import { Send, Square, Paperclip, X, FileText, MessageCircleQuestion, Reply } from 'lucide-react'
import AudioButton from './AudioButton'
import AnswerCard, { OptionList, hasOptions } from './AnswerCard'
import ModelSelector from './ModelSelector'
import { api, questionsOf, type Attachment, type Effort, type PendingQuestion, type ReplyTo } from '../api'

export interface PendingFile {
  file: File
  preview?: string  // data URL for images
  uploading: boolean
  uploaded?: Attachment
  error?: string
}

interface Props {
  onSend: (text: string, attachments: Attachment[]) => void
  onSendAudio: (blob: Blob) => Promise<void>
  onCancel: () => void
  isProcessing: boolean
  conversationId?: string
  autoFocus?: boolean
  /** Replaces the default prompt. */
  placeholder?: string
  /**
   * The question Jarvis is waiting on, when there is one: drawn on top of the
   * input, whose text then answers it (see ChatView.sendMessage). With options
   * on offer the input dims until touched, so the buttons read as the first
   * way to answer and typing as the other.
   */
  question?: PendingQuestion
  /** Tighter chrome for embedding — e.g. a Today card. Drops outer padding,
   *  the width cap and the disclaimer line. */
  compact?: boolean
  initialText?: string
  initialFiles?: File[]
  onInitialFilesConsumed?: () => void
  /** The passage being replied to, drawn at the head of the box; the parent
   *  owns it and sends it with the text (see ChatView.sendMessage). */
  quote?: ReplyTo | null
  onClearQuote?: () => void
  /** What the next message runs on. The picker shows only when a model is given;
   *  the parent owns the choice and sends it with the message. */
  model?: string
  effort?: Effort
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: Effort) => void
}

export default function ChatInput({ onSend, onSendAudio, onCancel, isProcessing, conversationId, autoFocus, placeholder, question, compact, initialText, initialFiles, onInitialFilesConsumed, quote, onClearQuote, model, effort = 'default', onModelChange, onEffortChange }: Props) {
  const [input, setInput] = useState(initialText || '')
  // A fresh quote is an invitation to type under it.
  useEffect(() => {
    if (quote) textareaRef.current?.focus()
  }, [quote])
  const [audioActive, setAudioActive] = useState(false)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus textarea when requested (e.g. new empty conversation)
  useEffect(() => {
    if (autoFocus) {
      // Delay slightly for mobile keyboards to be ready
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [autoFocus])

  // Handle initial text from share intent
  useEffect(() => {
    if (initialText) {
      setInput(initialText)
      // Auto-resize textarea for pre-filled text
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
        }
      }, 0)
    }
  }, [initialText])

  // Handle initial files from share intent
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      addFiles(initialFiles)
      onInitialFilesConsumed?.()
    }
  }, [initialFiles])

  async function uploadFile(pending: PendingFile, index: number) {
    try {
      const attachment = await api.uploadFile(pending.file, conversationId)
      setFiles(prev => prev.map((f, i) => i === index ? { ...f, uploading: false, uploaded: attachment } : f))
    } catch (err: any) {
      setFiles(prev => prev.map((f, i) => i === index ? { ...f, uploading: false, error: err.message } : f))
    }
  }

  function addFiles(newFiles: File[]) {
    const pending: PendingFile[] = newFiles.map(file => {
      const p: PendingFile = { file, uploading: true }
      if (file.type.startsWith('image/')) {
        p.preview = URL.createObjectURL(file)
      }
      return p
    })

    setFiles(prev => {
      const updated = [...prev, ...pending]
      // Start uploads for new files
      const startIdx = prev.length
      pending.forEach((p, i) => uploadFile(p, startIdx + i))
      return updated
    })
  }

  function removeFile(index: number) {
    setFiles(prev => {
      const f = prev[index]
      if (f.preview) URL.revokeObjectURL(f.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  function handleSend() {
    const attachments = files
      .filter(f => f.uploaded)
      .map(f => f.uploaded!)

    if (!input.trim() && attachments.length === 0) return

    onSend(input, attachments)
    // Clean up previews
    files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) })
    setFiles([])
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const isMobile = navigator.maxTouchPoints > 0
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleTranscript(blob: Blob) {
    await onSendAudio(blob)
  }

  async function handleTranscribeOnly(blob: Blob) {
    const res = await api.transcribeAudio(blob)
    if (!res?.transcript) return
    setInput(prev => {
      const prefix = prev.length > 0 && !prev.endsWith(' ') ? ' ' : ''
      return prev + prefix + res.transcript
    })
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items
    const pastedFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) pastedFiles.push(file)
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault()
      addFiles(pastedFiles)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    if (dropped.length > 0) addFiles(dropped)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  const hasFiles = files.length > 0
  const allUploaded = files.every(f => f.uploaded || f.error)
  const hasContent = !!input.trim() || files.some(f => f.uploaded)

  // A question Jarvis asked (not a tool approval): its options are drawn on the
  // input, and picking one sets the input's value — the input IS the answer,
  // and the composer's own Send confirms it. While nothing is picked or typed
  // the input dims, so the options read as the first way to answer.
  const asksQuestion = !!question && questionsOf(question).length > 0
  const dimInput = asksQuestion && hasOptions(question!) && !input.trim() && !hasFiles && !audioActive
  const effectivePlaceholder =
    placeholder ?? (asksQuestion ? (hasOptions(question!) ? 'Or type your own answer…' : 'Your answer…') : 'How can I help you today?')
  // Mic shows when no text typed, OR when files are attached (even with text).
  // Send stays available while Claude works: the message is steered into the
  // running turn (Stop shows to its left in that case).
  const showMic = !audioActive && (!input.trim() || hasFiles)
  const showSend = !audioActive && hasContent && (!hasFiles || allUploaded)
  const showCancel = isProcessing && !audioActive

  return (
    <div
      className={compact ? '' : 'px-4 md:px-6 pb-4 pt-2'}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
    >
      <div className={compact ? '' : 'max-w-3xl mx-auto'}>
        <div className={`bg-surface border rounded-2xl shadow-sm transition-colors ${dragOver ? 'border-accent bg-accent/5' : question ? 'border-warning/50 focus-within:border-warning' : 'border-border focus-within:border-text-muted'}`}>
          {asksQuestion && question && (
            <div className='border-b border-warning/30 bg-warning/5 px-4 py-2.5 rounded-t-2xl animate-fade-in' data-testid='answer-card' data-request-id={question.request_id}>
              <div className='mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning/80'>
                <MessageCircleQuestion size={11} /> Jarvis asks
              </div>
              <OptionList
                questions={questionsOf(question)}
                selectedOf={() => (input.trim() ? [input.trim()] : [])}
                onPick={(_q, label) => {
                  // Setting it as the input value is the whole trick: pick and
                  // type are the same field, so Send, dictation and attach all
                  // work unchanged. Tapping the chosen one again clears it.
                  setInput(input.trim() === label ? '' : label)
                  setTimeout(() => textareaRef.current?.focus(), 0)
                }}
                disabled={audioActive}
              />
            </div>
          )}
          {question && !asksQuestion && conversationId && (
            <AnswerCard conversationId={conversationId} question={question} variant='strip' />
          )}
          {quote && (
            <div data-testid='composer-quote' className='flex items-start gap-2.5 border-b border-border px-4 pt-3 pb-2.5'>
              <Reply size={14} className='mt-0.5 shrink-0 text-accent' />
              <p className='min-w-0 flex-1 border-l-2 border-accent/50 pl-2.5 text-[13px] leading-snug text-text-secondary line-clamp-3'>
                {quote.text}
              </p>
              <button
                type='button'
                onClick={onClearQuote}
                aria-label='Remove quote'
                className='shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-text-primary'
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className={dimInput ? 'opacity-50 transition-opacity hover:opacity-100 focus-within:opacity-100' : 'transition-opacity'}>
          {/* File previews */}
          {hasFiles && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {files.map((f, i) => (
                <div key={i} className="relative group">
                  {f.preview ? (
                    <div className="w-16 h-16 rounded-lg overflow-hidden border border-border">
                      <img src={f.preview} alt={f.file.name} className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-16 h-16 rounded-lg border border-border bg-bg flex flex-col items-center justify-center gap-1 px-1">
                      <FileText size={16} className="text-text-muted shrink-0" />
                      <span className="text-[9px] text-text-muted truncate w-full text-center">{f.file.name.split('.').pop()}</span>
                    </div>
                  )}
                  {/* Upload state overlay */}
                  {f.uploading && (
                    <div className="absolute inset-0 bg-black/40 rounded-lg flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {f.error && (
                    <div className="absolute inset-0 bg-danger/40 rounded-lg flex items-center justify-center">
                      <span className="text-white text-[10px]">Error</span>
                    </div>
                  )}
                  {/* Remove button */}
                  <button
                    onClick={() => removeFile(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface border border-border rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={10} className="text-text-muted" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea row — full width */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              onPaste={handlePaste}
              onFocus={() => setTimeout(() => textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
              placeholder={effectivePlaceholder}
              disabled={audioActive}
              rows={1}
              className="w-full resize-none max-h-[200px] overflow-y-auto bg-transparent text-text-primary placeholder:text-text-muted text-sm leading-relaxed focus:outline-none disabled:opacity-50"
            />
          </div>

          {/*
            No `accept` — the picker takes anything. Drag-drop and paste always
            did (both hand `addFiles` whatever they're given) and the backend has
            no type allowlist either, so the whitelist here only made the attach
            button the one route that refused a file the rest of the stack would
            have accepted. Size is the real limit: 20MB, reported per file.
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files || [])
              if (selected.length > 0) addFiles(selected)
              e.target.value = ''
            }}
          />

          {/* Bottom bar — attach left, model + actions right */}
          <div className="flex items-center justify-between px-2 pb-2">
            {/* Attach button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 rounded-xl text-text-muted hover:text-text-primary hover:bg-bg transition-colors disabled:opacity-30"
              title="Attach file"
            >
              <Paperclip size={16} />
            </button>

            <div className="flex items-center gap-1">
              {/* Not while answering: an answer continues the turn that asked,
                  on whatever it runs on — it is not a new message. */}
              {model && !asksQuestion && onModelChange && onEffortChange && (
                <ModelSelector model={model} effort={effort} onModelChange={onModelChange} onEffortChange={onEffortChange} />
              )}
              {/* AudioButton always mounted to preserve state; visible when idle mic or actively recording */}
              <div className={showMic || audioActive ? '' : 'hidden'}>
                <AudioButton
                  onAudioReady={handleTranscript}
                  onTranscribeReady={handleTranscribeOnly}
                  onActiveChange={setAudioActive}
                />
              </div>
              {/* Stop sits left of Send, never the other way round: Send has to
                  keep the same spot whether or not a turn is running, otherwise
                  stacking a message while Claude works lands on Stop instead. */}
              {showCancel && (
                <button
                  onClick={onCancel}
                  className="p-2 rounded-xl bg-danger text-white hover:opacity-90 transition-opacity"
                  title="Stop"
                >
                  <Square size={16} fill="currentColor" />
                </button>
              )}
              {showSend && (
                <button
                  onClick={handleSend}
                  className={`p-2 rounded-xl text-white disabled:opacity-30 transition-colors ${asksQuestion ? 'bg-warning hover:opacity-90' : 'bg-accent hover:bg-accent-hover'}`}
                  title={asksQuestion ? 'Answer' : 'Send'}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
          </div>
        </div>
        {!compact && (
          <p className="text-center text-[11px] text-text-muted mt-2">
            Jarvis can make mistakes. Double-check important info.
          </p>
        )}
      </div>
    </div>
  )
}
