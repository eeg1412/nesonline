# NES Online

云端运行的 NES 游戏服务，玩家只需在浏览器中发送按键，服务器执行模拟并将**帧差量 + PCM 音频**实时广播给玩家和观众。

## 特性

- **服务端权威**：NES 模拟器完全运行在服务端，客户端无法作弊，RNG 状态不暴露
- **帧差量广播**：只发送变化的瓦片 + 音频采样，带宽极低（RPG 静止场景 < 10 Kbps）
- **像素完美**：瓦片索引色方案，无视频压缩失真，适合像素艺术风格游戏
- **无抖动音频**：Web Audio API 精确时间轴调度，网络抖动不影响音频连续性
- **申请制轮换**：默认观众，申请后按时序排队，超时自动倒计时交接
- **全平台兼容**：响应式布局，支持键盘和触摸屏操作

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- 合法持有的 `.nes` ROM 文件

### 安装

```bash
git clone https://github.com/eeg1412/nesonline.git
cd nesonline
npm install
```

### 配置

```bash
cp .env.example .env
```

编辑 `.env`，至少设置 `ROM_PATH`：

```env
ROM_PATH=./roms/your-game.nes
```

### 启动

```bash
npm start
```

浏览器访问 `http://localhost:3000`

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP/WS 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ROM_PATH` | `./roms/game.nes` | NES ROM 文件路径 |
| `MAX_PLAY_TIME_SECONDS` | `300` | 单次最长游玩时间（秒） |
| `COUNTDOWN_SECONDS` | `10` | 超时后倒计时提醒秒数 |
| `MAX_QUEUE_SIZE` | `50` | 排队上限人数 |
| `AUDIO_SAMPLE_RATE` | `44100` | 音频采样率 (Hz) |
| `KEYFRAME_INTERVAL` | `300` | 每隔多少帧发送完整关键帧（用于新连接恢复） |

---

## 架构说明

```
玩家浏览器                     服务器 (Node.js)               观众浏览器
    │                               │                              │
    │── WebSocket ─── 按键输入 ──>  │                              │
    │                               │  NES 模拟器 (jsnes)          │
    │                               │  60fps 游戏循环              │
    │                               │  瓦片差量编码                │
    │                               │  PCM 音频打包                │
    │<── WebSocket ── 帧数据包 ───── │ ────────────────────────── > │
    │   Canvas 瓦片渲染             │                              │
    │   Web Audio 精确调度播放       │                              │
```

### 帧数据包格式

```
[1B]  packet_type   (0x01 = 游戏帧)
[4B]  frame_seq     (帧序号 uint32 LE)
[1B]  flags         (bit0: keyframe, bit1: palette_changed)
[2B]  palette_count (调色盘条目数)
[N×4B] palette      (RGBA 调色盘)
[2B]  tile_count    (变化瓦片数)
[M×66B] tiles       (2B 位置 + 64B 像素索引)
[2B]  sample_count  (PCM 采样数)
[K×2B] pcm_int16   (int16 LE 单声道)
```

### 音频无抖动原理

服务端每帧产生约 **735 个 PCM 采样**（44100 ÷ 60），与瓦片数据同包发送。客户端使用 `AudioContext.currentTime` 时钟维护 `nextPlayTime` 指针，每帧音频按顺序首尾相接追加到时间轴，无论网络包何时到达都不影响播放连续性。

### 排队系统

1. 所有连接默认为**观众**
2. 点击「申请游玩」：无玩家时立即上场；有玩家时加入排队
3. 玩家游玩超过 `MAX_PLAY_TIME_SECONDS` 后，进入 `COUNTDOWN_SECONDS` 倒计时
4. 倒计时结束后自动交接给下一位排队者
5. 并发申请通过高精度时间戳 + 随机微偏移解决

---

## 项目结构

```
nesonline/
├── server.js              # 服务器入口
├── .env.example           # 环境变量模板
├── lib/
│   ├── nes-engine.js      # jsnes 模拟器封装
│   ├── frame-encoder.js   # 帧差量 + PCM 二进制编码
│   ├── player-queue.js    # 申请制排队逻辑
│   └── game-session.js    # 游戏会话（60fps 循环 + 广播）
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── main.js        # WebSocket + 消息路由
│       ├── renderer.js    # Canvas 瓦片渲染
│       ├── audio-player.js # Web Audio 精确调度
│       ├── input-handler.js # 键盘 + 触摸输入
│       └── ui.js          # 状态面板、Toast
└── roms/                  # 放置 .nes ROM（不纳入版本控制）
```

---

## 注意事项

- ROM 文件版权归原著作权人所有，请确保你合法持有所使用的 ROM
- 本项目仅实现模拟框架，不提供任何 ROM 文件
