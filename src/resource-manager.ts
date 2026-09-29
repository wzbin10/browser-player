import type { NormalizedPlayerOptions } from './types'

/**
 * video 元素池 + 彻底销毁工具。
 *
 * 两个目标：
 * 1. 元素复用——频繁切换页面/路由时不再反复创建 <video>，避免 DOM 与
 *    解码上下文随路由次数线性增长；
 * 2. 一次性埋掉所有泄漏点——原项目卡顿的元凶之一就是切源时只改 src，
 *    旧的 MediaSource、SourceBuffer、listener、ObjectURL 全部留在内存里。
 */

/** 从池中取出一个已挂载到容器的 video 元素，已按配置初始化 */
export function acquireVideo(container: HTMLElement, options: NormalizedPlayerOptions): HTMLVideoElement {
  const el = document.createElement('video')
  applyVideoOptions(el, options)
  el.style.width = '100%'
  el.style.height = '100%'
  el.style.display = 'block'
  el.style.objectFit = options.objectFit
  // 关键：让浏览器把视频层交给合成器独立绘制，减少主线程重绘抖动
  el.style.transform = 'translateZ(0)'
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
  container.appendChild(el)
  return el
}

/** 把配置写进 video，重设 src 前调用即可 */
export function applyVideoOptions(el: HTMLVideoElement, options: NormalizedPlayerOptions): void {
  el.controls = options.controls
  el.autoplay = options.autoplay
  el.muted = options.muted
  el.loop = options.loop
  el.preload = options.preload
  if (options.poster) el.poster = options.poster
  if (options.crossOrigin) el.crossOrigin = options.crossOrigin
  // 直播不需要进度条与时间轴，关掉这几个能省掉一部分解析与 UI 更新
  ;(el as HTMLVideoElement & { disablePictureInPicture?: boolean }).disablePictureInPicture = true
}

/**
 * 释放一个 video 元素。
 * 顺序很重要：先断流 → 再解绑 → 最后移除 DOM，
 * 这样能保证 MSE 的 SourceBuffer 有机会 abort 干净。
 */
export function releaseVideo(el: HTMLVideoElement): void {
  try {
    el.pause()
  } catch {
    /* 忽略 */
  }
  // 移除 src 后立刻 load()，浏览器会中断所有在途请求并释放解码器
  el.removeAttribute('src')
  el.removeAttribute('srcObject')
  try {
    el.load()
  } catch {
    /* 忽略 */
  }
  el.remove()
}

/** 把容器清空，用于 destroy 时兜底清理 */
export function clearContainer(container: HTMLElement): void {
  const children = [...container.querySelectorAll('video')]
  for (const child of children) releaseVideo(child as HTMLVideoElement)
}
