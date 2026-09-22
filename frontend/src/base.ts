/**
 * Where this frontend is mounted.
 *
 * Jarvis serves at the root, so this is the empty string — but everything that
 * builds an absolute URL (API calls, iframes, the SW, the router) goes through
 * here rather than hardcoding a leading slash, so mounting the app under a
 * sub-path stays a one-line change (`base` in vite.config.ts) instead of a
 * hunt through the tree.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL.replace(/\/+$/, '')
export const API_BASE = `${BASE_PATH}/api`
