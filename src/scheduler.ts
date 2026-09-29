/**
 * 全局解码调度器（SDK 的核心）。
 *
 * 浏览器能同时维持的硬件解码上下文非常有限（Chrome 上量级在十几路，
 * 且随分辨率升高急剧下降），一旦超限就会静默回退软件解码，表现为
 * 「页面越长越卡、内存越滚越大」。因此这里做两件事：
 *
 *   1. 只有真正可见的实例才持有解码器（IntersectionObserver 驱动）；
 *   2. 可见实例超出 maxActiveDecoders 时，按优先级 + LRU 抢占。
 *
 * 因为同时真正在解码的实例恒定在 maxActiveDecoders 以内，
 * 页面开再多视频，CPU / 内存曲线也是一条平的。
 */

export interface SchedulerTask {
  readonly id: number
  readonly video: HTMLVideoElement
  /** 越大越不容易被抢占；用户主动点击播放时提升 */
  priority: number
  /** 授予解码权：此时才创建 Adapter、开始拉流 */
  onActivate(): void
  /** 收回解码权：必须彻底释放 Adapter 与缓冲区 */
  onDeactivate(): void
}

export interface SchedulerOptions {
  /** 同时解码路数上限，默认 2 */
  maxActiveDecoders?: number
  /** 可见判定阈值（0~1），默认 0，即露出一点即视为可见 */
  visibilityThreshold?: number
  /** 离屏后延迟释放解码器（毫秒），默认 1200，用于吸收快速滚动 */
  deactivateDelay?: number
}

export interface SchedulerHandle {
  readonly id: number
  unregister(): void
  setPriority(priority: number): void
  /** 立即参与一次调度，用于构造后主动触发 */
  touch(): void
}

/** 多档阈值，保证 1px 变化也能触发回调 */
const THRESHOLDS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1]

class Scheduler {
  private tasks = new Map<number, SchedulerTask>()
  private visibleIds = new Set<number>()
  private activeIds = new Set<number>()
  private lastActiveAt = new Map<number, number>()
  private deactivateTimers = new Map<number, number>()
  private observer: IntersectionObserver | null = null
  private observerSupported = typeof IntersectionObserver !== 'undefined'
  private seq = 0

  private maxDecoders = 2
  private visibilityThreshold = 0
  private deactivateDelay = 1200
  private docListenerAttached = false

  configure(options: SchedulerOptions): void {
    if (options.maxActiveDecoders != null && options.maxActiveDecoders > 0) {
      this.maxDecoders = Math.floor(options.maxActiveDecoders)
    }
    if (options.visibilityThreshold != null) {
      this.visibilityThreshold = Math.min(1, Math.max(0, options.visibilityThreshold))
    }
    if (options.deactivateDelay != null && options.deactivateDelay >= 0) {
      this.deactivateDelay = options.deactivateDelay
    }
    this.reconcile()
  }

  get maxActiveDecoders(): number {
    return this.maxDecoders
  }

  /** 当前真正持有解码器的实例数，可用于调试与埋点 */
  get activeCount(): number {
    return this.activeIds.size
  }

  get taskCount(): number {
    return this.tasks.size
  }

  isActive(id: number): boolean {
    return this.activeIds.has(id)
  }

  register(task: Omit<SchedulerTask, 'id'>): SchedulerHandle {
    const id = ++this.seq
    const full: SchedulerTask = { ...task, id }
    this.tasks.set(id, full)

    if (this.observerSupported) {
      this.ensureObserver().observe(full.video)
    } else {
      // 无 IntersectionObserver 时退化为"一直可见"，保证功能可用
      this.visibleIds.add(id)
    }
    this.ensureDocListener()
    this.scheduleFlush()

    return {
      id,
      unregister: () => this.unregister(id),
      setPriority: (priority: number) => {
        const t = this.tasks.get(id)
        if (!t) return
        t.priority = priority
        this.scheduleFlush()
      },
      touch: () => {
        // 无论当前是否活跃都刷新时间戳：这是"用户最近一次请求该实例"的记号，
        // 使主动 play()/load() 的实例在与同级优先级的实例竞争时能胜出（否则
        // 非活跃实例永远排在活跃实例之后，表现为"点了切换却没反应"）
        this.lastActiveAt.set(id, Date.now())
        this.scheduleFlush()
      },
    }
  }

  unregister(id: number): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.observer?.unobserve(task.video)
    this.tasks.delete(id)
    this.visibleIds.delete(id)
    this.activeIds.delete(id)
    this.lastActiveAt.delete(id)
    this.clearTimer(id)
  }

  private ensureObserver(): IntersectionObserver {
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLVideoElement & { __bpId?: number }).__bpId
            if (id == null || !this.tasks.has(id)) continue
            if (entry.isIntersecting && entry.intersectionRatio > this.visibilityThreshold) {
              this.visibleIds.add(id)
            } else if (!entry.isIntersecting) {
              this.visibleIds.delete(id)
            }
          }
          this.scheduleFlush()
        },
        { threshold: THRESHOLDS },
      )
    }
    return this.observer
  }

  private ensureDocListener(): void {
    if (this.docListenerAttached) return
    this.docListenerAttached = true
    // 标签页切到后台时浏览器本来就会降频，但 MSE 实例仍在占内存与带宽，主动释放更干净
    document.addEventListener('visibilitychange', () => this.scheduleFlush())
  }

  /** 调度结果合并到微任务，避免同一帧内多次 DOM 观察触发重复计算 */
  private scheduleFlush(): void {
    void Promise.resolve().then(() => this.reconcile())
  }

  private clearTimer(id: number): void {
    const timer = this.deactivateTimers.get(id)
    if (timer != null) {
      window.clearTimeout(timer)
      this.deactivateTimers.delete(id)
    }
  }

  private activate(id: number): void {
    const task = this.tasks.get(id)
    if (!task || this.activeIds.has(id)) return
    this.clearTimer(id)
    this.activeIds.add(id)
    this.lastActiveAt.set(id, Date.now())
    try {
      task.onActivate()
    } catch (err) {
      console.error('[browser-player] onActivate failed:', err)
    }
  }

  private deactivateNow(id: number): void {
    this.clearTimer(id)
    if (!this.activeIds.delete(id)) return
    this.lastActiveAt.delete(id)
    const task = this.tasks.get(id)
    if (!task) return
    try {
      task.onDeactivate()
    } catch (err) {
      console.error('[browser-player] onDeactivate failed:', err)
    }
  }

  /** 延迟释放，吸收"滚过去又滚回来"的抖动 */
  private deactivateLater(id: number): void {
    if (!this.activeIds.has(id) || this.deactivateTimers.has(id)) return
    if (this.deactivateDelay === 0) {
      this.deactivateNow(id)
      return
    }
    const timer = window.setTimeout(() => {
      this.deactivateTimers.delete(id)
      if (!this.visibleIds.has(id)) this.deactivateNow(id)
    }, this.deactivateDelay)
    this.deactivateTimers.set(id, timer)
  }

  /** 核心：一次算出"谁该持有解码器" */
  private reconcile(): void {
    if (document.hidden) {
      // 后台标签页：全部释放，回到前台由 visibilitychange 重新调度
      for (const id of [...this.activeIds]) this.deactivateNow(id)
      return
    }

    // 重新可见的实例取消待释放计时
    for (const id of [...this.deactivateTimers.keys()]) {
      if (this.visibleIds.has(id)) this.clearTimer(id)
    }

    const ranked = [...this.visibleIds].sort((a, b) => {
      const ta = this.tasks.get(a)
      const tb = this.tasks.get(b)
      const pa = ta?.priority ?? 0
      const pb = tb?.priority ?? 0
      if (pa !== pb) return pb - pa
      return (this.lastActiveAt.get(b) ?? 0) - (this.lastActiveAt.get(a) ?? 0)
    })

    const keep = new Set(ranked.slice(0, this.maxDecoders))

    for (const id of ranked) {
      if (keep.has(id)) this.activate(id)
    }

    for (const id of [...this.activeIds]) {
      if (!this.visibleIds.has(id)) {
        this.deactivateLater(id)
      } else if (!keep.has(id)) {
        // 可见但超出配额：立即让位，让新可见的实例尽快出画
        this.deactivateNow(id)
      }
    }
  }

  /** 仅供测试 / 重置用 */
  reset(): void {
    for (const id of [...this.tasks.keys()]) this.unregister(id)
    this.observer?.disconnect()
    this.observer = null
  }
}

/** 全局单例：整个页面共用一份并发额度 */
export const scheduler = new Scheduler()

/** 注册任务的便捷入口，内部同时把 id 挂到 video 上供 IntersectionObserver 反查 */
export function registerWithScheduler(
  video: HTMLVideoElement,
  task: Omit<SchedulerTask, 'id' | 'video'>,
): SchedulerHandle {
  const handle = scheduler.register({ ...task, video })
  ;(video as HTMLVideoElement & { __bpId?: number }).__bpId = handle.id
  return handle
}
