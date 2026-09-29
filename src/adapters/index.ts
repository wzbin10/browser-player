import type { Adapter, AdapterContext } from './types'
import { Html5Adapter } from './html5'
import { HlsAdapter } from './hls'
import { FlvAdapter } from './flv'
import { resolveStreamType } from '../utils/stream'

/**
 * 按协议创建对应通道。
 * 静态 import 三个实现是安全的：hls.js / mpegts.js 本身是动态 import，
 * 没装依赖时只是该路不可用，不会影响主包加载。
 */
export function createAdapter(ctx: AdapterContext): Adapter {
  const type = resolveStreamType(ctx.url, ctx.options.type)
  switch (type) {
    case 'hls':
      return new HlsAdapter(ctx)
    case 'flv':
      return new FlvAdapter(ctx)
    default:
      return new Html5Adapter(ctx)
  }
}

export type { Adapter, AdapterContext }
export { Html5Adapter, HlsAdapter, FlvAdapter }
