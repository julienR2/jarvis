import { Paperclip } from 'lucide-react'

/** What goes out with a text besides its body — each empty when not given. */
export interface Envelope {
  to?: string
  cc?: string
  subject?: string
  attachments?: string[]
}

export function hasEnvelope(e: Envelope): boolean {
  return !!(e.to || e.cc || e.subject || e.attachments?.length)
}

/**
 * Who a text goes to, its subject and its files, in full — above a draft being
 * reviewed (ReviewCard) and above it once approved (the person's bubble). Every
 * line wraps: approving a text is approving where it goes, so none of it may
 * hide behind an ellipsis.
 */
export default function DraftEnvelope({ envelope, className = '' }: { envelope: Envelope; className?: string }) {
  if (!hasEnvelope(envelope)) return null
  const { to, cc, subject, attachments = [] } = envelope
  return (
    <dl
      className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[12.5px] leading-snug ${className}`}
      data-testid='draft-envelope'
    >
      {to && <Row label='To'>{to}</Row>}
      {cc && <Row label='Cc'>{cc}</Row>}
      {subject && <Row label='Subject'><span className='font-medium text-text-primary'>{subject}</span></Row>}
      {attachments.length > 0 && (
        <Row label='Attached'>
          <span className='flex flex-wrap gap-1'>
            {attachments.map((name, i) => (
              <span
                key={i}
                className='inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[12px] text-text-secondary'
              >
                <Paperclip size={11} className='shrink-0' />
                <span className='break-words'>{name}</span>
              </span>
            ))}
          </span>
        </Row>
      )}
    </dl>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className='text-text-muted'>{label}</dt>
      <dd className='min-w-0 break-words text-text-secondary'>{children}</dd>
    </>
  )
}
