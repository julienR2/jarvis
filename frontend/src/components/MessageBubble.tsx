import { useMemo, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, ChevronRight, Copy, Check } from 'lucide-react'
import type { Message, Attachment } from '../api'

interface Props {
  msg: Message
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

interface ParsedLines {
  activityLines: { prefix: 'tool' | 'chunk'; text: string }[]
}

function parseActivityContent(content: string): ParsedLines {
  // Split into entries — each starts with [tool] or [chunk], may span multiple paragraphs
  const paragraphs = content.split('\n\n')
  const activityLines: ParsedLines['activityLines'] = []

  for (const para of paragraphs) {
    if (para.startsWith('[tool] ')) {
      activityLines.push({ prefix: 'tool', text: para.slice(7) })
    } else if (para.startsWith('[chunk] ')) {
      activityLines.push({ prefix: 'chunk', text: para.slice(8) })
    } else if (activityLines.length > 0) {
      // Continuation of previous entry (multiline tool/chunk)
      activityLines[activityLines.length - 1].text += '\n\n' + para
    }
  }

  return { activityLines }
}

function hasActivityLines(content: string): boolean {
  return content.startsWith('[tool] ') || content.startsWith('[chunk] ')
}

function ActivityBubble({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false)
  const { activityLines } = useMemo(
    () => parseActivityContent(msg.content),
    [msg.content],
  )

  const hasResult = !!msg.result
  // Before result: collapsible = tools, visible = chunks
  // After result: collapsible = tools + chunks, visible = result
  // Always strip the last chunk from the collapsible — it's likely the result
  let lastChunkIdx = -1
  for (let i = activityLines.length - 1; i >= 0; i--) {
    if (activityLines[i].prefix === 'chunk') { lastChunkIdx = i; break }
  }
  const stepsLines =
    lastChunkIdx >= 0
      ? activityLines.filter((_, i) => i !== lastChunkIdx)
      : activityLines
  const collapsibleLines = hasResult
    ? stepsLines
    : stepsLines.filter((l) => l.prefix === 'tool')
  const visibleChunks = hasResult
    ? []
    : activityLines.filter((l) => l.prefix === 'chunk')

  return (
    <div className='flex items-start mb-5 animate-fade-in'>
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
                  <li
                    key={i}
                    className={
                      line.prefix === 'tool'
                        ? 'text-text-muted'
                        : 'text-text-primary'
                    }
                  >
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Visible section: chunks while streaming, result when done */}
        {hasResult ? (
          <div className='markdown text-base leading-relaxed'>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {msg.result!}
            </ReactMarkdown>
          </div>
        ) : visibleChunks.length > 0 ? (
          <div className='markdown text-base leading-relaxed'>
            {visibleChunks.map((line, i) => (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {line.text}
              </ReactMarkdown>
            ))}
          </div>
        ) : null}
        {msg.created_at && (hasResult || visibleChunks.length > 0) && (
          <div className='text-[10px] text-text-muted/50 mt-1'>{formatTime(msg.created_at)}</div>
        )}
      </div>
    </div>
  )
}

export default function MessageBubble({ msg }: Props) {
  const isUser = msg.role === 'user'

  // Assistant message with [tool]/[chunk] lines → activity bubble
  if (!isUser && hasActivityLines(msg.content)) {
    return <ActivityBubble msg={msg} />
  }

  const attachments = useMemo(
    () => parseAttachments(msg.metadata),
    [msg.metadata],
  )

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
            <Linkify text={msg.content} />
          ) : null
        ) : (
          <div className='markdown'>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        {msg.created_at && (
          <div className={`text-[10px] text-text-muted/50 mt-1 ${isUser ? 'text-right' : 'text-left'}`}>
            {formatTime(msg.created_at)}
          </div>
        )}
      </div>
    </div>
  )
}

const URL_REGEX = /(https?:\/\/[^\s<>)"']+)/g

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
  return src
    .replace(/^\/(?:jarvis\/)?workspace\/uploads\//, '/api/uploads/files/')
    .replace(/^\/drive\//, '/api/drive/files/')
}

const markdownComponents = {
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
