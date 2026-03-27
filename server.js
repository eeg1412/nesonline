require('dotenv').config()
const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')
const path = require('path')

const NESEngine = require('./lib/nes-engine')
const FrameEncoder = require('./lib/frame-encoder')
const PlayerQueue = require('./lib/player-queue')
const GameSession = require('./lib/game-session')
const SnapshotManager = require('./lib/snapshot-manager')

// ========== 配置 ==========
const PORT = parseInt(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const ROM_PATH = process.env.ROM_PATH || './roms/game.nes'
const MAX_PLAY_TIME = parseInt(process.env.MAX_PLAY_TIME_SECONDS) || 300
const COUNTDOWN_SECONDS = parseInt(process.env.COUNTDOWN_SECONDS) || 10
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE) || 50
const AUDIO_SAMPLE_RATE = parseInt(process.env.AUDIO_SAMPLE_RATE) || 44100
const KEYFRAME_INTERVAL = parseInt(process.env.KEYFRAME_INTERVAL) || 300
const SNAPSHOT_INTERVAL_SEC =
  parseInt(process.env.SNAPSHOT_INTERVAL_SECONDS) || 1
const SNAPSHOT_ARCHIVE_EVERY_N =
  parseInt(process.env.SNAPSHOT_ARCHIVE_EVERY_N) || 3600
const SNAPSHOT_MAX_ARCHIVES = parseInt(process.env.SNAPSHOT_MAX_ARCHIVES) || 72
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || './snapshots'
const RESET_PASSWORD = process.env.RESET_PASSWORD || ''

// ========== 初始化 ==========
const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// 创建游戏组件
const engine = new NESEngine(AUDIO_SAMPLE_RATE)
const encoder = new FrameEncoder(KEYFRAME_INTERVAL)
const queue = new PlayerQueue(MAX_PLAY_TIME, COUNTDOWN_SECONDS, MAX_QUEUE_SIZE)
const snapshotMgr = new SnapshotManager({
  snapshotDir: SNAPSHOT_DIR,
  snapshotIntervalSec: SNAPSHOT_INTERVAL_SEC,
  archiveEveryN: SNAPSHOT_ARCHIVE_EVERY_N,
  maxArchives: SNAPSHOT_MAX_ARCHIVES
})
const session = new GameSession(engine, encoder, queue)

// 加载 ROM
try {
  engine.loadROM(ROM_PATH)
  console.log(`ROM loaded: ${path.resolve(ROM_PATH)}`)
} catch (err) {
  console.error(`Failed to load ROM: ${err.message}`)
  console.error('Please place a .nes ROM file and set ROM_PATH in .env')
  process.exit(1)
}

// 恢复快照
const savedState = snapshotMgr.loadLatest()
if (savedState) {
  try {
    const ok = engine.loadState(savedState)
    if (ok) {
      console.log('Game state restored from snapshot')
    } else {
      console.log('Snapshot version mismatch, starting fresh game')
    }
  } catch (err) {
    console.error(`Failed to restore snapshot: ${err.message}`)
    console.log('Starting fresh game')
  }
}

// 启动定期快照（slim=true 剔除 romData 和渲染缓冲区）
const getStateFn = () => engine.saveState(true)

// 设置游戏会话暂停/恢复回调，控制快照和游戏循环生命周期
session.onResume = () => {
  snapshotMgr.start(getStateFn)
}
session.onPause = () => {
  // 暂停前执行一次最终快照，然后停止定期快照
  snapshotMgr.takeSnapshot(getStateFn)
  snapshotMgr.stop()
}

// 游戏循环和快照在第一个客户端连接时自动启动
console.log('Game engine ready, waiting for clients to start game loop...')

// ========== HTTP API ==========
app.post('/api/reset', (req, res) => {
  const password = req.body && req.body.password
  if (!RESET_PASSWORD || password !== RESET_PASSWORD) {
    return res.status(403).json({ success: false, error: '密码错误' })
  }

  try {
    // 停止快照
    snapshotMgr.stop()

    // 重置游戏会话（引擎、编码器、队列）
    session.reset()

    // 重新加载 ROM
    engine.loadROM(ROM_PATH)
    console.log('Game reset: ROM reloaded')

    // 如果有客户端连接，重启快照
    if (session.clients.size > 0) {
      snapshotMgr.start(getStateFn)
    }

    res.json({ success: true, message: '游戏已重启' })
  } catch (err) {
    console.error('Reset failed:', err.message)
    res.status(500).json({ success: false, error: '重启失败: ' + err.message })
  }
})

// ========== WebSocket 连接处理 ==========
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const client = session.addClient(ws)
  console.log(
    `[+] ${client.name} connected from ${ip} (total: ${wss.clients.size})`
  )

  ws.on('message', (data, isBinary) => {
    session.handleMessage(ws, data, isBinary)
  })

  ws.on('close', () => {
    console.log(
      `[-] ${client.name} disconnected (total: ${wss.clients.size - 1})`
    )
    session.removeClient(ws)
  })

  ws.on('error', err => {
    console.error(`[!] WebSocket error for ${client.name}: ${err.message}`)
  })
})

// ========== 启动 ==========

server.listen(PORT, HOST, () => {
  console.log('========================================')
  console.log('         NES Online Server')
  console.log('========================================')
  console.log(`Address:          http://${HOST}:${PORT}`)
  console.log(`ROM:              ${path.resolve(ROM_PATH)}`)
  console.log(`Max play time:    ${MAX_PLAY_TIME}s`)
  console.log(`Countdown:        ${COUNTDOWN_SECONDS}s`)
  console.log(`Max queue size:   ${MAX_QUEUE_SIZE}`)
  console.log(`Audio sample rate:${AUDIO_SAMPLE_RATE}Hz`)
  console.log(`Keyframe interval:${KEYFRAME_INTERVAL} frames`)
  console.log(
    `Snapshot:         every ${SNAPSHOT_INTERVAL_SEC}s, archive/${SNAPSHOT_ARCHIVE_EVERY_N}, max ${SNAPSHOT_MAX_ARCHIVES}`
  )
  console.log(`Snapshot dir:     ${path.resolve(SNAPSHOT_DIR)}`)
  console.log('========================================')
})

// 优雅关闭
function gracefulShutdown() {
  console.log('\nShutting down...')
  snapshotMgr.stop()
  // snapshotMgr.saveImmediate(() => engine.saveState(true))
  snapshotMgr.terminate()
  session.stop()
  wss.close()
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
