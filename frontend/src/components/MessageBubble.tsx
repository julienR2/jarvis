import { useLayoutEffect, useMemo, useState, useRef } from 'react'
import { API_BASE } from '../base'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { FileText, ChevronRight, Copy, Check } from 'lucide-react'
import { withMediaToken } from '../api'
import type { Message, Attachment, ReplyTo } from '../api'
import type { Components, ExtraProps } from 'react-markdown'

interface Props {
  msg: Message
  /** This message is the turn currently being written — see ActivityBubble. */
  live?: boolean
  /** Shown beside the time: the model that answered, when it just changed. */
  modelLabel?: string
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
  // Copy what's on screen: the prose, never the steps.
  return buildGroups(parseActivityContent(msg.content).activityLines, msg.result)
    .flatMap((g) => (g.kind === 'prose' ? [g.text] : []))
    .join('\n\n')
}

function parseReplyTo(metadata?: string | null): ReplyTo | null {
  if (!metadata) return null
  try {
    const r = JSON.parse(metadata).reply_to
    return r && typeof r.message_id === 'string' && typeof r.text === 'string' ? r : null
  } catch {
    return null
  }
}

/**
 * The passage a user message replies to, above its text. Clicking it leads
 * back to the source message when it is loaded — a brief highlight says which.
 */
function ReplyCitation({ quote }: { quote: ReplyTo }) {
  function jump() {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${quote.message_id}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('bg-accent-subtle/60', 'rounded-2xl')
    setTimeout(() => el.classList.remove('bg-accent-subtle/60', 'rounded-2xl'), 1200)
  }
  return (
    <button
      type='button'
      onClick={jump}
      data-testid='reply-citation'
      title='Go to the passage'
      className='mb-2 block w-full border-l-2 border-accent/50 pl-2.5 text-left text-[13px] leading-snug text-text-secondary line-clamp-3 hover:text-text-primary transition-colors'
    >
      {quote.text}
    </button>
  )
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

interface ActivityLine {
  prefix: ActivityPrefix
  /**
   * Which assistant message this line came from, when the backend recorded it.
   * Undefined for messages written before the marker carried it — those still
   * render, they just can't say where one message ended and the next began.
   */
  group?: number
  text: string
}

interface ParsedLines {
  activityLines: ActivityLine[]
}

/**
 * A turn as it is displayed: prose blocks, and the runs of activity between
 * them.
 */
type ActivityGroup =
  | { kind: 'prose'; text: string }
  | { kind: 'steps'; cycles: Cycle[] }

type StepsGroup = Extract<ActivityGroup, { kind: 'steps' }>

/**
 * One think-then-act pass: what Jarvis said, and the steps it took after saying
 * it. `group` is the assistant message it came from, or undefined for a legacy
 * line — kept so a following line can tell whether it belongs to the same pass.
 */
interface Cycle {
  group?: number
  notes: string[]
  tools: string[]
}

/**
 * Whether `line` continues the pass `cycle` describes, or starts a new one.
 *
 * Two signals, and either one is enough. The group id is the reliable one: a
 * different assistant message is a different pass, whatever it contains. The
 * note-after-tool check covers lines stored before groups existed, and is
 * sound on its own — within a single message the reasoning block is emitted
 * before the tool calls it introduces, so a note arriving *after* a tool can
 * only be a new pass.
 */
function continuesCycle(cycle: Cycle, line: ActivityLine): boolean {
  if (cycle.group !== line.group) return false
  return !(line.prefix === 'note' && cycle.tools.length > 0)
}

/**
 * Fold the activity lines into display groups, in the order they happened.
 *
 * The lines are already a faithful timeline — appendLine appends them as the
 * events arrive — and what this replaced threw that away by filtering into
 * buckets, so a turn read as if every tool call had happened before Jarvis
 * wrote a single word.
 *
 * Prose stands alone, at full weight. Notes and tool calls fold into the run
 * between two prose blocks, and that run is cut into cycles so each note keeps
 * the steps it actually introduced — the pairing a bare timeline can't express
 * and a single bucket gets wrong the moment a turn thinks twice.
 */
function buildGroups(
  lines: ActivityLine[],
  result?: string | null,
): ActivityGroup[] {
  const remaining = [...lines]
  // The last chunk repeats the result verbatim — drop it rather than show the
  // answer twice.
  if (result) {
    const lastChunk = remaining.map((l) => l.prefix).lastIndexOf('chunk')
    if (lastChunk >= 0) remaining.splice(lastChunk, 1)
  }

  const groups: ActivityGroup[] = []
  for (const line of remaining) {
    if (line.prefix === 'chunk') {
      groups.push({ kind: 'prose', text: line.text })
      continue
    }
    const last = groups[groups.length - 1]
    const steps: StepsGroup =
      last?.kind === 'steps' ? last : { kind: 'steps', cycles: [] }
    if (steps !== last) groups.push(steps)

    const open = steps.cycles[steps.cycles.length - 1]
    const cycle =
      open && continuesCycle(open, line)
        ? open
        : { group: line.group, notes: [], tools: [] }
    if (cycle !== open) steps.cycles.push(cycle)

    if (line.prefix === 'note') cycle.notes.push(line.text)
    else cycle.tools.push(line.text)
  }

  if (result) groups.push({ kind: 'prose', text: result })
  return groups
}

// Longest-first is not needed here (no prefix is a prefix of another), but the
// lengths are derived rather than hardcoded so a rename can't desync the slice.
const ACTIVITY_PREFIXES: ActivityPrefix[] = ['tool', 'chunk', 'note']

// `[note] ` or `[note:7] ` — the group is optional so lines written before it
// existed keep parsing.
const ACTIVITY_MARKER = new RegExp(
  `^\\[(${ACTIVITY_PREFIXES.join('|')})(?::(\\d+))?\\] `,
)

function parseActivityContent(content: string): ParsedLines {
  // Split into entries — each starts with a [tool], [chunk] or [note] marker,
  // and may span multiple paragraphs.
  const paragraphs = content.split('\n\n')
  const activityLines: ParsedLines['activityLines'] = []

  for (const para of paragraphs) {
    const match = para.match(ACTIVITY_MARKER)
    if (match) {
      activityLines.push({
        prefix: match[1] as ActivityPrefix,
        group: match[2] === undefined ? undefined : Number(match[2]),
        text: para.slice(match[0].length),
      })
    } else if (activityLines.length > 0) {
      // Continuation of previous entry (multiline tool/chunk/note)
      activityLines[activityLines.length - 1].text += '\n\n' + para
    }
  }

  return { activityLines }
}

function hasActivityLines(content: string): boolean {
  return ACTIVITY_MARKER.test(content)
}

/**
 * What Jarvis is on while a turn runs — his latest note when he wrote one,
 * otherwise the step itself ("Reading skills/email-processor/SKILL.md"). Null
 * once the turn is back to writing prose. The chat draws it next to the Jarvis
 * loader at the foot of the list, not in the bubble: no count, nothing to
 * unfold, the steps are not a level of detail the chat keeps.
 */
export function liveStatus(msg: Message): { note: string | null; tool: string | null } | null {
  if (msg.role === 'user' || !hasActivityLines(msg.content)) return null
  const groups = buildGroups(parseActivityContent(msg.content).activityLines, msg.result)
  const last = groups[groups.length - 1]
  if (last?.kind !== 'steps') return null
  const cycle = last.cycles[last.cycles.length - 1]
  return { note: cycle.notes[cycle.notes.length - 1] ?? null, tool: cycle.tools[cycle.tools.length - 1] ?? null }
}

function ActivityBubble({ msg, live, modelLabel }: { msg: Message; live?: boolean; modelLabel?: string }) {
  const groups = useMemo(
    () => buildGroups(parseActivityContent(msg.content).activityLines, msg.result),
    [msg.content, msg.result],
  )
  // Only the answer is drawn. What Jarvis is on shows by the loader below the
  // list while the turn runs (see liveStatus), and leaves no trace after.
  const prose = groups.filter((g) => g.kind === 'prose')

  if (!prose.length) return null
  return (
    // Same anchor as the plain bubble: a selection in a real answer (which
    // nearly always carries activity lines and lands here) must be replyable.
    <div data-message-id={msg.id} className='flex items-start mb-5 animate-fade-in group transition-colors'>
      <div className='max-w-full min-w-0'>
        {prose.map((g, i) => (
          <div key={i} className='markdown text-base leading-relaxed mb-3'>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {g.text}
            </ReactMarkdown>
          </div>
        ))}
        {/* No time while the turn runs — it appears once the answer is done. */}
        {msg.created_at && !live && (
          <div className='text-[10px] text-text-muted/50 mt-1 flex items-center gap-1.5'>
            {formatTime(msg.created_at)}
            {modelLabel && <span>· {modelLabel}</span>}
            <CopyButton getText={() => getAssistantCopyText(msg)} />
          </div>
        )}
      </div>
    </div>
  )
}

export default function MessageBubble({ msg, live, modelLabel }: Props) {
  const isUser = msg.role === 'user'
  // Above the early return — a hook must not sit on one side of a conditional
  // return, or the first message whose content grows into activity lines takes
  // the whole list down with a hook-order error.
  const attachments = useMemo(
    () => parseAttachments(msg.metadata),
    [msg.metadata],
  )
  const replyTo = useMemo(() => parseReplyTo(msg.metadata), [msg.metadata])

  // Assistant message with [tool]/[chunk]/[note] lines → activity bubble
  if (!isUser && hasActivityLines(msg.content)) {
    return <ActivityBubble msg={msg} live={live} modelLabel={modelLabel} />
  }

  return (
    <div
      // The anchor a reply's citation leads back to, and what tells a text
      // selection which message it sits in.
      data-message-id={msg.id}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-5 animate-fade-in transition-colors`}
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
        {isUser && replyTo && <ReplyCitation quote={replyTo} />}

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
        {/* An answer being written has no time yet — it gets one once the turn ends. */}
        {msg.created_at && (isUser || !live) && (
          <div className={`text-[10px] text-text-muted/50 mt-1 flex items-center gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {formatTime(msg.created_at)}
            {!isUser && modelLabel && <span>· {modelLabel}</span>}
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
  return withMediaToken(
    src.replace(/^\/(?:jarvis\/(?:agent\/)?)?workspace\/uploads\//, `${API_BASE}/uploads/files/`),
  )
}

// Exported so the live-streaming view can render partial text through the exact
// same renderer. Matching them matters: if streamed text rendered differently
// from the persisted message, the handoff at the end of a block would visibly
// re-layout instead of just... continuing.
/** Prose the way an assistant message renders it — for summaries shown outside a bubble. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const markdownComponents: Components = {
  article: ({ children, node: _node, ...props }) => {
    if ('data-details' in props || 'dataDetails' in props) {
      return <CollapsibleArticle label='Details'>{children}</CollapsibleArticle>
    }
    return <article {...props}>{children}</article>
  },
  table: ({ children, node: _node, ...props }) => (
    <div className='overflow-x-auto mb-3'>
      <table {...props}>{children}</table>
    </div>
  ),
  pre: CodeBlockWrapper,
  img: ({ src, alt, node: _node, ...props }) => {
    const translated = translateSrc(src)
    // The media skill tells the agent to reference generated files with image
    // markdown, so a clip arrives as ![desc](….mp4) and rendered as an <img>
    // it was simply a broken image.
    const playable = mediaKindFromSrc(translated)
    if (playable) {
      return <MediaPlayer src={translated} kind={playable} title={alt || undefined} />
    }
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
  a: ({ href, children, node: _node, ...props }) => {
    const translated = translateSrc(href)
    return (
      <a href={translated} target='_blank' rel='noopener noreferrer' {...props}>
        {children}
      </a>
    )
  },
}

function CodeBlockWrapper({
  children,
  node: _node,
  ...props
}: React.ComponentPropsWithoutRef<'pre'> & ExtraProps) {
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

/**
 * What kind of player a URL wants, by extension. Used where there is no
 * mimetype to go on — the agent references generated files as markdown, so an
 * mp4 arrives looking exactly like an image.
 */
function mediaKindFromSrc(src?: string): 'video' | 'audio' | null {
  const path = (src ?? '').split('?')[0]
  if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return 'video'
  if (/\.(mp3|wav|ogg|opus|m4a|aac)$/i.test(path)) return 'audio'
  return null
}

/**
 * Video and audio play in place.
 *
 * Before this they fell through to the generic file link, so a generated clip
 * arrived as something to download rather than something to watch. Deliberately
 * `controls` + `preload='metadata'`: no autoplay, and no poster frame to fetch,
 * so scrolling a long transcript doesn't pull megabytes of video it may never
 * show. The uploads route answers Range requests, so seeking works.
 *
 * Not wrapped in a link, unlike the image preview — clicking the player has to
 * mean play, not navigate.
 */
function MediaPlayer({
  src,
  kind,
  title,
}: {
  src: string
  kind: 'video' | 'audio'
  title?: string
}) {
  if (kind === 'video') {
    return (
      <video
        src={src}
        controls
        preload='metadata'
        title={title}
        className='block my-2 w-full max-w-[360px] rounded-lg border border-border bg-black'
      />
    )
  }
  return (
    <audio
      src={src}
      controls
      preload='metadata'
      title={title}
      className='block my-2 w-full max-w-[320px]'
    />
  )
}

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mimetype.startsWith('image/')

  // mimetype is authoritative here; fall back to the extension for older rows
  // written before the type was recorded.
  const playable = attachment.mimetype.startsWith('video/')
    ? 'video'
    : attachment.mimetype.startsWith('audio/')
      ? 'audio'
      : mediaKindFromSrc(attachment.url)

  if (playable) {
    return (
      <MediaPlayer
        src={withMediaToken(attachment.url)}
        kind={playable}
        title={attachment.originalName}
      />
    )
  }

  if (isImage) {
    return (
      <a
        href={withMediaToken(attachment.url)}
        target='_blank'
        rel='noopener noreferrer'
        className='block'
      >
        <img
          src={withMediaToken(attachment.url)}
          alt={attachment.originalName}
          className='max-w-[240px] max-h-[200px] rounded-lg object-cover border border-border'
        />
      </a>
    )
  }

  return (
    <a
      href={withMediaToken(attachment.url)}
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
