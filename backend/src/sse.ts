import { EventEmitter } from 'events'

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

export function emitConversationEvent(conversationId: string, data: object): void {
  emitter.emit(conversationId, JSON.stringify(data))
}

export function subscribeConversation(
  conversationId: string,
  handler: (data: string) => void,
): () => void {
  emitter.on(conversationId, handler)
  return () => { emitter.off(conversationId, handler) }
}

export function emitGlobalEvent(data: object): void {
  emitter.emit('__global__', JSON.stringify(data))
}

export function subscribeGlobal(handler: (data: string) => void): () => void {
  emitter.on('__global__', handler)
  return () => { emitter.off('__global__', handler) }
}

// Track global SSE client count
let globalClientCount = 0

export function addGlobalClient(): void { globalClientCount++ }
export function removeGlobalClient(): void { globalClientCount = Math.max(0, globalClientCount - 1) }
