import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { loginPath } from './api'
import { useLaunchQueue } from './hooks/useLaunchQueue'
import LoginPage from './pages/LoginPage'
import OnboardingPage from './pages/OnboardingPage'
import ChatPage from './pages/ChatPage'
import SharedChatPage from './pages/SharedChatPage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token')
  const { pathname, search, hash } = useLocation()
  return token ? <>{children}</> : <Navigate to={loginPath(pathname + search + hash)} replace />
}

export default function App() {
  useLaunchQueue()
  return (
    <>
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
