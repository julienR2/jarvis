/**
 * A script put at the top of every app page, so a swipe that starts on an app
 * can still open the sidebar on a phone.
 *
 * Touches inside an iframe never reach the page around it, so the frame
 * forwards them (as `jarvis:swipe` messages, read by the frontend's
 * useSwipeToOpen) along with what the app wants of the gesture — which wins:
 *   - a horizontal scroller under the finger that can still move that way,
 *   - an element whose touch-action leaves out pan-x (a carousel, a canvas:
 *     the app handles horizontal touches itself),
 *   - a touch the app's own handlers called preventDefault on.
 * Once the sidebar has engaged it answers `jarvis:swipe-claim`, and the frame
 * stops scrolling along with the drag.
 *
 * Opened on its own (a share link in a tab) there is no parent and the script
 * does nothing. All an app could do by faking these messages is open the
 * sidebar.
 */
const SCRIPT = `(function () {
  if (window.parent === window) return
  var claimed = false, yielded = false
  function post(phase, t, extra) {
    var m = { type: 'jarvis:swipe', phase: phase, x: t ? t.clientX : 0, y: t ? t.clientY : 0 }
    for (var k in extra) m[k] = extra[k]
    window.parent.postMessage(m, '*')
  }
  function scrolls(el) {
    var root = el === document.scrollingElement
    if (el.scrollWidth <= el.clientWidth + 1) return false
    var ox = getComputedStyle(el).overflowX
    return root ? ox !== 'hidden' && ox !== 'clip' : ox === 'auto' || ox === 'scroll'
  }
  window.addEventListener('touchstart', function (e) {
    claimed = false
    yielded = false
    var owned = false, canLeft = false, canRight = false
    for (var el = e.target; el && el.nodeType === 1; el = el.parentElement) {
      var ta = getComputedStyle(el).touchAction
      if (ta && ta !== 'auto' && ta !== 'manipulation' && ta.indexOf('pan-x') < 0) owned = true
      if (!canLeft && !canRight && scrolls(el)) {
        canLeft = el.scrollLeft > 1
        canRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
      }
    }
    post('start', e.touches[0], { owned: owned, canLeft: canLeft, canRight: canRight })
  }, { passive: true })
  // Bubble phase on window: the app's own handlers have run by now.
  window.addEventListener('touchmove', function (e) {
    if (yielded) return
    if (e.defaultPrevented && !claimed) { yielded = true; post('yield'); return }
    if (claimed && e.cancelable) e.preventDefault()
    post('move', e.touches[0])
  }, { passive: false })
  window.addEventListener('touchend', function () { post('end') })
  window.addEventListener('touchcancel', function () { post('cancel') })
  window.addEventListener('message', function (e) {
    if (e.source === window.parent && e.data && e.data.type === 'jarvis:swipe-claim') claimed = true
  })
})()`

const TAG = `<script>${SCRIPT}</script>`

/** The page with the bridge first in its <head>, ahead of the app's own scripts. */
export function withSwipeBridge(html: string): string {
  const head = html.match(/<head[^>]*>/i)
  if (head) return html.replace(head[0], head[0] + TAG)
  return TAG + html
}
