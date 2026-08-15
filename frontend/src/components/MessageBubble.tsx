import { useMemo, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { FileText, ChevronRight, Copy, Check } from 'lucide-react'
import type { Message, Attachment } from '../api'

interface Props {
  msg: Message
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className='inline-flex items-center opacity-0 group-hover:opacity-60 [@media(hover:none)]:opacity-40 hover:!opacity-100 transition-opacity'
      title='Copy message'
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  )
}

function getAssistantCopyText(msg: Message): string {
  if (!hasActivityLines(msg.content)) return msg.content
  const { activityLines } = parseActivityContent(msg.content)
  const hasResult = !!msg.result
  const allChunks = activityLines.filter((l) => l.prefix === 'chunk')
  const visibleChunks = hasResult && allChunks.length > 0 ? allChunks.slice(0, -1) : allChunks
  // Copy what's on screen: notes render above the answer text, so they belong in
  // the copy too. Only the collapsed tool steps are left out.
  const parts = [
    ...activityLines.filter((l) => l.prefix === 'note').map((l) => l.text),
    ...visibleChunks.map((l) => l.text),
  ]
  if (hasResult) parts.push(msg.result!)
  return parts.join('\n\n')
}

function parseAttachments(metadata?: string | null): Attachment[] {
  if (!metadata) return []
  try {
    const parsed = JSON.parse(metadata)
    return parsed.attachments || []
  } catch {
    return []
  }
}

type ActivityPrefix = 'tool' | 'chunk' | 'note'

interface ParsedLines {
  activityLines: { prefix: ActivityPrefix; text: string }[]
}

// Longest-first is not needed here (no prefix is a prefix of another), but the
// lengths are derived rather than hardcoded so a rename can't desync the slice.
const ACTIVITY_PREFIXES: ActivityPrefix[] = ['tool', 'chunk', 'note']

function parseActivityContent(content: string): ParsedLines {
  // Split into entries — each starts with [tool], [chunk] or [note], and may
  // span multiple paragraphs.
  const paragraphs = content.split('\n\n')
  const activityLines: ParsedLines['activityLines'] = []

  for (const para of paragraphs) {
    const prefix = ACTIVITY_PREFIXES.find((p) => para.startsWith(`[${p}] `))
    if (prefix) {
      activityLines.push({ prefix, text: para.slice(prefix.length + 3) })
    } else if (activityLines.length > 0) {
      // Continuation of previous entry (multiline tool/chunk/note)
      activityLines[activityLines.length - 1].text += '\n\n' + para
    }
  }

  return { activityLines }
}

function hasActivityLines(content: string): boolean {
  return ACTIVITY_PREFIXES.some((p) => content.startsWith(`[${p}] `))
}

function ActivityBubble({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false)
  const { activityLines } = useMemo(
    () => parseActivityContent(msg.content),
    [msg.content],
  )

  const hasResult = !!msg.result
  // Collapsible = mechanical steps (tool calls, agent starts) — the "what it
  // did" detail, useful on demand and noise by default.
  // Visible = notes + chunks + result. Notes are the model narrating its own
  // progress while subagents run; they're prose written for a reader, which is
  // exactly the "tell me the important part along the way" layer, so they stay
  // out of the toggle.
  // The last chunk typically duplicates the result, so strip it when result exists
  const collapsibleLines = activityLines.filter((l) => l.prefix === 'tool')
  const notes = activityLines.filter((l) => l.prefix === 'note')
  const allChunks = activityLines.filter((l) => l.prefix === 'chunk')
  const visibleChunks = hasResult && allChunks.length > 0
    ? allChunks.slice(0, -1)
    : allChunks

  return (
    <div className='flex items-start mb-5 animate-fade-in group'>
      <div className='max-w-full'>
        {/* Collapsible section */}
        {collapsibleLines.length > 0 && (
          <div className='mb-3'>
            <button
              onClick={() => setOpen(!open)}
              className='flex items-center gap-1 text-[11px] text-text-muted/60 hover:text-text-muted transition-colors'
            >
              <ChevronRight
                size={10}
                className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
              />
              <span>
                {collapsibleLines.length} step
                {collapsibleLines.length !== 1 ? 's' : ''}
              </span>
            </button>
            {open && (
              <ul className='mt-1 ml-3 flex flex-col gap-0.5 text-xs list-disc list-inside'>
                {collapsibleLines.map((line, i) => (
                  <li key={i} className='text-text-muted'>
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Progress narration — dimmer than the answer, but readable, and
            never hidden behind the step toggle. */}
        {notes.length > 0 && (
          <div className='mb-3 flex flex-col gap-1.5 border-l-2 border-border pl-3'>
            {notes.map((line, i) => (
              <p key={i} className='text-[13px] text-text-muted leading-snug'>
                {line.text}
              </p>
            ))}
          </div>
        )}

        {/* Visible section: all text chunks + final result */}
        {(visibleChunks.length > 0 || hasResult) && (
          <div className='markdown text-base leading-relaxed'>
            {visibleChunks.map((line, i) => (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {line.text}
              </ReactMarkdown>
            ))}
            {hasResult && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {msg.result!}
              </ReactMarkdown>
            )}
          </div>
        )}
        {msg.created_at &&
          (hasResult || visibleChunks.length > 0 || notes.length > 0) && (
          <div className='text-[10px] text-text-muted/50 mt-1 flex items-center gap-1.5'>
            {formatTime(msg.created_at)}
            <CopyButton getText={() => getAssistantCopyText(msg)} />
          </div>
        )}
      </div>
    </div>
  )
}

export default function MessageBubble({ msg }: Props) {
  const isUser = msg.role === 'user'
  // Above the early return — a hook must not sit on one side of a conditional
  // return, or the first message whose content grows into activity lines takes
  // the whole list down with a hook-order error.
  const attachments = useMemo(
    () => parseAttachments(msg.metadata),
    [msg.metadata],
  )

  // Assistant message with [tool]/[chunk]/[note] lines → activity bubble
  if (!isUser && hasActivityLines(msg.content)) {
    return <ActivityBubble msg={msg} />
  }

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-5 animate-fade-in`}
    >
      <div
        className={`
        relative group break-words
        ${
          isUser
            ? 'max-w-[75%] bg-accent-subtle text-text-primary rounded-2xl rounded-br-md px-4 py-3'
            : 'max-w-full text-text-primary'
        }
        text-base leading-relaxed
      `}
      >
        {/* Attachments */}
        {attachments.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${msg.content ? 'mb-2' : ''}`}>
            {attachments.map((att) => (
              <AttachmentPreview key={att.id} attachment={att} />
            ))}
          </div>
        )}

        {isUser ? (
          msg.content ? (
            <UserMessageContent text={msg.content} />
          ) : null
        ) : (
          <div className='markdown'>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        {msg.created_at && (
          <div className={`text-[10px] text-text-muted/50 mt-1 flex items-center gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {formatTime(msg.created_at)}
            <CopyButton getText={() => msg.content} />
          </div>
        )}
      </div>
    </div>
  )
}

const URL_REGEX = /(https?:\/\/[^\s<>)"']+)/g
const NOTIFY_ARTICLE_REGEX =
  /<article data-jarvis="notify-prompt">([\s\S]*?)<\/article>\n?/

function UserMessageContent({ text }: { text: string }) {
  const match = text.match(NOTIFY_ARTICLE_REGEX)
  if (!match) return <Linkify text={text} />

  const articleContent = match[1].trim()
  const rest = text.replace(NOTIFY_ARTICLE_REGEX, '').trim()
  return (
    <>
      <CollapsibleArticle label='Notification hint'>
        {articleContent}
      </CollapsibleArticle>
      {rest && <Linkify text={rest} />}
    </>
  )
}

function CollapsibleArticle({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className='mb-2 text-xs'>
      <button
        onClick={() => setOpen(!open)}
        className='flex items-center gap-1 text-text-muted/70 hover:text-text-muted transition-colors'
      >
        <ChevronRight
          size={10}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span>{label}</span>
      </button>
      {open && (
        <div className='mt-1 ml-3 whitespace-pre-wrap text-text-muted/80'>
          {children}
        </div>
      )}
    </div>
  )
}

function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_REGEX)
  return (
    <span className='whitespace-pre-wrap'>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <a
            key={i}
            href={part}
            target='_blank'
            rel='noopener noreferrer'
            className='underline break-all'
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </span>
  )
}

function translateSrc(src?: string): string {
  if (!src) return ''
  return src.replace(/^\/(?:jarvis\/(?:agent\/)?)?workspace\/uploads\//, '/api/uploads/files/')
}

// Exported so the live-streaming view can render partial text through the exact
// same renderer. Matching them matters: if streamed text rendered differently
// from the persisted message, the handoff at the end of a block would visibly
// re-layout instead of just... continuing.
export const markdownComponents = {
  article: ({ children, ...props }: React.HTMLAttributes<HTMLElement> & Record<string, unknown>) => {
    if ('data-details' in props || 'dataDetails' in props) {
      return <CollapsibleArticle label='Details'>{children}</CollapsibleArticle>
    }
    return <article {...props}>{children}</article>
  },
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className='overflow-x-auto mb-3'>
      <table {...props}>{children}</table>
    </div>
  ),
  pre: CodeBlockWrapper,
  img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
    const translated = translateSrc(src)
    return (
      <a
        href={translated}
        target='_blank'
        rel='noopener noreferrer'
        className='block my-2'
      >
        <img
          src={translated}
          alt={alt || ''}
          className='max-w-full max-h-[400px] rounded-lg border border-border'
          {...props}
        />
      </a>
    )
  },
  a: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const translated = translateSrc(href)
    return (
      <a href={translated} target='_blank' rel='noopener noreferrer' {...props}>
        {children}
      </a>
    )
  },
}

function CodeBlockWrapper({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  function handleCopy() {
    const text = preRef.current?.textContent || ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className='relative group/code'>
      <pre ref={preRef} {...props}>{children}</pre>
      <button
        onClick={handleCopy}
        className='absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity p-1.5 rounded-md bg-surface2 hover:bg-border text-text-muted hover:text-text-primary'
        title='Copy code'
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mimetype.startsWith('image/')

  if (isImage) {
    return (
      <a
        href={attachment.url}
        target='_blank'
        rel='noopener noreferrer'
        className='block'
      >
        <img
          src={attachment.url}
          alt={attachment.originalName}
          className='max-w-[240px] max-h-[200px] rounded-lg object-cover border border-border'
        />
      </a>
    )
  }

  return (
    <a
      href={attachment.url}
      target='_blank'
      rel='noopener noreferrer'
      className='flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg hover:bg-surface transition-colors'
    >
      <FileText size={16} className='text-text-muted shrink-0' />
      <span className='text-xs text-text-primary truncate max-w-[180px]'>
        {attachment.originalName}
      </span>
    </a>
  )
}
