import type { StreamType, StreamTypeOption } from '../types'

const HLS_RE = /\.m3u8(\?.*)?$/i
const FLV_RE = /\.flv(\?.*)?$/i
const WS_RE = /^wss?:\/\//i

/**
 * 按地址推断播放通道。
 * 之所以以 URL 而非 MIME 为准：MSE 播放不需要服务端 Content-Type 正确，
 * 且 ws(s):// 这类 WebSocket-FLV 根本没有 MIME。
 *
 * 注意：不在这里退回原生 <video>。桌面 Chrome/Edge 上 HLS/FLV 一律走 MSE，
 * 原生分支仅用于 mp4/webm/ogg 这类浏览器能直接解的文件。
 */
export function detectStreamType(url: string): StreamType {
  if (HLS_RE.test(url)) return 'hls'
  if (FLV_RE.test(url) || WS_RE.test(url)) return 'flv'
  return 'native'
}

/** 直播推断：WebSocket 流一定是直播，其余交给调用方显式声明 */
export function inferLive(url: string): boolean {
  return WS_RE.test(url)
}

export function resolveStreamType(url: string, type: StreamTypeOption = 'auto'): StreamType {
  return type === 'auto' ? detectStreamType(url) : type
}

/** 把一个可能带 query 的地址归一化，用于元素池 key 与去重 */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url, location.href).href
  } catch {
    return url
  }
}
