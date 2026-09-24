import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Bell, BellOff, Check, Copy, LogOut, RefreshCw, Send, Sparkles } from 'lucide-react'
import ContentLayout from '../components/ContentLayout'
import ApiKeysPanel from '../components/ApiKeysPage'
import { useTheme, type Preference } from '../hooks/useTheme'
import { useNotifications } from '../hooks/useNotifications'
import { reloadApp } from '../lib/reload'
import { BASE_PATH } from '../base'
import { api } from '../api'

/**
 * Settings › General: how the app looks and behaves, API keys, the account.
 *
 * Settings is a menu now (the sidebar's gear), not a page of tabs: General,
 * Customize (models, connectors, skills), Routines, Browser, Code. The old
 * tab addresses still land where their content went.
 */
const LEGACY_TABS: Record<string, string> = {
  connectors: '/settings/customize?tab=connectors',
  models: '/settings/customize?tab=models',
}

export default function SettingsPage() {
  const [params] = useSearchParams()
  const legacy = LEGACY_TABS[params.get('tab') ?? '']
  if (legacy) return <Navigate to={legacy} replace />

  return (
    <ContentLayout title='General'>
      <div className='flex flex-col gap-8'>
        <section>
          <SectionTitle>Appearance &amp; behaviour</SectionTitle>
          <Card>
            <ThemeRow />
            <NotificationsRow />
          </Card>
        </section>

        <section>
          <SectionTitle>API keys</SectionTitle>
          <ApiKeysPanel />
        </section>

        <section>
          <SectionTitle>Account</SectionTitle>
          <AccountCard />
        </section>
      </div>
    </ContentLayout>
  )
}

function AccountCard() {
  const navigate = useNavigate()
  const url = `${window.location.origin}${BASE_PATH}/`
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function logout() {
    localStorage.removeItem('token')
    navigate('/login')
  }

  return (
    <Card>
      <Row label='Address' hint={url}>
        <SmallButton onClick={copy} icon={copied ? <Check size={13} /> : <Copy size={13} />}>
          {copied ? 'Copied' : 'Copy'}
        </SmallButton>
      </Row>
      <Row label='Reload the app' hint='Drops cached assets — use it after Jarvis updated itself.'>
        <SmallButton onClick={reloadApp} icon={<RefreshCw size={13} />}>Reload</SmallButton>
      </Row>
      <Row label='Setup wizard'>
        <SmallButton onClick={() => navigate('/onboarding')} icon={<Sparkles size={13} />}>Open</SmallButton>
      </Row>
      <Row label='Signed in on this device'>
        <SmallButton onClick={logout} icon={<LogOut size={13} />}>Log out</SmallButton>
      </Row>
    </Card>
  )
}

const THEMES: { id: Preference; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

function ThemeRow() {
  const { preference, setPreference } = useTheme()
  return (
    <Row label='Theme'>
      <div className='flex rounded-lg border border-border bg-bg p-0.5' role='radiogroup' aria-label='Theme'>
        {THEMES.map((t) => (
          <button
            key={t.id}
            role='radio'
            aria-checked={preference === t.id}
            onClick={() => setPreference(t.id)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              preference === t.id ? 'bg-surface text-text-primary shadow-sm font-medium' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Row>
  )
}

/**
 * Push permission is the browser's to grant, so the row can only ask once and
 * then report — "On", "Blocked" (reset it in the site settings), or the button.
 */
function NotificationsRow() {
  const { permission, requestPermission } = useNotifications()
  const supported = 'Notification' in window
  const [testing, setTesting] = useState(false)
  // One push to every registered device: the way to know this one hears
  // Jarvis, and the backend drops the subscriptions that no longer work.
  async function sendTest() {
    setTesting(true)
    try {
      const { delivered } = await api.testPush()
      if (delivered) window.__jarvisToast?.success(`Sent to ${delivered} device${delivered > 1 ? 's' : ''}.`)
      else window.__jarvisToast?.info('No device is subscribed yet — enable notifications on one first.')
    } catch {
      window.__jarvisToast?.error('Could not send the test notification.')
    } finally {
      setTesting(false)
    }
  }
  return (
    <Row
      label='Notifications'
      hint={
        !supported
          ? 'Not available in this browser.'
          : permission === 'denied'
            ? 'Blocked by the browser — allow them in the site settings to turn them back on.'
            : 'A push when a routine finishes or needs you, if the chat asks for it.'
      }
    >
      {!supported ? null : permission === 'granted' ? (
        <span className='inline-flex items-center gap-3'>
          <span className='inline-flex items-center gap-1.5 text-xs text-success'>
            <Bell size={13} /> On
          </span>
          <SmallButton onClick={sendTest} disabled={testing} icon={<Send size={13} />}>Send a test</SmallButton>
        </span>
      ) : permission === 'denied' ? (
        <span className='inline-flex items-center gap-1.5 text-xs text-text-muted'>
          <BellOff size={13} /> Blocked
        </span>
      ) : (
        <SmallButton onClick={requestPermission} icon={<Bell size={13} />}>Enable</SmallButton>
      )}
    </Row>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────────────

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className='text-xs font-medium text-text-muted uppercase tracking-wide mb-2'>{children}</h2>
}

export function Card({ children }: { children: React.ReactNode }) {
  return <div className='rounded-2xl border border-border bg-surface divide-y divide-border'>{children}</div>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 px-4 py-3'>
      <div className='min-w-0'>
        <div className='text-sm text-text-primary'>{label}</div>
        {hint && <div className='text-xs text-text-muted truncate'>{hint}</div>}
      </div>
      <div className='shrink-0'>{children}</div>
    </div>
  )
}

function SmallButton({ onClick, icon, children, disabled }: { onClick: () => void; icon?: React.ReactNode; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className='inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1 text-xs text-text-primary hover:border-accent transition-colors disabled:opacity-50'
    >
      {icon}
      {children}
    </button>
  )
}
