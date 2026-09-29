import type { Adapter, AdapterContext } from './types'
import { ERROR_CODE, makeError } from './types'

/**
 * 只声明我们真正用到的那部分 hls.js API。
 * 好处是产出的 .d.ts 不依赖 hls.js 类型，消费方即使不装 hls.js 也能正常类型检查。
 */
interface HlsLike {
  attachMedia(media: HTMLMediaElement): void
  detachMedia?(): void
  loadSource(src: string): void
  startLoad(startPosition?: number): void
  stopLoad(): void
  recoverMediaError(): void
  destroy(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  currentLevel: number
  autoLevelEnabled: boolean
}

interface HlsCtor {
  isSupported(): boolean
  new (config?: Record<string, unknown>): HlsLike
}

/** 与 hls.js 对齐的关键事件名，避免魔法字符串散落各处 */
const EVENT = {
  MANIFEST_PARSED: 'hlsManifestParsed',
  LEVEL_LOADED: 'hlsLevelLoaded',
  ERROR: 'hlsError',
} as const

/**
 * HLS 通道：统一走 MSE（不依赖 Safari 原生 HLS，本项目只面向桌面 Chrome/Edge）。
 *
 * 几个针对"多路并发"的关键配置：
 * - enableWorker：解封装挪到 Worker，主线程不被多路 TS 解析拖死
 * - capLevelToPlayerSize：只拉与播放器尺寸匹配的码率档，小窗不再硬解 1080p
 * - autoStartLoad: false：由 Scheduler 授予解码权后再 startLoad，避免离屏抢带宽
 */
export class HlsAdapter implements Adapter {
  readonly type = 'hls' as const

  private video: HTMLVideoElement
  private url: string
  private ctx: AdapterContext
  private hls: HlsLike | null = null
  private destroyed = false
  private loaded = false
  private readyEmitted = false
  private mediaRecovered = false

  private onError = (_event: unknown, data: unknown) => {
    if (this.destroyed) return
    const info = data as { fatal?: boolean; type?: string; details?: string; reason?: string } | undefined
    if (!info?.fatal) return

    // 媒体错误（如解码器被系统回收）先尝试原地恢复一次，避免直接销毁重建
    if (info.type === 'mediaError' && !this.mediaRecovered) {
      this.mediaRecovered = true
      try {
        this.hls?.recoverMediaError()
        return
      } catch {
        /* 恢复失败则走下面的致命上报 */
      }
    }

    const code = info.type === 'networkError' ? ERROR_CODE.NETWORK : ERROR_CODE.MEDIA
    this.ctx.callbacks.onError(makeError(code, `HLS ${info.details || info.reason || 'unknown'}`))
  }

  private onManifestParsed = () => {
    if (this.destroyed) return
    this.emitReady()
  }

  /** 直播流在 manifest 阶段拿不到 duration，用 level 更新兜底一次 */
  private onLevelLoaded = () => {
    if (this.destroyed || this.readyEmitted) return
    this.emitReady()
  }

  private emitReady(): void {
    if (this.readyEmitted) return
    this.readyEmitted = true
    const duration = this.ctx.options.live ? Infinity : this.video.duration
    this.ctx.callbacks.onReady(Number.isFinite(duration) ? duration : Infinity)
  }

  constructor(ctx: AdapterContext) {
    this.ctx = ctx
    this.video = ctx.video
    this.url = ctx.url
  }

  private buildConfig(): Record<string, unknown> {
    const { live, backBufferLength, liveSyncDuration, liveMaxBufferLength } = this.ctx.options
    return {
      // 解封装放 Worker，多路并发的第一道 CPU 防线
      enableWorker: true,
      autoStartLoad: false,
      // 只拉与播放器实际尺寸匹配的档位，小窗少解一半像素
      capLevelToPlayerSize: true,
      startLevel: -1,
      lowLatencyMode: live,
      // 点播限制回看缓冲，钉死内存上限；直播必须放开否则会被清掉正在播的段
      backBufferLength: live ? Infinity : backBufferLength,
      maxBufferLength: live ? liveMaxBufferLength : 30,
      liveDurationInfinity: live,
      liveSyncDuration,
      // 允许最多落后 1.5 倍目标延迟再触发追帧，减少无谓的倍速抖动
      liveMaxLatencyDuration: live ? liveSyncDuration * 1.5 : undefined,
      manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    }
  }

  load(): void {
    if (this.loaded || this.destroyed) return
    this.loaded = true

    void this.bootstrap()
  }

  private async bootstrap(): Promise<void> {
    let mod: { default?: HlsCtor } | undefined
    try {
      mod = (await import(/* @vite-ignore */ 'hls.js')) as { default?: HlsCtor }
    } catch {
      /* 落到下面的缺依赖分支 */
    }

    if (this.destroyed) return

    const Hls = mod?.default
    if (!Hls) {
      this.ctx.callbacks.onDependencyMissing('hls.js')
      return
    }
    if (!Hls.isSupported()) {
      this.ctx.callbacks.onError(
        makeError(ERROR_CODE.UNSUPPORTED, '当前浏览器不支持 MSE，无法播放 HLS'),
      )
      return
    }

    const hls = new Hls(this.buildConfig())
    this.hls = hls

    hls.on(EVENT.MANIFEST_PARSED, this.onManifestParsed)
    hls.on(EVENT.LEVEL_LOADED, this.onLevelLoaded)
    hls.on(EVENT.ERROR, this.onError)

    hls.attachMedia(this.video)
    hls.loadSource(this.url)
    hls.startLoad()
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

    const hls = this.hls
    this.hls = null
    if (hls) {
      try {
        // 先停拉流，再销毁，避免销毁过程中还在往 SourceBuffer 追加数据
        hls.stopLoad()
        hls.detachMedia?.()
        hls.destroy()
      } catch {
        /* 忽略销毁阶段的异常 */
      }
    }

    try {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
    } catch {
      /* 忽略销毁阶段的异常 */
    }
  }
}
