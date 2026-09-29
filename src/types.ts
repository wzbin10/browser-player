/**
 * browser-player 公共类型定义
 */

/** 底层播放通道类型 */
export type StreamType = 'native' | 'hls' | 'flv'

/** url 传 auto 时按地址自动识别 */
export type StreamTypeOption = StreamType | 'auto'

/** 播放器状态机 */
export type PlayerState =
  /** 已创建，尚未或暂时不持有解码器 */
  | 'idle'
  /** 正在加载 / 转封装 */
  | 'loading'
  /** 元数据就绪，可播放 */
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
  | 'destroyed'

export type PreloadMode = 'none' | 'metadata' | 'auto'

export interface PlayerError {
  /** 机器可读的错误码，如 NETWORK_ERROR / MEDIA_ERROR / NOT_ALLOWED / UNSUPPORTED */
  code: string
  message: string
  /** 致命错误会触发自动重试；非致命仅上报 */
  fatal: boolean
}

export interface PlayerOptions {
  /** 承载播放器的元素或其选择器，一个播放器对应一个容器 */
  container: HTMLElement | string
  /** 视频地址，支持 mp4/webm、m3u8、flv 以及 ws(s):// 的 WebSocket-FLV */
  url: string
  /** 协议类型，默认 auto（按 url 识别） */
  type?: StreamTypeOption
  /** 自动播放，注意 Chrome 要求 muted 才允许无交互自动播放 */
  autoplay?: boolean
  muted?: boolean
  loop?: boolean
  /** 是否显示原生控制条，默认 false */
  controls?: boolean
  /** 封面图，同时用于释放解码器后保留画面 */
  poster?: string
  preload?: PreloadMode
  /** 直播流标记，不传时按 url 推断（ws/wss 视为直播） */
  live?: boolean
  crossOrigin?: 'anonymous' | 'use-credentials'
  objectFit?: 'contain' | 'cover' | 'fill'
  /**
   * 全局同时解码路数上限。
   * 该值是进程级配置，任一实例设置后会覆盖全局值。
   */
  maxActiveDecoders?: number
  /** 可见性判定阈值（0~1），默认 0 */
  visibilityThreshold?: number
  /** 点播回看缓冲上限（秒），默认 30；直播固定为无上限 */
  backBufferLength?: number
  /** 直播起播/追帧目标延迟（秒），默认 2 */
  liveSyncDuration?: number
  /** 直播最大缓冲（秒），默认 10 */
  liveMaxBufferLength?: number
  /** 致命错误自动重试次数，默认 2 */
  maxRetries?: number
  /**
   * 失去解码权（离屏 / 超出并发额度）后，重新获得解码权时是否从上次的播放位置续播。
   * 默认 false，即从头开始播；直播流不适用（始终从最新位置起播）。
   */
  resumeOnActivate?: boolean
}

/** 归一化后的配置，所有字段均有值 */
export interface NormalizedPlayerOptions extends Required<Omit<PlayerOptions, 'container' | 'type' | 'poster' | 'crossOrigin'>> {
  container: HTMLElement | string
  type: StreamTypeOption
  poster?: string
  crossOrigin?: 'anonymous' | 'use-credentials'
}

export type PlayerEventMap = {
  /** 元数据就绪 */
  ready: { duration: number }
  play: undefined
  pause: undefined
  playing: undefined
  waiting: undefined
  ended: undefined
  error: PlayerError
  timeupdate: { currentTime: number; duration: number }
  progress: { buffered: number; duration: number }
  volumechange: { volume: number; muted: boolean }
  ratechange: { playbackRate: number }
  statechange: { state: PlayerState }
  /** 调度器授予解码权，开始真正加载 */
  active: undefined
  /** 调度器收回解码权，解码器已释放 */
  inactive: undefined
  destroy: undefined
}

export type PlayerEventName = keyof PlayerEventMap
