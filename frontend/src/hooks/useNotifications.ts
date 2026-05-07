import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    'Notification' in window ? Notification.permission : 'denied',
  )
  const subscribedRef = useRef(false)

  // Subscribe to push when permission is granted
  useEffect(() => {
    if (permission === 'granted' && !subscribedRef.current) {
      subscribedRef.current = true
      subscribeToPush()
    }
  }, [permission])

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return
    const result = await Notification.requestPermission()
    setPermission(result)
  }, [])

  return { permission, requestPermission }
}

async function subscribeToPush() {
  try {
    const reg = await navigator.serviceWorker.ready
    // Check if already subscribed
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      const { key } = await api.getVapidKey()
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      })
    }
    // Send subscription to backend
    await api.subscribePush(sub.toJSON())
    console.log('[push] Subscribed successfully')
  } catch (err) {
    console.error('[push] Subscription failed:', err)
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
