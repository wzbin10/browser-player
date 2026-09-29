/**
 * browser-player 多路并发调度验证页
 *
 * 目标：把 SDK 的"全局单例调度器"行为视觉化 ——
 *   ① 恒定只有 ≤ maxActiveDecoders 路真正持有解码器；
 *   ② 离屏延迟释放（默认 1200ms）、滚回立即恢复；
 *   ③ 可见实例超上限时立即抢占让位；
 *   ④ 标签页切后台全量释放、回前台自动恢复；
 *   ⑤ 全部销毁后注册实例与 DOM video 双双归零。
 *
 * 本文件由 esbuild 打包为 demo/.build/main.js，由 demo/index.html 以 module 方式加载。
 */

import { createPlayer, scheduler, type BrowserPlayer } from '../src/index'

// ---------------------------------------------------------------- 测试源

interface Source {
  name: string
  url: string
}

/**
 * 16 路混合源，拉满解码压力验证调度器极限并发是否卡顿：
 *   ① 前 6 路原生 mp4（循环播放，便于持续观察）
 *   ② 第 7–8 路 HLS，验证 hls.js 的 MSE 通道一并纳入调度
 *   ③ 第 9–10 路 FLV，验证 mpegts.js 的 MSE 通道并发解码
 *      （两路共用同一点播 sample，隔离「并发 FLV 解码」这一变量；FLV 源在
 *       字节跳动 CDN，大陆网络直连最佳，若你的环境无法解析可在卡片内改地址）
 *   ④ 第 11–12 路 2K / 第 13–15 路 4K / 第 16 路 8K，逐级抬升单路码率
 *      8K 走 lorem.video 按需转码，首次加载较慢且可能失败；
 *      若你有更稳定的 8K 直链，可在该卡片地址栏直接替换
 */
const SOURCES: Source[] = [
  { name: 'mp4 · BigBuckBunny 720p', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4' },
  { name: 'mp4 · Jellyfish 720p', url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4' },
  { name: 'mp4 · Sintel 720p', url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_1MB.mp4' },
  { name: 'mp4 · MDN flower', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
  { name: 'mp4 · w3schools bbb', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
  { name: 'mp4 · BigBuckBunny 360p', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4' },
  { name: 'hls · mux x36xhzz', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'hls · mux tos_ismc', url: 'https://test-streams.mux.dev/tos_ismc/main.m3u8' },
  { name: 'flv · xgplayer A', url: 'https://sf1-hscdn-tos.pstatp.com/obj/media-fe/xgplayer_doc_video/flv/xgplayer-demo-360p.flv' },
  { name: 'flv · xgplayer B', url: 'https://sf1-hscdn-tos.pstatp.com/obj/media-fe/xgplayer_doc_video/flv/xgplayer-demo-360p.flv' },
  { name: 'mp4 · 2K lorem bunny', url: 'https://lorem.video/1440p_h264_30fps_15s_aac_128kbps.mp4' },
  { name: 'mp4 · 2K lorem cat', url: 'https://lorem.video/cat_1440p_h264_30fps_15s_aac_128kbps.mp4' },
  { name: 'mp4 · 4K lorem bunny', url: 'https://lorem.video/4k_h264_30fps_15s_aac_128kbps.mp4' },
  { name: 'mp4 · 4K truefilesize', url: 'https://cdn.truefilesize.com/mp4/sample-4k.mp4' },
  { name: 'mp4 · 8K lorem bunny', url: 'https://lorem.video/7680x4320_h264_30fps_10s_aac_128kbps.mp4' },
  { name: 'mp4 · 4K lorem cat', url: 'https://lorem.video/cat_4k_h264_30fps_15s_aac_128kbps.mp4' },
]

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`demo 页面缺少元素：${sel}`)
  return el
}

const grid = $('#grid')
const panelInstances = $('#panel-instances')
const panelLog = $('#panel-log')
const statMax = $('#stat-max')
const statActive = $('#stat-active')
const statTasks = $('#stat-tasks')
const statDom = $('#stat-dom')
const statHeap = $('#stat-heap')
const ctlMax = $<HTMLSelectElement>('#ctl-max')
const ctlResume = $<HTMLInputElement>('#ctl-resume')

interface Card {
  name: string
  videoHost: HTMLElement
  mask: HTMLElement
  urlInput: HTMLInputElement
  chipState: HTMLElement
  chipActive: HTMLElement
  chipType: HTMLElement
  chipTime: HTMLElement
  player: BrowserPlayer | null
}

const cards: Card[] = []

/** 当前生效的并发上限（所有实例必须用同一个值，否则后建实例会覆盖全局配置） */
const currentMax = (): number => Number(ctlMax.value) || 2

// ---------------------------------------------------------------- 日志

function log(message: string, cls = ''): void {
  const line = document.createElement('div')
  line.className = cls ? `log-line ${cls}` : 'log-line'
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  line.textContent = `${t} ${message}`
  line.title = line.textContent
  panelLog.appendChild(line)
  while (panelLog.childElementCount > 400) panelLog.removeChild(panelLog.firstElementChild as Element)
  panelLog.scrollTop = panelLog.scrollHeight
}

// ---------------------------------------------------------------- 建卡

function buildCard(source: Source, index: number): Card {
  const card = document.createElement('section')
  card.className = 'card'
  card.innerHTML = `
    <div class="card-head">
      <span class="card-name">#${index + 1} ${source.name}</span>
      <span class="chip" data-role="state">idle</span>
    </div>
    <div class="card-video">
      <div class="queue-mask" data-role="mask">排队中 · 等待解码额度</div>
    </div>
    <div class="card-url">
      <input type="text" spellcheck="false" value="${source.url}" />
      <button data-act="load">切换</button>
    </div>
    <div class="card-bar">
      <button data-act="play">播放</button>
      <button data-act="pause">暂停</button>
      <button data-act="destroy">销毁</button>
    </div>
    <div class="card-meta">
      <span class="chip" data-role="active">解码器 · 否</span>
      <span class="chip" data-role="type">auto</span>
      <span class="chip" data-role="time">0.0s</span>
    </div>
  `
  grid.appendChild(card)

  const videoHost = card.querySelector<HTMLElement>('.card-video') as HTMLElement
  const mask = card.querySelector<HTMLElement>('[data-role="mask"]') as HTMLElement
  const urlInput = card.querySelector<HTMLInputElement>('.card-url input') as HTMLInputElement
  const chipState = card.querySelector<HTMLElement>('[data-role="state"]') as HTMLElement
  const chipActive = card.querySelector<HTMLElement>('[data-role="active"]') as HTMLElement
  const chipType = card.querySelector<HTMLElement>('[data-role="type"]') as HTMLElement
  const chipTime = card.querySelector<HTMLElement>('[data-role="time"]') as HTMLElement

  const entry: Card = { name: `#${index + 1}`, videoHost, mask, urlInput, chipState, chipActive, chipType, chipTime, player: null }

  card.querySelector('[data-act="play"]')?.addEventListener('click', () => {
    entry.player?.play()
    log(`${entry.name} 手动播放 → 提升优先级`, 'log-ctl')
  })
  card.querySelector('[data-act="pause"]')?.addEventListener('click', () => entry.player?.pause())
  card.querySelector('[data-act="destroy"]')?.addEventListener('click', () => {
    destroyCard(entry)
    log(`${entry.name} 已销毁`, 'log-ctl')
  })
  card.querySelector('[data-act="load"]')?.addEventListener('click', () => {
    const url = urlInput.value.trim()
    if (!url) return
    log(`${entry.name} 切换地址 → ${url}`, 'log-ctl')
    entry.player?.load(url)
  })

  return entry
}

function setChip(el: HTMLElement, text: string, tone: '' | 'ok' | 'warn' | 'err' = ''): void {
  el.textContent = text
  el.className = tone ? `chip ${tone}` : 'chip'
}

/** 未持有解码器时盖上「排队中」遮罩，避免看起来像播放失败的黑屏 */
function updateMask(entry: Card): void {
  const player = entry.player
  const queued = player != null && !player.isActive && player.currentState !== 'error'
  entry.mask.classList.toggle('show', queued)
}

// ---------------------------------------------------------------- 实例生命周期

function mountCard(entry: Card, url: string): void {
  const player = createPlayer({
    container: entry.videoHost,
    url,
    autoplay: true,
    muted: true,
    loop: true,
    // 关键：必须显式跟随顶部的并发上限，否则每个新实例都会把全局额度重置为默认 2
    maxActiveDecoders: currentMax(),
    // 顶部开关控制：失去解码权后再获得时是否从上次位置续播
    resumeOnActivate: ctlResume.checked,
  })
  entry.player = player
  entry.urlInput.value = url
  updateMask(entry)

  player.on('active', () => {
    log(`${entry.name} active ↑ 获得解码权`, 'log-active')
    setChip(entry.chipActive, '解码器 · 是', 'ok')
    updateMask(entry)
  })
  player.on('inactive', () => {
    log(`${entry.name} inactive ↓ 释放解码器`, 'log-inactive')
    setChip(entry.chipActive, '解码器 · 否', 'warn')
    updateMask(entry)
  })
  player.on('ready', ({ duration }) => {
    log(`${entry.name} ready (${duration ? duration.toFixed(1) + 's' : 'live'})`, 'log-ready')
  })
  player.on('playing', () => log(`${entry.name} playing`))
  player.on('error', (err) => log(`${entry.name} error [${err.code}] ${err.message}`, 'log-error'))
  player.on('statechange', ({ state }) => {
    setChip(entry.chipState, state, state === 'error' ? 'err' : state === 'playing' ? 'ok' : state === 'idle' ? 'warn' : '')
    updateMask(entry)
  })

  setChip(entry.chipType, player.streamType)
}

function destroyCard(entry: Card): void {
  const player = entry.player
  if (!player) return
  entry.player = null
  player.destroy()
  setChip(entry.chipState, 'destroyed', 'err')
  setChip(entry.chipActive, '解码器 · 否', 'warn')
  updateMask(entry)
}

function rebuildAll(): void {
  for (const entry of cards) destroyCard(entry)
  for (const entry of cards) mountCard(entry, entry.urlInput.value.trim())
  log(`重建全部：${cards.length} 路`, 'log-ctl')
}

// ---------------------------------------------------------------- 统计轮询

function refreshStats(): void {
  statMax.textContent = String(scheduler.maxActiveDecoders)
  statActive.textContent = String(scheduler.activeCount)
  statTasks.textContent = String(scheduler.taskCount)
  statDom.textContent = String(document.querySelectorAll('video').length)

  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  statHeap.textContent = memory ? `${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'N/A'

  const rows = cards.map((entry) => {
    const player = entry.player
    const active = player?.isActive ?? false
    const state = player?.currentState ?? 'destroyed'
    const time = player ? `${player.currentTime.toFixed(1)}s` : '–'
    return `<div class="inst-row">
      <span class="dot${active ? ' on' : ''}"></span>
      <span class="nm">${entry.name}</span>
      <span class="st">${state}</span>
      <span class="st">${time}</span>
    </div>`
  })
  panelInstances.innerHTML = rows.join('')
}

// ---------------------------------------------------------------- 顶栏控制

ctlMax.addEventListener('change', () => {
  const max = currentMax()
  // 直接改全局单例的并发额度，已注册实例会在下一次 reconcile 里被重新排序
  scheduler.configure({ maxActiveDecoders: max })
  log(`并发上限 → ${max}`, 'log-ctl')
})

// resumeOnActivate 是构造期选项，改动后需重建实例才生效
ctlResume.addEventListener('change', () => {
  log(`断点续播 → ${ctlResume.checked ? '开' : '关'}（重建已挂载实例生效）`, 'log-ctl')
  rebuildAll()
})

$('#ctl-playall').addEventListener('click', () => {
  for (const entry of cards) entry.player?.play()
  log('全部播放', 'log-ctl')
})

$('#ctl-pauseall').addEventListener('click', () => {
  for (const entry of cards) entry.player?.pause()
  log('全部暂停', 'log-ctl')
})

$('#ctl-destroyall').addEventListener('click', () => {
  for (const entry of cards) destroyCard(entry)
  log('全部销毁 → 观察 注册实例 / DOM video 是否归零', 'log-ctl')
})

$('#ctl-rebuild').addEventListener('click', rebuildAll)

// ---------------------------------------------------------------- 启动

for (let i = 0; i < SOURCES.length; i++) cards.push(buildCard(SOURCES[i], i))
for (const entry of cards) mountCard(entry, entry.urlInput.value.trim())

setInterval(refreshStats, 500)
refreshStats()

log(`demo 就绪：${cards.length} 路实例，并发上限 ${scheduler.maxActiveDecoders}，离屏延迟释放 1200ms`, 'log-ctl')
log('滚动页面观察 ①②③；切到别的标签页再回来观察 ④；点「全部销毁」观察 ⑤', 'log-ctl')
