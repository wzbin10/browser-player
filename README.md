# browser-player

面向桌面 Chrome / Edge 的多路浏览器视频播放 SDK。

统一封装 **mp4 / HLS(m3u8) / HTTP-FLV / WebSocket-FLV**，用一个全局单例调度器把「同一时刻真正解码的路数」压到可控范围，从而解决原生 `<video>` 在页面多视频并发播放、切换时出现的**卡顿、CPU 飙升、内存滚雪球**问题。

## 为什么需要它

浏览器原生 `<video>` 多路播放卡顿，根因有四条：

1. **硬件解码上下文有限**——Chrome 能同时维持的硬解上下文很少且随分辨率升高急剧下降，一旦超限就**静默回退软解**，CPU 立刻飙高；
2. **每个实例独占一套 MSE**——`<video>` + `MediaSource` + `SourceBuffer` 无法回收，内存随实例数线性叠加；
3. **离屏实例无人管**——画面滚出视口后仍在解码、仍在灌 buffer；
4. **切换时不销毁**——反复赋 `src`、叠加 `MediaSource`，泄漏 listener 与 ObjectURL。

本 SDK 的对策是：**只有可见、且排进并发额度的实例才持有解码器**，其余实例保持 poster 占位、不占解码器与带宽。因为同时真正解码的实例数恒定在 `maxActiveDecoders` 以内，所以页面开再多视频，CPU / 内存曲线都是一条平的。

## 安装

```bash
npm i browser-player

# 按需安装协议库（未用到对应协议时可不装）
npm i hls.js        # 播放 m3u8
npm i mpegts.js     # 播放 flv
```

`hls.js` / `mpegts.js` 是 **optional peerDependencies**：SDK 主包内不内联它们，而是在真正播放对应协议时才动态 `import()`。因此：
- 只用 mp4 的项目，主包约 30KB，零额外依赖；
- 用了 m3u8 / flv 的项目，才需要装对应库；
- 缺依赖时不会静默失败，会抛 `DEPENDENCY_MISSING` 错误事件并给出安装提示。

## 快速开始

```ts
import { createPlayer } from 'browser-player'

const player = createPlayer({
  container: '#app',
  url: 'https://example.com/live.flv',
  autoplay: true,
  muted: true, // Chrome 要求静音才允许无交互自动播放
})

player.on('ready', () => player.play())
```

HLS 点播：

```ts
const player = createPlayer({
  container: document.querySelector('#app')!,
  url: 'https://example.com/movie.m3u8',
  maxActiveDecoders: 3,
})
```

## 配置项（PlayerOptions）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `container` | `HTMLElement \| string` | — | **必填**。承载播放器的元素或其选择器，一个播放器对应一个容器 |
| `url` | `string` | — | **必填**。支持 mp4/webm、m3u8、flv 以及 `ws(s)://` 的 WebSocket-FLV |
| `type` | `'auto' \| 'native' \| 'hls' \| 'flv'` | `'auto'` | 协议类型，默认按 url 自动识别 |
| `autoplay` | `boolean` | `false` | 自动播放，注意 Chrome 要求 `muted` 才允许无交互自动播放 |
| `muted` | `boolean` | `false` | 静音 |
| `loop` | `boolean` | `false` | 循环播放 |
| `controls` | `boolean` | `false` | 是否显示原生控制条 |
| `poster` | `string` | — | 封面图，同时用于释放解码器后保留画面 |
| `preload` | `'none' \| 'metadata' \| 'auto'` | `'metadata'` | 预加载策略 |
| `live` | `boolean` | 自动推断 | 直播流标记，不传时按 url 推断（`ws/wss` 视为直播） |
| `crossOrigin` | `'anonymous' \| 'use-credentials'` | — | 跨域属性 |
| `objectFit` | `'contain' \| 'cover' \| 'fill'` | `'contain'` | 画面填充方式 |
| `maxActiveDecoders` | `number` | `2` | **全局同时解码路数上限**（进程级配置，任一实例设置后会覆盖全局值） |
| `visibilityThreshold` | `number` | `0` | 可见性判定阈值（0~1），0 表示露出一点即视为可见 |
| `backBufferLength` | `number` | `30` | 点播回看缓冲上限（秒），直播固定为无上限 |
| `liveSyncDuration` | `number` | `2` | 直播起播/追帧目标延迟（秒） |
| `liveMaxBufferLength` | `number` | `10` | 直播最大缓冲（秒） |
| `maxRetries` | `number` | `2` | 致命错误自动重试次数 |
| `resumeOnActivate` | `boolean` | `false` | 失去解码权后重新获得时是否从上次位置续播；默认 `false` 即从头播，直播不适用 |

> `maxActiveDecoders` 是**整页共享**的并发额度，不是单个播放器的私有配置。同页多个实例谁先创建谁先设置，后设置的会覆盖前面的值。建议在应用入口统一显式设置一次。

## 事件（PlayerEventMap）

```ts
player.on('statechange', ({ state }) => console.log(state))
player.on('error', (err) => console.error(err.code, err.message))
```

| 事件 | payload | 触发时机 |
| --- | --- | --- |
| `ready` | `{ duration: number }` | 元数据就绪，可播放 |
| `play` | `undefined` | 调用 play / 用户触发起播 |
| `pause` | `undefined` | 暂停 |
| `playing` | `undefined` | 真正出画（首帧已渲染） |
| `waiting` | `undefined` | 缓冲中 |
| `ended` | `undefined` | 播放结束 |
| `error` | `PlayerError` | 出错，含 `code` / `message` / `fatal` |
| `timeupdate` | `{ currentTime, duration }` | 播放进度更新 |
| `progress` | `{ buffered, duration }` | 缓冲进度更新；`buffered` 通常为已缓冲到的时间点（秒），MSE 直播通道下由码率统计驱动 |
| `volumechange` | `{ volume, muted }` | 音量/静音变化 |
| `ratechange` | `{ playbackRate }` | 倍速变化 |
| `statechange` | `{ state: PlayerState }` | 状态机变化 |
| `active` | `undefined` | **调度器授予解码权**，开始真正加载 |
| `inactive` | `undefined` | **调度器收回解码权**，解码器已释放 |
| `destroy` | `undefined` | 实例销毁 |

`active` / `inactive` 是做「当前哪几路真正在放」提示、或懒加载 UI 的关键事件。

错误码常量（`ERROR_CODE`）：

| 码 | 含义 |
| --- | --- |
| `NETWORK_ERROR` | 请求失败 / 断网 |
| `MEDIA_ERROR` | 解码或媒体格式错误 |
| `NOT_ALLOWED` | 自动播放被浏览器拦截 |
| `UNSUPPORTED` | 当前浏览器不支持该协议 |
| `DEPENDENCY_MISSING` | 缺少可选依赖（hls.js / mpegts.js） |

## API

### 属性

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `currentState` | `PlayerState` | 当前状态：`idle` / `loading` / `ready` / `playing` / `paused` / `ended` / `error` / `destroyed` |
| `streamType` | `'native' \| 'hls' \| 'flv'` | 实际生效的协议通道 |
| `isActive` | `boolean` | 是否正持有解码器 |
| `element` | `HTMLVideoElement` | 底层 video 元素，需要自定义 UI 时可读写 |
| `duration` | `number` | 时长（秒），未知时为 0 |
| `currentTime` | `number` | 当前播放位置（秒） |
| `volume` | `number` | 音量 0~1 |
| `muted` | `boolean` | 是否静音 |
| `paused` | `boolean` | 是否暂停 |

### 方法

| 方法 | 说明 |
| --- | --- |
| `play(): Promise<void>` | 播放；同时提升调度优先级，抢占时优先保住这一路 |
| `pause(): void` | 暂停；同时降低调度优先级 |
| `load(url: string, autoplay?): Promise<void>` | 切换地址，先彻底销毁旧通道再建新的，杜绝 MSE 叠加 |
| `reload(): Promise<void>` | 重新加载当前地址，用于致命错误后的手动重试 |
| `seek(time: number): void` | 跳到指定秒；直播会 clamp 到可 seek 区间 |
| `setVolume(volume: number): void` | 设置音量（0~1，自动 clamp） |
| `setMuted(muted: boolean): void` | 设置静音 |
| `setPlaybackRate(rate: number): void` | 设置倍速 |
| `on(event, fn): () => void` | 订阅事件，返回取消订阅函数 |
| `once(event, fn): () => void` | 订阅一次 |
| `off(event, fn): void` | 取消订阅 |
| `destroy(): void` | **销毁实例，必须调用** |

### 工具函数

```ts
import { detectStreamType, inferLive, resolveStreamType } from 'browser-player'

detectStreamType('a.m3u8')      // 'hls'
detectStreamType('a.flv')       // 'flv'
detectStreamType('ws://x/y')    // 'flv'
inferLive('ws://x/y')           // true
resolveStreamType(url, 'auto')  // 综合 type 与 url 得出最终通道
```

## 多路播放关键提示

1. **同一页面多个实例共享全局并发额度。** `maxActiveDecoders` 是进程级配置，建议在应用入口统一设置一次，不要在业务组件里各写各的。

2. **离屏实例会自动释放解码器**，画面回到 `poster`。可通过 `active` / `inactive` 事件感知，用于更新 UI（例如给"已暂停以节省资源"的卡片加遮罩）。默认离开再回来是**从头播**；若希望接着上次位置播，把 `resumeOnActivate` 设为 `true`（仅点播生效，直播始终从最新位置起播）。

3. **切换视频务必用 `player.load(newUrl)` 或先 `player.destroy()`**，不要直接改 `video.src`。直接改 src 会绕过调度器与资源回收，重新踩回 MSE 叠加、listener 泄漏的老坑。

4. **组件卸载时一定要 `destroy()`。** 这是 SDK 里唯一且必须走完的释放出口，会依次完成：退订调度 → 释放 Adapter → 摘除事件 → 从 DOM 移除元素 → 清空监听。

   ```ts
   // Vue
   onUnmounted(() => player.destroy())
   // React
   useEffect(() => () => player.destroy(), [])
   ```

5. **并发路数怎么定。** 默认 2 是保守值。若机器性能好、分辨率不高，可调到 3~4；但要注意每路 1080p 硬解上下文开销较大，调高不一定更流畅，反而可能触发软解回退。

6. **无交互自动播放**必须 `muted: true`，否则会收到 `NOT_ALLOWED` 错误事件。

## 已知边界

- 只面向**桌面 Chrome / Edge**，不做 iOS Safari 兼容。
- MSE 通道的音频仅支持 AAC / MP3 / Opus。
- H.265(HEVC) 依赖操作系统提供 HEVC 硬解能力，浏览器不支持时无法播放。
- 直播的 `backBufferLength` 固定为无上限（以保证追帧与 seek 可用）。

## 开发

```bash
npm run typecheck   # 类型检查
npm run build       # 构建 ESM + CJS + d.ts
npm run dev         # watch 构建
```

## License

MIT
