import type { Adapter, AdapterContext } from './types'
import { ERROR_CODE, makeError } from './types'

/** 只声明实际使用的 mpegts.js API，避免类型依赖 */
interface MpegtsPlayerLike {
  attachMediaElement(media: HTMLMediaElement): void
  detachMediaElement(): void
  load(): void
  unload?(): void
  play(): Promise<void>
  pause(): void
  destroy(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
  readonly mediaInfo?: { duration?: number; isComplete?: boolean }
  readonly statisticsInfo?: { speed?: number }
}

interface MpegtsModuleLike {
  isSupported(): boolean
  getFeatureList(): { mseLivePlayback?: boolean; mseFlvPlayback?: boolean }
  createPlayer(mediaDataSource: Record<string, unknown>, config?: Record<string, unknown>): MpegtsPlayerLike
  Events: Record<string, string>
  MediaDataSource: { type: string; isLive?: boolean; cors?: boolean; withCredentials?: boolean; url?: string }
}

/**
 * FLV 通道：HTTP-FLV 与 WebSocket-FLV 都交给 mpegts.js。
 * flv.js 官方已声明 rarely maintained 并推荐迁移到 mpegts.js，故此处直接选后者。
 */
export class FlvAdapter implements Adapter {
  readonly type = 'flv' as const

  private video: HTMLVideoElement
  private url: string
  private ctx: AdapterContext
  private player: MpegtsPlayerLike | null = null
  private mpegts: MpegtsModuleLike | null = null
  private destroyed = false
  private loaded = false
  private readyEmitted = false
  private retries = 0

  private bound: Array<[string, (...args: unknown[]) => void]> = []

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.video = ctx.video
    this.url = ctx.url
  }

  private isWebSocket(): boolean {
    return /^wss?:\/\//i.test(this.url)
  }

  private buildConfig(): Record<string, unknown> {
    const { live, liveSyncDuration } = this.ctx.options
    return {
      // 解复用放 Worker：多路 FLV 时主线程不再被 音视频 tag 解析占满
      enableWorker: true,
      // 直播关掉 stash，这是把延迟从数秒压到 1s 内的关键；
      // 点播留着 stash 更抗抖动，代价只是起播稍慢
      enableStashBuffer: !live,
      lazyLoad: !live,
      lazyLoadMaxDuration: 3 * 60,
      /**
       * 直播用 maxLatency + 丢帧追赶，保障"画面贴近实时"；
       * 点播不做追赶，避免快进式跳帧影响观感。
       */
      liveBufferLatencyChasing: live,
      liveBufferLatencyMaxLatency: live ? liveSyncDuration * 1.5 : undefined,
      liveBufferLatencyMinRemain: 0.3,
      stashInitialSize: live ? undefined : 384,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: this.ctx.options.backBufferLength,
      autoCleanupMinBackwardDuration: 15,
      fixAudioTimestampGap: !live,
      reuseRedirectedURL: true,
    }
  }

  load(): void {
    if (this.loaded || this.destroyed) return
    this.loaded = true
    void this.bootstrap()
  }

  private async bootstrap(): Promise<void> {
    let mod: unknown
    try {
      mod = await import(/* @vite-ignore */ 'mpegts.js')
    } catch {
      /* 落到下面的缺依赖分支 */
    }

    if (this.destroyed) return

    // mpegts.js 同时提供 ESM default 与 UMD 命名空间两种导出形态，逐一兼容
    const asRecord = mod as { default?: MpegtsModuleLike } & Partial<MpegtsModuleLike>
    const mpegts = asRecord?.default ?? (asRecord as MpegtsModuleLike)
    if (!mpegts || typeof mpegts.createPlayer !== 'function') {
      this.ctx.callbacks.onDependencyMissing('mpegts.js')
      return
    }
    this.mpegts = mpegts

    const features = mpegts.getFeatureList?.() ?? {}
    if (!features.mseLivePlayback && !features.mseFlvPlayback) {
      this.ctx.callbacks.onError(
        makeError(ERROR_CODE.UNSUPPORTED, '当前浏览器不支持 MSE，无法播放 FLV'),
      )
      return
    }

    this.createPlayer()
  }

  private createPlayer(): void {
    const mpegts = this.mpegts
    if (!mpegts || this.destroyed) return

    const live = this.ctx.options.live
    const source = {
      type: this.isWebSocket() ? 'websocket' : 'flv',
      url: this.url,
      isLive: live,
      cors: true,
      // 只有 websocket 才需要打开凭证透传
      withCredentials: false,
    }

    const player = mpegts.createPlayer(source, this.buildConfig())
    this.player = player

    const E = mpegts.Events
    this.bind(E.ERROR, this.onMediaError)
    this.bind(E.MEDIA_INFO, this.onMediaInfo)
    this.bind(E.LOADING_COMPLETE, this.onLoadingComplete)
    this.bind(E.STATISTICS_INFO, this.onStatisticsInfo)

    player.attachMediaElement(this.video)
    player.load()
  }

  private bind(event: string, handler: (...args: unknown[]) => void): void {
    this.player?.on(event, handler)
    this.bound.push([event, handler])
  }

  private onMediaError = (...args: unknown[]) => {
    if (this.destroyed) return
    const detail = args[0] as { code?: number; msg?: string } | string | undefined
    const message = typeof detail === 'string' ? detail : detail?.msg || 'FLV 播放失败'
    const code = typeof detail === 'object' && detail?.code === 3 ? ERROR_CODE.MEDIA : ERROR_CODE.NETWORK

    // 直播断流极常见（CDN 节点切换），指数退避重建比直接放弃体验好得多
    const { maxRetries } = this.ctx.options
    if (this.ctx.options.live && this.retries < maxRetries) {
      const delay = 300 * 2 ** this.retries
      this.retries += 1
      window.setTimeout(() => {
        if (this.destroyed) return
        this.releasePlayer()
        this.createPlayer()
      }, delay)
      return
    }

    this.ctx.callbacks.onError(makeError(code, message))
  }

  private onMediaInfo = (...args: unknown[]) => {
    if (this.destroyed || this.readyEmitted) return
    const info = args[0] as { duration?: number; isComplete?: boolean } | undefined
    this.readyEmitted = true
    const duration = this.ctx.options.live ? Infinity : info?.duration
    this.ctx.callbacks.onReady(duration && Number.isFinite(duration) ? duration : Infinity)
  }

  private onLoadingComplete = () => {
    if (this.destroyed) return
    this.video.dispatchEvent(new Event('ended'))
  }

  /** 直播延迟超阈值时上报，交给上层做追帧提示或强制 seek */
  private onStatisticsInfo = (...args: unknown[]) => {
    if (this.destroyed || !this.ctx.options.live) return
    const stat = args[0] as { speed?: number } | undefined
    if (!stat) return
    this.ctx.callbacks.onStatistics?.(stat.speed ?? 0)
  }

  private releasePlayer(): void {
    const player = this.player
    if (!player) return
    this.player = null
    for (const [event, handler] of this.bound) {
      try {
        player.off(event, handler)
      } catch {
        /* 忽略 */
      }
    }
    this.bound = []
    try {
      player.pause()
      player.unload?.()
      player.detachMediaElement()
      player.destroy()
    } catch {
      /* 忽略销毁阶段的异常 */
    }
  }

  async play(): Promise<void> {
    await this.video.play()
  }

  pause(): void {
    this.video.pause()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.releasePlayer()
    try {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    } catch {
      /* 忽略销毁阶段的异常 */
    }
  }
}
