import type { NormalizedPlayerOptions, PlayerError, StreamType } from '../types'

export interface AdapterCallbacks {
  /** 元数据就绪；duration 未知时直播返回 Infinity */
  onReady: (duration: number) => void
  /** 对流不可恢复的错误上报，由 Player 决定重试或降级 */
  onError: (error: PlayerError) => void
  /** 转封装库加载失败（未安装 peer 依赖） */
  onDependencyMissing: (pkg: string) => void
  /** 直播速率统计（KB/s），用于上层展示网速或判断卡顿 */
  onStatistics?: (speedKBps: number) => void
}

export interface AdapterContext {
  video: HTMLVideoElement
  url: string
  options: NormalizedPlayerOptions
  callbacks: AdapterCallbacks
}

/**
 * 播放通道统一接口。
 * 三种实现（原生 / HLS / FLV）对上层完全等价，Scheduler 与 Player 不感知协议差异。
 */
export interface Adapter {
  readonly type: StreamType
  /** 建立连接、创建 MSE、灌流；幂等，重复调用应被忽略 */
  load(): void
  play(): Promise<void>
  pause(): void
  /** 释放 MSE / SourceBuffer / 转封装器 / 网络请求，必须可重复调用 */
  destroy(): void
}

export const ERROR_CODE = {
  NETWORK: 'NETWORK_ERROR',
  MEDIA: 'MEDIA_ERROR',
  NOT_ALLOWED: 'NOT_ALLOWED',
  UNSUPPORTED: 'UNSUPPORTED',
  DEPENDENCY: 'DEPENDENCY_MISSING',
} as const

export function makeError(code: string, message: string, fatal = true): PlayerError {
  return { code, message, fatal }
}
