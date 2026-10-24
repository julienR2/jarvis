import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { BASE_PATH } from '../base'

// Not in lib.dom yet — Chromium only.
interface LaunchQueue {
  setConsumer(consumer: (params: { targetURL?: string }) => void): void
}

/**
 * Opening a Jarvis link (https://…/c/<id>) while the installed app is already
 * open. The manifest's `launch_handler` is `focus-existing`, so Chromium
 * brings that window forward without reloading it and hands the link over
 * here; it is routed in-app, keeping the stores, the sidebar and the open
 * streams instead of starting the whole app again.
 *
 * Elsewhere (Safari, Firefox) there is no launchQueue and the link is an
 * ordinary page load, which the router takes from there.
 */
export function useLaunchQueue() {
  const navigate = useNavigate()
  useEffect(() => {
    const queue = (window as { launchQueue?: LaunchQueue }).launchQueue
    if (!queue) return
    queue.setConsumer(({ targetURL }) => {
      if (!targetURL) return
      const url = new URL(targetURL)
      if (url.origin !== window.location.origin) return
      const inApp = (path: string) => path.slice(BASE_PATH.length) || '/'
      const to = inApp(url.pathname) + url.search + url.hash
      const here = inApp(window.location.pathname) + window.location.search + window.location.hash
      // A cold launch is queued too, for the page that was just loaded.
      if (to !== here) navigate(to)
    })
  }, [])
}
