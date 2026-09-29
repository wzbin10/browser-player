import type { PlayerEventMap, PlayerEventName } from './types'

type Listener<K extends PlayerEventName> = (payload: PlayerEventMap[K]) => void

/**
 * 极简类型安全事件总线。
 * 播放器实例内部与调度层共用，避免引入任何第三方依赖。
 */
export class Emitter {
  private listeners = new Map<PlayerEventName, Set<(payload: unknown) => void>>()

  on<K extends PlayerEventName>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as (payload: unknown) => void)
    return () => this.off(event, fn)
  }

  once<K extends PlayerEventName>(event: K, fn: Listener<K>): () => void {
    const off = this.on(event, ((payload: PlayerEventMap[K]) => {
      off()
      fn(payload)
    }) as Listener<K>)
    return off
  }

  off<K extends PlayerEventName>(event: K, fn: Listener<K>): void {
    const set = this.listeners.get(event)
    if (!set) return
    set.delete(fn as (payload: unknown) => void)
    if (set.size === 0) this.listeners.delete(event)
  }

  emit<K extends PlayerEventName>(event: K, payload: PlayerEventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    // 复制一份，允许监听器内部执行 off
    for (const fn of [...set]) {
      try {
        ;(fn as Listener<K>)(payload)
      } catch (err) {
        // 监听器异常不能中断播放主流程
        console.error(`[browser-player] listener of "${event}" threw:`, err)
      }
    }
  }

  /** 清空所有监听，destroy 时调用 */
  clear(): void {
    this.listeners.clear()
  }
}
