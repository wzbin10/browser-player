import { Emitter } from './emitter'
import { scheduler, registerWithScheduler, type SchedulerHandle } from './scheduler'
import { createAdapter, type Adapter } from './adapters'
import { acquireVideo, applyVideoOptions, releaseVideo } from './resource-manager'
import { inferLive, normalizeUrl, resolveStreamType } from './utils/stream'
import { ERROR_CODE, makeError } from './adapters/types'
import type {
  NormalizedPlayerOptions,
  PlayerError,
  PlayerEventMap,
  PlayerEventName,
  PlayerOptions,
  PlayerState,
  StreamType,
} from './types'

const DEFAULTS = {
  type: 'auto' as const,
  autoplay: false,
  muted: false,
  loop: false,
  controls: false,
  preload: 'metadata' as const,
  objectFit: 'contain' as const,
  maxActiveDecoders: 2,
  visibilityThreshold: 0,
  backBufferLength: 30,
  liveSyncDuration: 2,
  liveMaxBufferLength: 10,
  maxRetries: 2,
  resumeOnActivate: false,
}

/**
 * 一个 BrowserPlayer 实例 = 一路视频。
 *
 * 生命周期：
 *   new → (Scheduler 判定可见) → activate → 建 Adapter 拉流
 *        ← (离屏 / 超出并发额度) ← deactivate ← 释放 Adapter
 *   destroy() → unregister + 释放元素 + 清空监听
 */
export class BrowserPlayer {
  private readonly emitter = new Emitter()
  private readonly container: HTMLElement
  private readonly options: NormalizedPlayerOptions
  private readonly boundListeners: Array<[string, EventListener]> = []

  private video: HTMLVideoElement
  private handle: SchedulerHandle | null = null
  private adapter: Adapter | null = null
  private state: PlayerState = 'idle'
  /** 用户意图：play() 调用后置 true，pause() 后置 false。用于解码权恢复时决定是否续播 */
  private wantPlay = false
  private destroyed = false
  private lastUrl: string
  /** 用户显式指定的协议类型，用于从原生降级后还原 */
  private configuredType: NormalizedPlayerOptions['type']
  /** 原生降级只允许发生一次，避免失败时来回重建 */
  private nativeRetried = false
  /** 断点位（秒）：开启 resumeOnActivate 时于 deactivate 前记录，activate 就绪后回跳 */
  private resumePosition = 0

  constructor(options: PlayerOptions) {
    if (!options || !options.url) {
      throw new Error('[browser-player] options.url 是必填项')
    }

    this.container = resolveContainer(options.container)
    this.options = normalizeOptions(options)
    this.lastUrl = options.url
    this.configuredType = this.options.type

    // 先把全局并发额度设好，再注册自己，避免首个实例按旧默认值起播
    scheduler.configure({
      maxActiveDecoders: this.options.maxActiveDecoders,
      visibilityThreshold: this.options.visibilityThreshold,
    })

    this.video = acquireVideo(this.container, this.options)
    this.bindVideoEvents()

    this.handle = registerWithScheduler(this.video, {
      priority: 0,
      onActivate: () => this.activate(),
      onDeactivate: () => this.deactivate(),
    })

    if (this.options.autoplay) this.play()
  }

  // ---------------------------------------------------------------- 公开 API

  /** 当前状态 */
  get currentState(): PlayerState {
    return this.state
  }

  /** 实际生效的协议通道 */
  get streamType(): StreamType {
    return resolveStreamType(this.lastUrl, this.options.type)
  }

  /** 是否正持有解码器 */
  get isActive(): boolean {
    return this.handle != null && scheduler.isActive(this.handle.id)
  }

  /** 底层 video 元素，需要自定义 UI 时可读写 */
  get element(): HTMLVideoElement {
    return this.video
  }

  get duration(): number {
    const d = this.video.duration
    return Number.isFinite(d) ? d : 0
  }

  get currentTime(): number {
    return this.video.currentTime
  }

  get volume(): number {
    return this.video.volume
  }

  get muted(): boolean {
    return this.video.muted
  }

  get paused(): boolean {
    return this.video.paused
  }

  play(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('[browser-player] 实例已销毁'))
    this.wantPlay = true
    // 用户主动播放 → 提升优先级，抢占时优先保住这一路
    this.handle?.setPriority(1)
    this.handle?.touch()

    if (!this.adapter) {
      // 未获得解码权：等 Scheduler 激活后由 activate() 自动续播
      this.setState('loading')
      return Promise.resolve()
    }
    return this.adapter.play().catch((err: unknown) => {
      const name = (err as Error)?.name
      if (name === 'NotAllowedError') {
        // 有声音的自动播放被拦截，这是预期行为，交给业务决定是否降级为静音
        this.emit('error', makeError(ERROR_CODE.NOT_ALLOWED, '自动播放被浏览器拦截，请设置 muted 或等待用户交互'))
      } else if (name !== 'AbortError') {
        this.emit('error', makeError(ERROR_CODE.MEDIA, (err as Error)?.message || '播放失败'))
      }
      return undefined
    })
  }

  pause(): void {
    if (this.destroyed) return
    this.wantPlay = false
    this.handle?.setPriority(0)
    this.adapter?.pause()
  }

  /** 切换地址：先彻底销毁旧通道再建新的，杜绝 MSE 叠加 */
  load(url: string, autoplay = this.wantPlay): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('[browser-player] 实例已销毁'))
    if (normalizeUrl(url) === normalizeUrl(this.lastUrl)) return this.play()

    this.releaseAdapter()
    this.lastUrl = url
    this.options.live = inferLive(url)
    // 还原用户显式指定的 type，同时清掉上一次原生降级的痕迹
    this.options.type = this.configuredType
    this.nativeRetried = false
    // 换了新地址，旧断点位不再适用
    this.resumePosition = 0
    this.wantPlay = autoplay

    if (this.handle && scheduler.isActive(this.handle.id)) {
      // 已持有解码权：立刻用新地址重建通道
      this.setState('idle')
      this.activate()
    } else if (autoplay) {
      // 未持有解码权：把"切换地址"当成用户主动播放意图（提升优先级 + 进入 loading），
      // 待调度器再次授予解码权时按新地址起播；否则会一直停在 idle，看起来"切换无效"
      void this.play()
    } else {
      this.setState('idle')
      this.handle?.touch()
    }
    return Promise.resolve()
  }

  /** 动态改配置里允许热更的几项 */
  setVolume(volume: number): void {
    this.video.volume = Math.min(1, Math.max(0, volume))
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted
    this.emit('volumechange', { volume: this.video.volume, muted })
  }

  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate
  }

  /** 跳到指定秒；直播会 clamp 到可 seek 区间内 */
  seek(time: number): void {
    const d = this.video.duration
    const target = Number.isFinite(d) ? Math.min(Math.max(0, time), d) : time
    this.video.currentTime = target
    // 直播 seek 之后重新对齐，避免刚追平又落后
    this.handle?.touch()
  }

  /** 重新加载当前地址，用于致命错误后的手动重试 */
  reload(): Promise<void> {
    return this.load(this.lastUrl)
  }

  on<K extends PlayerEventName>(event: K, fn: (payload: PlayerEventMap[K]) => void): () => void {
    return this.emitter.on(event, fn)
  }

  once<K extends PlayerEventName>(event: K, fn: (payload: PlayerEventMap[K]) => void): () => void {
    return this.emitter.once(event, fn)
  }

  off<K extends PlayerEventName>(event: K, fn: (payload: PlayerEventMap[K]) => void): void {
    this.emitter.off(event, fn)
  }

  /**
   * 销毁：这是 SDK 里唯一且必须走完的释放出口。
   * 顺序 = 退订调度 → 释放 Adapter → 摘事件 → 移除元素 → 清监听。
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.wantPlay = false

    this.handle?.unregister()
    this.handle = null

    this.releaseAdapter()

    for (const [type, fn] of this.boundListeners) {
      this.video.removeEventListener(type, fn)
    }
    this.boundListeners.length = 0

    releaseVideo(this.video)
    this.state = 'destroyed'
    this.emitter.emit('statechange', { state: 'destroyed' })
    this.emit('destroy', undefined)
    this.emitter.clear()
  }

  // ------------------------------------------------------------ 调度回调

  /** 获得解码权：这时才真正创建通道、开始占用解码器与带宽 */
  private activate(): void {
    if (this.destroyed || this.adapter) return

    this.setState('loading')
    this.adapter = createAdapter({
      video: this.video,
      url: this.lastUrl,
      options: this.options,
      callbacks: {
        onReady: (duration) => {
          this.setState('ready')
          this.emit('ready', { duration })
          // 点播续播：解码权被收回前记下的断点位，就绪后回跳，避免从 0 重播
          if (this.resumePosition > 0 && !this.options.live && Number.isFinite(duration)) {
            const target = Math.min(this.resumePosition, duration)
            if (target > 0) this.video.currentTime = target
          }
          if (this.wantPlay) void this.play()
        },
        onError: (error) => this.handleAdapterError(error),
        onDependencyMissing: (pkg) => this.handleDependencyMissing(pkg),
        onStatistics: (speed) => {
          this.emit('progress', { buffered: speed, duration: this.duration })
        },
      },
    })

    applyVideoOptions(this.video, this.options)
    this.adapter.load()
    this.emit('active', undefined)
  }

  /** 失去解码权：释放通道，但保留 poster 与元素位置，视觉上不突兀 */
  private deactivate(): void {
    if (!this.adapter) return
    // 释放通道会清掉 src，必须先趁 video 还挂着媒体时记下断点位
    if (this.options.resumeOnActivate && !this.options.live) {
      const t = this.video.currentTime
      this.resumePosition = Number.isFinite(t) && t > 0 ? t : this.resumePosition
    }
    this.adapter.pause()
    this.releaseAdapter()
    this.setState('idle')
    this.emit('inactive', undefined)
  }

  private releaseAdapter(): void {
    const adapter = this.adapter
    if (!adapter) return
    this.adapter = null
    try {
      adapter.destroy()
    } catch (err) {
      console.error('[browser-player] adapter destroy failed:', err)
    }
  }

  // ------------------------------------------------------------ 内部工具

  private handleAdapterError(error: PlayerError): void {
    this.setState('error')
    this.emit('error', error)

    if (!error.fatal) return

    // 降级链：HLS/FLV 解析失败 → 退回原生通道再试一次（例如地址其实是个 mp4）
    if (this.adapter && this.adapter.type !== 'native' && this.retryAsNative(error)) return
  }

  /**
   * 降级为原生播放。
   * 通过临时覆盖 type 实现，load()/reload() 会重新按 URL 识别，不会持续污染配置。
   */
  private retryAsNative(error: PlayerError): boolean {
    if (this.nativeRetried) return false
    this.nativeRetried = true
    console.warn(`[browser-player] ${this.streamType} 通道失败，降级为原生播放：${error.message}`)
    this.releaseAdapter()
    this.options.type = 'native'
    this.activate()
    return true
  }

  private handleDependencyMissing(pkg: string): void {
    const message =
      `缺少可选依赖 ${pkg}，请先安装：npm i ${pkg}。` +
      `若已安装仍报此错，请确认构建工具未把该依赖预打包进主包。`
    this.setState('error')
    this.emit('error', makeError(ERROR_CODE.DEPENDENCY, message, false))
  }

  private setState(next: PlayerState): void {
    if (this.state === next) return
    this.state = next
    this.emit('statechange', { state: next })
  }

  /** 内部事件派发，destroy 后不再外抛 */
  private emit<K extends PlayerEventName>(event: K, payload: PlayerEventMap[K]): void {
    if (this.destroyed && event !== 'destroy') return
    this.emitter.emit(event, payload)
  }

  private bindVideoEvents(): void {
    const on = (type: string, handler: EventListener) => {
      this.video.addEventListener(type, handler)
      this.boundListeners.push([type, handler])
    }

    on('play', () => {
      this.wantPlay = true
      this.setState('playing')
      this.emit('play', undefined)
    })
    on('playing', () => {
      this.setState('playing')
      this.emit('playing', undefined)
    })
    on('pause', () => {
      // 调度器收回解码权时 adapter 已释放，此时的 pause 不代表用户暂停，
      // 不应把状态改写成 paused（交给 deactivate() 置 idle）
      if (!this.destroyed && this.adapter) this.setState('paused')
      this.emit('pause', undefined)
    })
    on('waiting', () => this.emit('waiting', undefined))
    on('ended', () => {
      this.setState('ended')
      this.emit('ended', undefined)
    })
    on('timeupdate', () =>
      this.emit('timeupdate', { currentTime: this.video.currentTime, duration: this.duration }),
    )
    on('progress', () => {
      const buffered = this.video.buffered
      const last = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
      this.emit('progress', { buffered: last, duration: this.duration })
    })
    on('volumechange', () =>
      this.emit('volumechange', { volume: this.video.volume, muted: this.video.muted }),
    )
    on('ratechange', () => this.emit('ratechange', { playbackRate: this.video.playbackRate }))
    on('error', () => {
      // 原生通道的错误已由 Html5Adapter 上报；此处兜住 MSE 通道的意外错误
      if (!this.adapter || this.adapter.type !== 'native') return
      if (this.state === 'error') return
      this.setState('error')
      this.emit('error', makeError(ERROR_CODE.MEDIA, this.video.error?.message || '视频播放错误'))
    })
  }
}

// ------------------------------------------------------------------ 工厂

/** 便捷创建，等价于 new BrowserPlayer(options) 但省去 new */
export function createPlayer(options: PlayerOptions): BrowserPlayer {
  return new BrowserPlayer(options)
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container
  const el = document.querySelector(container)
  if (!el) throw new Error(`[browser-player] 找不到容器元素：${container}`)
  return el as HTMLElement
}

function normalizeOptions(options: PlayerOptions): NormalizedPlayerOptions {
  const live = options.live ?? inferLive(options.url)
  return {
    ...DEFAULTS,
    ...options,
    live,
  }
}
