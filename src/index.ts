/**
 * browser-player
 *
 * 面向桌面 Chrome/Edge 的多路视频播放 SDK。
 * 统一封装 mp4 / HLS / FLV，通过全局单例调度器把"同时真正解码的实例数"
 * 压到可控范围，从而解决多视频并发播放时的卡顿与 CPU / 内存飙升。
 *
 * @example
 * ```ts
 * import { createPlayer } from 'browser-player'
 *
 * const player = createPlayer({
 *   container: '#app',
 *   url: 'https://example.com/live.flv',
 *   autoplay: true,
 *   muted: true,
 * })
 * player.on('ready', () => player.play())
 * ```
 */
export { BrowserPlayer, createPlayer } from './player'
export { scheduler } from './scheduler'
export { releaseVideo } from './resource-manager'
export { detectStreamType, inferLive, resolveStreamType } from './utils/stream'
export { ERROR_CODE } from './adapters/types'

export type {
  Adapter,
  AdapterCallbacks,
  AdapterContext,
} from './adapters/types'
export type { SchedulerHandle, SchedulerOptions, SchedulerTask } from './scheduler'
export type {
  PlayerError,
  PlayerEventMap,
  PlayerEventName,
  PlayerOptions,
  PlayerState,
  PreloadMode,
  StreamType,
  StreamTypeOption,
} from './types'
