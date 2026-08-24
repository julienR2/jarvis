import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  ExternalLink,
  Terminal,
  Copy,
  Check,
  MessageCircle,
  Zap,
  Clock,
  Globe,
  Mic,
  Puzzle,
  X,
} from 'lucide-react'
import { api } from '../api'

type Step = 'welcome' | 'account' | 'token' | 'launching'

const ONBOARDING_PROMPT = `[ONBOARDING] A new user just finished setting up Jarvis for the first time.

Welcome them warmly and:
1. Introduce yourself briefly — you're Jarvis, their personal AI assistant running on their own server
2. Ask a couple of **optional**, low-pressure questions (their name, what they do, interests) — make very clear these are optional and they can skip
3. Give a concise overview of your key capabilities:
   - Chat about anything, get help with tasks
   - Scheduled automations (crons) — e.g. daily briefings, reminders
   - Webhooks for external triggers (connect to other tools)
   - Voice input (just talk instead of typing)
   - Create mini web apps right in the chat
   - Connect third-party services (Gmail, GitHub, Slack, Linear, etc.)
   - Browse and manage files
4. Suggest 2-3 concrete starter ideas tailored for a new user, and ask what sounds interesting
5. Keep it conversational and not overwhelming — let the user drive

This is their very first interaction with you. Make it feel personal and welcoming, not like a manual.`

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('welcome')
  const [needsSetup, setNeedsSetup] = useState(true)
  const [hasToken, setHasToken] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api.getSetupStatus().then(({ needsSetup: ns, hasToken: ht }) => {
      setNeedsSetup(ns)
      setHasToken(ht)
    }).catch(() => {})
  }, [])

  // Account step state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // Token step state
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [copied, setCopied] = useState(false)

  // Shared state
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function goToNextAfterWelcome() {
    if (needsSetup) {
      setStep('account')
    } else if (!hasToken) {
      setStep('token')
    } else {
      launchOnboardingChat()
    }
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      const { token: jwt } = await api.setup(email, password)
      localStorage.setItem('token', jwt)
      setNeedsSetup(false)
      if (hasToken) {
        await launchOnboardingChat()
      } else {
        setStep('token')
      }
    } catch (err: any) {
      setError(err.message || 'Account creation failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleSaveToken() {
    setError('')
    setLoading(true)
    try {
      await api.setupToken(token.trim())
      await launchOnboardingChat()
    } catch (err: any) {
      setError(err.message || 'Failed to save token')
      setLoading(false)
    }
  }

  async function handleSkipToken() {
    await dismissOnboarding()
  }

  async function dismissOnboarding() {
    if (localStorage.getItem('token')) {
      await api.completeOnboarding().catch(() => {})
      navigate('/', { replace: true })
    } else {
      navigate('/login', { replace: true })
    }
  }

  async function launchOnboardingChat() {
    setStep('launching')
    try {
      await api.completeOnboarding().catch(() => {})
      const conv = await api.createConversation('Welcome to Jarvis')
      await api.sendMessage(conv.id, ONBOARDING_PROMPT)
      navigate(`/c/${conv.id}`, { replace: true })
    } catch {
      navigate('/', { replace: true })
    }
  }

  function copyCommand(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const steps: Step[] = ['welcome', ...(needsSetup ? ['account' as Step] : []), ...(!hasToken ? ['token' as Step] : [])]
  const currentIndex = steps.indexOf(step)

  return (
    <div className="h-full w-full bg-bg flex flex-col items-center justify-center p-4 overflow-y-auto">
      {/* Close button */}
      {step !== 'launching' && (
        <button
          onClick={dismissOnboarding}
          className="fixed top-4 right-4 p-2 rounded-full text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
          title="Skip onboarding"
        >
          <X size={20} />
        </button>
      )}

      {/* Progress dots */}
      {step !== 'launching' && (
        <div className="flex gap-2 mb-8">
          {steps.map((s, i) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === currentIndex
                  ? 'w-8 bg-accent'
                  : i < currentIndex
                    ? 'w-4 bg-accent/40'
                    : 'w-4 bg-border'
              }`}
            />
          ))}
        </div>
      )}

      {/* Step content */}
      <div className="w-full max-w-md">
        {step === 'welcome' && <WelcomeStep onNext={goToNextAfterWelcome} />}

        {step === 'account' && (
          <AccountStep
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            error={error}
            loading={loading}
            onSubmit={handleCreateAccount}
            onBack={() => { setError(''); setStep('welcome') }}
          />
        )}

        {step === 'token' && (
          <TokenStep
            token={token}
            setToken={setToken}
            showToken={showToken}
            setShowToken={setShowToken}
            copied={copied}
            onCopy={copyCommand}
            error={error}
            loading={loading}
            onSave={handleSaveToken}
            onSkip={handleSkipToken}
          />
        )}

        {step === 'launching' && <LaunchingStep />}
      </div>
    </div>
  )
}

// ── Step Components ──────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center animate-fade-in">
      <img
        src="/images/jarvis_wave.gif"
        alt="Jarvis"
        className="w-28 h-28 mb-6 mix-blend-multiply dark:mix-blend-screen"
      />
      <h1 className="text-3xl font-light text-text-primary mb-2">
        Welcome to Jarvis
      </h1>
      <p className="text-text-muted text-sm mb-8 max-w-sm leading-relaxed">
        Your personal AI assistant, running on your own server.
        Private, powerful, and always available.
      </p>

      {/* Feature highlights */}
      <div className="grid grid-cols-2 gap-3 w-full mb-8">
        {[
          { icon: MessageCircle, label: 'Chat & ask anything' },
          { icon: Clock, label: 'Scheduled automations' },
          { icon: Globe, label: 'Web search & browse' },
          { icon: Mic, label: 'Voice input' },
          { icon: Puzzle, label: 'Third-party integrations' },
          { icon: Zap, label: 'Create mini apps' },
        ].map(({ icon: Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-surface border border-border"
          >
            <Icon size={16} className="text-accent shrink-0" />
            <span className="text-xs text-text-secondary">{label}</span>
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        className="flex items-center gap-2 bg-accent text-white px-6 py-3 rounded-xl font-medium hover:bg-accent-hover transition-colors"
      >
        Get started
        <ArrowRight size={18} />
      </button>
    </div>
  )
}

function AccountStep({
  email, setEmail, password, setPassword, confirm, setConfirm,
  showPassword, setShowPassword, error, loading, onSubmit, onBack,
}: {
  email: string; setEmail: (v: string) => void
  password: string; setPassword: (v: string) => void
  confirm: string; setConfirm: (v: string) => void
  showPassword: boolean; setShowPassword: (v: boolean) => void
  error: string; loading: boolean
  onSubmit: (e: React.FormEvent) => void
  onBack: () => void
}) {
  return (
    <div className="animate-fade-in">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-text-muted hover:text-text-primary text-sm mb-4 transition-colors"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      <div className="bg-surface rounded-2xl border border-border p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={20} className="text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">Create your account</h2>
        </div>
        <p className="text-sm text-text-muted mb-5">
          This is your private instance — only you will have access.
        </p>

        {error && (
          <div className="text-danger text-sm bg-accent-subtle rounded-lg px-3 py-2 mb-4">{error}</div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            className="bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors outline-none"
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password (min 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 pr-10 text-sm focus:border-accent transition-colors outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            className="bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-accent text-white py-2.5 px-4 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-70 transition-colors text-sm mt-1 flex items-center justify-center gap-2"
          >
            {loading ? 'Creating account...' : (
              <>
                Create account
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

function TokenStep({
  token, setToken, showToken, setShowToken,
  copied, onCopy, error, loading, onSave, onSkip,
}: {
  token: string; setToken: (v: string) => void
  showToken: boolean; setShowToken: (v: boolean) => void
  copied: boolean; onCopy: (text: string) => void
  error: string; loading: boolean
  onSave: () => void; onSkip: () => void
}) {
  return (
    <div className="animate-fade-in">
      <div className="bg-surface rounded-2xl border border-border p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Terminal size={20} className="text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">Connect to Claude</h2>
        </div>
        <p className="text-sm text-text-muted mb-5">
          Jarvis uses Claude as its AI engine. You'll need an OAuth token from the Claude CLI.
        </p>

        {error && (
          <div className="text-danger text-sm bg-accent-subtle rounded-lg px-3 py-2 mb-4">{error}</div>
        )}

        {/* Instructions */}
        <div className="bg-bg rounded-xl border border-border p-4 mb-5">
          <h3 className="text-sm font-medium text-text-primary mb-3">How to get your token</h3>
          <ol className="flex flex-col gap-3 text-sm text-text-secondary">
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-xs font-medium flex items-center justify-center">1</span>
              <span>
                Install the Claude CLI on any machine
                <a
                  href="https://docs.anthropic.com/en/docs/claude-code/overview"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent hover:underline ml-1"
                >
                  docs <ExternalLink size={12} />
                </a>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-xs font-medium flex items-center justify-center">2</span>
              <div>
                <span>Run the token command:</span>
                <div className="flex items-center gap-2 mt-1.5 bg-surface rounded-lg border border-border px-3 py-2 font-mono text-xs">
                  <code className="flex-1 text-text-primary">claude setup-token</code>
                  <button
                    onClick={() => onCopy('claude setup-token')}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-xs font-medium flex items-center justify-center">3</span>
              <div>
                <span>Sign in in the browser, then paste back the token it prints below.</span>
                <p className="text-xs text-text-muted mt-1.5">
                  It starts with <code className="bg-surface px-1 rounded text-text-primary">sk-ant-oat01-</code> and is long-lived. Don't copy the token from{' '}
                  <code className="bg-surface px-1 rounded text-text-primary">~/.claude/.credentials.json</code> — that one expires within hours.
                </p>
              </div>
            </li>
          </ol>
        </div>

        {/* Token input */}
        <div className="relative mb-4">
          <input
            type={showToken ? 'text' : 'password'}
            placeholder="Paste your OAuth token here"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 pr-10 text-sm font-mono focus:border-accent transition-colors outline-none"
          />
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
          >
            {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={onSave}
            disabled={loading || !token.trim()}
            className="bg-accent text-white py-2.5 px-4 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-70 transition-colors text-sm flex items-center justify-center gap-2"
          >
            {loading ? 'Saving...' : (
              <>
                Continue
                <ArrowRight size={16} />
              </>
            )}
          </button>
          <button
            onClick={onSkip}
            className="text-text-muted hover:text-text-primary text-sm py-2 transition-colors"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}

function LaunchingStep() {
  return (
    <div className="flex flex-col items-center text-center animate-fade-in">
      <img
        src="/images/jarvis_wave.gif"
        alt="Jarvis"
        className="w-24 h-24 mb-4 mix-blend-multiply dark:mix-blend-screen"
      />
      <h2 className="text-xl font-light text-text-primary mb-2">
        Setting things up...
      </h2>
      <p className="text-text-muted text-sm">
        Starting your first conversation with Jarvis
      </p>
      <div className="mt-6 flex gap-1">
        <div className="w-2 h-2 rounded-full bg-accent animate-pulse" style={{ animationDelay: '0ms' }} />
        <div className="w-2 h-2 rounded-full bg-accent animate-pulse" style={{ animationDelay: '150ms' }} />
        <div className="w-2 h-2 rounded-full bg-accent animate-pulse" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}
