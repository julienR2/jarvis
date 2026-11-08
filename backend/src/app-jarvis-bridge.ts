/**
 * `window.jarvis`, put at the top of every app page: how an app talks to the
 * chat it lives in, with no credential of its own.
 *
 * The app asks the page around it (postMessage); the Jarvis UI answers with
 * the owner's session, which never enters the frame. So a share link, opened
 * on its own in a tab, has no parent to ask and no bridge at all — nothing to
 * leak, which a webhook token written into the app's source could not say.
 *
 *   jarvis.available          inside Jarvis (false on a share link)
 *   jarvis.send(text)         post into the chat as the user; the chat answers
 *   jarvis.ask(prompt)        a one-off answer for the app, kept out of the chat
 *   jarvis.openDoc(path)      open a document beside the chat, as a tab
 *   jarvis.context()          { conversationId, title, topic }
 *   jarvis.onMessage(fn)      each finished answer in the chat: { id, role, text }
 *
 * Calls return promises; they reject when the bridge is unavailable.
 */
const SCRIPT = `(function () {
  if (window.jarvis) return
  var inside = window.parent !== window
  var pending = {}, seq = 0, listeners = []
  function call(method, args) {
    if (!inside) return Promise.reject(new Error('Not inside Jarvis: open this app from its chat'))
    return new Promise(function (resolve, reject) {
      var id = 'jarvis-' + (++seq) + '-' + Date.now()
      pending[id] = { resolve: resolve, reject: reject }
      window.parent.postMessage({ type: 'jarvis:call', id: id, method: method, args: args }, '*')
    })
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data) return
    var d = e.data
    if (d.type === 'jarvis:result' && pending[d.id]) {
      var p = pending[d.id]
      delete pending[d.id]
      if (d.error) p.reject(new Error(d.error))
      else p.resolve(d.value)
    } else if (d.type === 'jarvis:message') {
      listeners.slice().forEach(function (fn) { try { fn(d.message) } catch (err) { console.error(err) } })
    }
  })
  window.jarvis = {
    available: inside,
    send: function (text) { return call('send', { text: String(text) }) },
    ask: function (prompt) { return call('ask', { prompt: String(prompt) }) },
    openDoc: function (path) { return call('openDoc', { path: String(path) }) },
    context: function () { return call('context', {}) },
    onMessage: function (fn) {
      listeners.push(fn)
      return function () { listeners = listeners.filter(function (g) { return g !== fn }) }
    },
  }
})()`

const TAG = `<script>${SCRIPT}</script>`

export function withJarvisBridge(html: string): string {
  const head = html.match(/<head[^>]*>/i)
  if (head) return html.replace(head[0], head[0] + TAG)
  return TAG + html
}
