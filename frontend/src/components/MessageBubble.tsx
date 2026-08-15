import { useLayoutEffect, useMemo, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { FileText, ChevronRight, Copy, Check } from 'lucide-react'
import type { Message, Attachment } from '../api'

interface Props {
  msg: Message
  /** This message is the turn currently being written — see ActivityBubble. */
  live?: boolean
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
  // Copy what's on screen, in the order it's on screen: prose and notes, never
  // the collapsed tool steps.
  return buildGroups(parseActivityContent(msg.content).activityLines, msg.result)
    .flatMap((g) =>
      g.kind === 'prose' ? [g.text] : g.cycles.flatMap((c) => c.notes),
    )
    .join('\n\n')
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

function ActivityBubble({ msg, live }: { msg: Message; live?: boolean }) {
  const groups = useMemo(
    () => buildGroups(parseActivityContent(msg.content).activityLines, msg.result),
    [msg.content, msg.result],
  )
  // Per-cycle override of the default open state, keyed by position. Safe to
  // key on the indices: groups and cycles are only ever appended as a turn goes
  // on, so a position never comes to mean a different cycle.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  // A turn that only ever called tools gets no timestamp row, as before — there
  // is nothing to date but the steps themselves.
  const hasText = groups.some((g) =>
    g.kind === 'prose' ? true : g.cycles.some((c) => c.notes.length > 0),
  )

  return (
    <div className='flex items-start mb-5 animate-fade-in group'>
      <div className='max-w-full min-w-0'>
        {groups.map((g, i) => {
          if (g.kind === 'prose') {
            return (
              <div key={i} className='markdown text-base leading-relaxed mb-3'>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
                  components={markdownComponents}
                >
                  {g.text}
                </ReactMarkdown>
              </div>
            )
          }
          // The cycle in progress stays open, so what Jarvis is doing right now
          // is readable without a click; it folds itself away when the turn
          // moves on to the next cycle, or ends.
          const liveCycle =
            !!live && i === groups.length - 1 ? g.cycles.length - 1 : -1
          return (
            <StepsBlock
              key={i}
              cycles={g.cycles}
              isOpen={(j) => toggled[`${i}:${j}`] ?? j === liveCycle}
              onToggle={(j, open) =>
                setToggled((t) => ({ ...t, [`${i}:${j}`]: !open }))
              }
            />
          )
        })}
        {msg.created_at && hasText && (
          <div className='text-[10px] text-text-muted/50 mt-1 flex items-center gap-1.5'>
            {formatTime(msg.created_at)}
            <CopyButton getText={() => getAssistantCopyText(msg)} />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Whether a click on a block of text was meant for the block itself.
 *
 * Notes and steps fold on a press anywhere in them, which is only pleasant if
 * it stays out of the way of the two things a press can also mean: following a
 * link (or working the toggle, which handles itself and would otherwise fire
 * twice), and selecting text — releasing the mouse after a selection is not a
 * request to fold away what was just selected.
 */
function isPlainClick(e: React.MouseEvent): boolean {
  if ((e.target as HTMLElement).closest('a, button')) return false
  return !window.getSelection()?.toString()
}

// Three lines at text-[13px]/leading-snug, which is where a reasoning summary
// stops being a glanceable label and starts being a wall.
const NOTE_CLAMP_PX = 54

/**
 * A note, capped to a few lines until asked to open.
 *
 * Capped by max-height rather than -webkit-line-clamp: notes are markdown, and
 * line-clamp needs `display: -webkit-box`, which flattens the paragraphs and
 * lists a reasoning summary arrives with into one run of text.
 *
 * The overflow is measured rather than guessed, so the toggle appears only on
 * notes that actually lost something — most notes are a line or two, and an
 * unconditional "show more" under every one of them would be the noise this is
 * meant to remove. Measurement is skipped while expanded, where the element is
 * its own full height and would report itself unclamped, taking the toggle away
 * with no way back.
 */
function ClampedNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])

  const toggle = () => setExpanded((e) => !e)

  return (
    <div
      className={clamped ? 'cursor-pointer' : undefined}
      onClick={clamped ? (e) => isPlainClick(e) && toggle() : undefined}
    >
      {/* The gradient is positioned against the text alone. Anchored to the
          whole component it would also lie over the toggle beneath, fading the
          one thing that has to stay legible. */}
      <div className='relative'>
        <div
          ref={ref}
          className='markdown text-[13px] text-text-muted leading-snug overflow-hidden'
          style={expanded ? undefined : { maxHeight: NOTE_CLAMP_PX }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {text}
          </ReactMarkdown>
        </div>

        {clamped && !expanded && (
          // Fades into the page rather than cutting mid-letter. Purely
          // decorative, and never in the way of the text it sits over.
          <div className='pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-bg to-transparent' />
        )}
      </div>

      {clamped && (
        <button
          onClick={toggle}
          className='mt-0.5 text-[11px] text-text-muted/60 hover:text-text-muted transition-colors'
        >
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  )
}

/**
 * One run of activity between two prose blocks: what Jarvis said it was doing,
 * and the mechanical steps that did it, alternating as they happened.
 *
 * The whole run carries a single rail, so it reads as one block rather than as
 * a stack of unrelated fragments — but each cycle keeps its own toggle, so the
 * steps stay attached to the note that introduced them instead of pooling at
 * the bottom under a note that may have had nothing to do with them.
 *
 * Notes are rendered as markdown like any other prose of his: reasoning
 * summaries come with emphasis and lists, which read as literal asterisks
 * otherwise.
 */
function StepsBlock({
  cycles,
  isOpen,
  onToggle,
}: {
  cycles: Cycle[]
  isOpen: (cycle: number) => boolean
  onToggle: (cycle: number, open: boolean) => void
}) {
  return (
    <div className='mb-3 flex flex-col gap-1.5 border-l-2 border-border pl-3'>
      {cycles.map((cycle, j) => {
        const open = isOpen(j)
        return (
          <div key={j} className='flex flex-col gap-1.5'>
            {cycle.notes.map((text, i) => (
              <ClampedNote key={i} text={text} />
            ))}

            {cycle.tools.length > 0 && (
              // The expanded list folds on a press anywhere in it, so closing a
              // run doesn't mean hunting back up for the one-line header that
              // opened it.
              <div
                className='cursor-pointer'
                onClick={(e) => isPlainClick(e) && onToggle(j, open)}
              >
                <button
                  onClick={() => onToggle(j, open)}
                  className='flex items-center gap-1 text-[11px] text-text-muted/60 hover:text-text-muted transition-colors'
                >
                  <ChevronRight
                    size={10}
                    className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span>
                    {cycle.tools.length} step
                    {cycle.tools.length !== 1 ? 's' : ''}
                  </span>
                </button>
                {open && (
                  <ul className='mt-1 ml-3 flex flex-col gap-0.5 text-xs list-disc list-inside'>
                    {cycle.tools.map((text, i) => (
                      <li key={i} className='text-text-muted'>
                        {text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function MessageBubble({ msg, live }: Props) {
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
    return <ActivityBubble msg={msg} live={live} />
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
