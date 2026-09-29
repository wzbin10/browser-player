import type { Adapter, AdapterContext } from './types'
import { ERROR_CODE, makeError } from './types'

/**
 * 原生通道：mp4 / webm / ogg 等浏览器可直接解码的渐进式文件。
 * 零依赖、零转封装，是 CPU 开销最低的一条路，也是首要优化对象：
 * 默认只拉 metadata，真正可见时才切 auto 拉全量。
 */
export class Html5Adapter implements Adapter {
  readonly type = 'native' as const

  private video: HTMLVideoElement
  private url: string
  private callbacks: AdapterContext['callbacks']
  private destroyed = false
  private loaded = false

  private onLoadedMetadata = () => {
    if (this.destroyed) return
    this.callbacks.onReady(Number.isFinite(this.video.duration) ? this.video.duration : Infinity)
  }

  private onError = () => {
    if (this.destroyed) return
    const err = this.video.error
    // 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
    const code = err?.code === 3 ? ERROR_CODE.MEDIA : ERROR_CODE.NETWORK
    this.callbacks.onError(makeError(code, err?.message || '原生播放失败'))
  }

  constructor(ctx: AdapterContext) {
    this.video = ctx.video
    this.url = ctx.url
    this.callbacks = ctx.callbacks
  }

  load(): void {
    if (this.loaded || this.destroyed) return
    this.loaded = true

    const video = this.video
    video.addEventListener('loadedmetadata', this.onLoadedMetadata)
    video.addEventListener('error', this.onError)
    // 首帧优先：先 metadata 再按需升级，避免离屏实例拉全片
    video.preload = 'auto'
    video.src = this.url
    video.load()
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

    const video = this.video
    video.removeEventListener('loadedmetadata', this.onLoadedMetadata)
    video.removeEventListener('error', this.onError)
    // 必须显式 load() 中断，否则 src 清空后仍可能有在途请求
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
    } catch {
      /* 忽略销毁阶段的异常 */
    }
  }
}
