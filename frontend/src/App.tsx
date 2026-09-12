import { Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import OnboardingPage from './pages/OnboardingPage'
import ChatPage from './pages/ChatPage'
import SharedChatPage from './pages/SharedChatPage'
import { IS_NEXT } from './base'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token')
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

/**
 * Always-visible mark on the next stack, so a screenshot or a detached tab is
 * never mistaken for the instance that holds your real data.
 */
function NextBadge() {
  return (
    <div className='fixed bottom-2 left-2 z-[500] rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow pointer-events-none select-none'>
      next
    </div>
  )
}

export default function App() {
  return (
    <>
    {IS_NEXT && <NextBadge />}
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      {/* Public: the share token is the credential, so no PrivateRoute. */}
      <Route path="/s/:token" element={<SharedChatPage />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <ChatPage />
          </PrivateRoute>
        }
      />
    </Routes>
    </>
  )
}
