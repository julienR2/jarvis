import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Bell, BellOff, Blocks, Brain, Check, Code2, Copy, Globe, KeyRound, LogOut, Plug, RefreshCw, Send, Smartphone, Sparkles,
} from 'lucide-react'
import ContentLayout from '../components/ContentLayout'
import ConnectorsPanel from '../components/ConnectorsPage'
import ApiKeysPanel from '../components/ApiKeysPage'
import PluginsPanel from '../components/PluginsPage'
import { ProviderConnections } from '../components/ConnectionPage'
import { useTheme, type Preference } from '../hooks/useTheme'
import { useNotifications } from '../hooks/useNotifications'
import { reloadApp } from '../lib/reload'
import { BASE_PATH } from '../base'
import { api } from '../api'

/**
 * Everything that is set once and checked rarely, in one place.
 *
 * Eight sidebar entries became one: crons and webhooks became routines with a
 * page of their own, and what is left folds into four tabs behind an overview. Nothing
 * was removed — the connectors, the API keys, the plugins are the same panels
 * as before, minus their own page chrome — there is just less surface to scan
 * before finding the one setting you came for. The tab lives in the URL so the
 * old addresses (/connectors, /api-keys, …) can land on the right one.
 */
type Tab = 'overview' | 'connectors' | 'models' | 'access' | 'advanced'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'models', label: 'Models' },
  { id: 'access', label: 'Access' },
  { id: 'advanced', label: 'Advanced' },
]

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v)
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = isTab(raw) ? raw : 'overview'
  const setTab = (t: Tab) =>
    setParams((p) => { if (t === 'overview') p.delete('tab'); else p.set('tab', t); return p }, { replace: true })

  return (
    <ContentLayout title='Settings'>
      <div className='max-w-3xl mx-auto px-4 md:px-6 py-4'>
        {/* Scrolls sideways on a phone; overflow-x alone would also let the 1px tab
            underline overflow downwards, and a strip of chips wants no visible bar. */}
        <div
          className='flex gap-1 border-b border-border mb-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          role='tablist'
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role='tab'
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 whitespace-nowrap transition-colors ${
                tab === t.id ? 'border-text-primary text-text-primary font-medium' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'overview' && <Overview onOpen={setTab} />}
        {tab === 'connectors' && <ConnectorsPanel />}
        {tab === 'models' && <Models />}
        {tab === 'access' && <Access />}
        {tab === 'advanced' && <Advanced />}
      </div>
    </ContentLayout>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function Overview({ onOpen }: { onOpen: (t: Tab) => void }) {
  const [connectorCount, setConnectorCount] = useState<number | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.getConnectors().then((c) => setConnectorCount(c.length)).catch(() => {})
  }, [])

  function logout() {
    localStorage.removeItem('token')
    navigate('/login')
  }

  return (
    <div className='flex flex-col gap-6'>
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <OverviewCard
          icon={<Plug size={15} />}
          title='Connectors'
          count={connectorCount}
          text='Credentials Jarvis can use: mail, git, drive, databases…'
          onClick={() => onOpen('connectors')}
        />
        <OverviewCard
          icon={<Brain size={15} />}
          title='Models'
          text='Where Jarvis thinks: Claude subscription, gateway providers, the default model for new chats.'
          onClick={() => onOpen('models')}
        />
        <OverviewCard
          icon={<KeyRound size={15} />}
          title='Access'
          text='API keys for scripts and other apps; how this device is connected.'
          onClick={() => onOpen('access')}
        />
        <OverviewCard
          icon={<Blocks size={15} />}
          title='Advanced'
          text='Plugins, the code browser, the headful browser. The techy stuff, one level deeper.'
          onClick={() => onOpen('advanced')}
        />
      </div>

      <section>
        <SectionTitle>Appearance &amp; behaviour</SectionTitle>
        <Card>
          <ThemeRow />
          <NotificationsRow />
        </Card>
      </section>

      <section>
        <SectionTitle>Account</SectionTitle>
        <Card>
          <Row label='Reload the app' hint='Drops cached assets — use it after Jarvis updated itself.'>
            <SmallButton onClick={reloadApp} icon={<RefreshCw size={13} />}>Reload</SmallButton>
          </Row>
          <Row label='Setup wizard' hint='The first-run tour: connection, connectors, a first chat.'>
            <SmallButton onClick={() => navigate('/onboarding')} icon={<Sparkles size={13} />}>Open</SmallButton>
          </Row>
          <Row label='Signed in on this device'>
            <SmallButton onClick={logout} icon={<LogOut size={13} />}>Log out</SmallButton>
          </Row>
        </Card>
      </section>
    </div>
  )
}

function OverviewCard({
  icon, title, count, text, onClick,
}: {
  icon: React.ReactNode
  title: string
  count?: number | null
  text: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className='text-left rounded-2xl border border-border bg-surface px-4 py-3.5 hover:border-accent/40 hover:bg-surface2/60 transition-colors'
    >
      <div className='flex items-center gap-2 text-sm font-medium text-text-primary mb-1'>
        <span className='text-text-muted'>{icon}</span>
        {title}
        {typeof count === 'number' && <span className='text-xs font-normal text-text-muted'>{count}</span>}
      </div>
      <p className='text-xs text-text-muted leading-relaxed'>{text}</p>
    </button>
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

// ── Models ───────────────────────────────────────────────────────────────────

function Models() {
  return (
    <section>
      <SectionTitle>Model providers</SectionTitle>
      <ProviderConnections />
    </section>
  )
}

// ── Access ───────────────────────────────────────────────────────────────────

function Access() {
  return (
    <div className='flex flex-col gap-8'>
      <section>
        <SectionTitle>API keys</SectionTitle>
        <ApiKeysPanel />
      </section>
      <section>
        <SectionTitle>Connection</SectionTitle>
        <ConnectionCard />
      </section>
    </div>
  )
}

/** Where this Jarvis lives and how this device reaches it — the facts a new phone or script needs. */
function ConnectionCard() {
  const url = `${window.location.origin}${BASE_PATH}/`
  const [copied, setCopied] = useState(false)
  const installed = window.matchMedia('(display-mode: standalone)').matches

  function copy() {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <Row label='Address' hint={url}>
        <SmallButton onClick={copy} icon={copied ? <Check size={13} /> : <Copy size={13} />}>
          {copied ? 'Copied' : 'Copy'}
        </SmallButton>
      </Row>
      <Row
        label='Installed as an app'
        hint={installed ? 'Running from the home screen.' : 'Open in the browser — install it from the browser menu for a home-screen icon and push.'}
      >
        <span className='inline-flex items-center gap-1.5 text-xs text-text-muted'>
          <Smartphone size={13} /> {installed ? 'Yes' : 'No'}
        </span>
      </Row>
    </Card>
  )
}

// ── Advanced ─────────────────────────────────────────────────────────────────

function Advanced() {
  const navigate = useNavigate()
  return (
    <div className='flex flex-col gap-8'>
      <section>
        <SectionTitle>Tools</SectionTitle>
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
          <OverviewCard
            icon={<Code2 size={15} />}
            title='Code'
            text="Jarvis's own source, config and commits, browsable."
            onClick={() => navigate('/code')}
          />
          <OverviewCard
            icon={<Globe size={15} />}
            title='Browser'
            text='The headful Chromium — for the logins and captchas Jarvis cannot pass alone.'
            onClick={() => navigate('/browser')}
          />
        </div>
      </section>
      <section>
        <SectionTitle>Plugins</SectionTitle>
        <PluginsPanel />
      </section>
    </div>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className='text-xs font-medium text-text-muted uppercase tracking-wide mb-2'>{children}</h2>
}

function Card({ children }: { children: React.ReactNode }) {
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
