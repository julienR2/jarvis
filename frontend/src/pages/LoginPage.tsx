import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { api } from '../api'

export default function LoginPage() {
  const [mode, setMode] = useState<'loading' | 'login' | 'setup'>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api.getSetupStatus()
      .then(({ needsSetup }) => {
        if (needsSetup) {
          navigate('/onboarding', { replace: true })
        } else {
          setMode('login')
        }
      })
      .catch(() => setMode('login'))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (mode === 'setup') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match')
        return
      }
    }

    setLoading(true)
    try {
      const { token } =
        mode === 'setup'
          ? await api.setup(email, password, setupCode.trim())
          : await api.login(email, password)
      localStorage.setItem('token', token)
      navigate('/')
    } catch (err: any) {
      setError(err.message || (mode === 'setup' ? 'Setup failed' : 'Login failed'))
    } finally {
      setLoading(false)
    }
  }

  if (mode === 'loading') {
    return <div className='h-screen w-full bg-bg' />
  }

  const isSetup = mode === 'setup'

  return (
    <div className='flex items-center justify-center h-screen w-full bg-bg'>
      <form
        onSubmit={handleSubmit}
        className='flex flex-col gap-4 w-80 p-8 bg-surface rounded-2xl border border-border shadow-sm'
      >
        <div className='flex items-center gap-2 mb-2'>
          <Sparkles size={22} className='text-accent' />
          <h1 className='text-xl font-semibold text-text-primary'>Jarvis</h1>
        </div>

        {isSetup && (
          <p className='text-sm text-text-muted -mt-1'>
            Create your admin account to get started. This is a one-time setup.
          </p>
        )}

        {error && (
          <div className='text-danger text-sm bg-accent-subtle rounded-lg px-3 py-2'>{error}</div>
        )}

        <input
          type='email'
          placeholder='Email'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          className='bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors'
        />
        <input
          type='password'
          placeholder={isSetup ? 'Password (min 8 characters)' : 'Password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={isSetup ? 8 : undefined}
          className='bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors'
        />
        {isSetup && (
          <>
            <input
              type='password'
              placeholder='Confirm password'
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className='bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors'
            />
            <div>
              <input
                type='text'
                placeholder='Setup code (from server logs)'
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                required
                autoComplete='off'
                className='w-full bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm font-mono focus:border-accent transition-colors'
              />
              <p className='text-xs text-text-muted mt-1.5'>
                Run <code className='bg-bg px-1 rounded'>docker compose logs backend | grep setup</code>
              </p>
            </div>
          </>
        )}
        <button
          type='submit'
          disabled={loading}
          className='bg-accent text-white py-2.5 px-4 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-70 transition-colors text-sm'
        >
          {loading
            ? (isSetup ? 'Creating account...' : 'Signing in...')
            : (isSetup ? 'Create account' : 'Sign in')}
        </button>
      </form>
    </div>
  )
}
