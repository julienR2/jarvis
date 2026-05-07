import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { api } from '../api'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { token } = await api.login(email, password)
      localStorage.setItem('token', token)
      navigate('/')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen w-full bg-bg">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 w-80 p-8 bg-surface rounded-2xl border border-border shadow-sm"
      >
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={22} className="text-accent" />
          <h1 className="text-xl font-semibold text-text-primary">Jarvis</h1>
        </div>

        {error && (
          <div className="text-danger text-sm bg-accent-subtle rounded-lg px-3 py-2">{error}</div>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          className="bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent transition-colors"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-accent text-white py-2.5 px-4 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-70 transition-colors text-sm"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
