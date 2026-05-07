import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'
type Preference = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: Theme
  preference: Preference
  cycle: () => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'light', preference: 'system', cycle: () => {} })

function resolveTheme(pref: Preference): Theme {
  if (pref !== 'system') return pref
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Preference>(() => {
    const stored = localStorage.getItem('jarvis-theme') as Preference | null
    return stored || 'system'
  })

  const [theme, setTheme] = useState<Theme>(() => resolveTheme(preference))

  // Apply theme to DOM
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(theme)

    const themeColor = theme === 'dark' ? '#211f1c' : '#f3f1ed'
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', themeColor)
  }, [theme])

  // Persist preference
  useEffect(() => {
    localStorage.setItem('jarvis-theme', preference)
    setTheme(resolveTheme(preference))
  }, [preference])

  // Listen for OS theme changes when in system mode
  useEffect(() => {
    if (preference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setTheme(resolveTheme('system'))
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [preference])

  function cycle() {
    setPreference((p) => {
      if (p === 'system') return 'light'
      if (p === 'light') return 'dark'
      return 'system'
    })
  }

  return (
    <ThemeContext.Provider value={{ theme, preference, cycle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
