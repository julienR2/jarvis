/**
 * Where this frontend is mounted.
 *
 * Prod serves at `/`. The `next` stack — the same tree in dev mode — is served
 * by the reverse proxy under `/next/`, on the same origin, so a preview needs
 * no second hostname, no second login and no mixed-content exception. Vite
 * bakes the mount point into BASE_URL; everything that builds an absolute URL
 * (API calls, iframes, the SW, the router) goes through here rather than
 * assuming the root.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL.replace(/\/+$/, '')
export const API_BASE = `${BASE_PATH}/api`
/** True on the next stack — the badge, and the service worker staying off. */
export const IS_NEXT = BASE_PATH !== ''
