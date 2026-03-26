require('dotenv').config()
const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')
const path = require('path')

const NESEngine = require('./lib/nes-engine')
const FrameEncoder = require('./lib/frame-encoder')
const PlayerQueue = require('./lib/player-queue')
const GameSession = require('./lib/game-session')

// ========== 配置 ==========
const PORT = parseInt(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const ROM_PATH = process.env.ROM_PATH || './roms/game.nes'
const MAX_PLAY_TIME = parseInt(process.env.MAX_PLAY_TIME_SECONDS) || 300
const COUNTDOWN_SECONDS = parseInt(process.env.COUNTDOWN_SECONDS) || 10
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE) || 50
const AUDIO_SAMPLE_RATE = parseInt(process.env.AUDIO_SAMPLE_RATE) || 44100
const KEYFRAME_INTERVAL = parseInt(process.env.KEYFRAME_INTERVAL) || 300

// ========== 初始化 ==========
const app = express()
app.use(express.static(path.join(__dirname, 'public')))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// 创建游戏组件
const engine = new NESEngine(AUDIO_SAMPLE_RATE)
const encoder = new FrameEncoder(KEYFRAME_INTERVAL)
const queue = new PlayerQueue(MAX_PLAY_TIME, COUNTDOWN_SECONDS, MAX_QUEUE_SIZE)
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

// ========== WebSocket 连接处理 ==========
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const client = session.addClient(ws)
  console.log(`[+] ${client.name} connected from ${ip} (total: ${wss.clients.size})`)

  ws.on('message', (data, isBinary) => {
    session.handleMessage(ws, data, isBinary)
  })

  ws.on('close', () => {
    console.log(`[-] ${client.name} disconnected (total: ${wss.clients.size - 1})`)
    session.removeClient(ws)
  })

  ws.on('error', (err) => {
    console.error(`[!] WebSocket error for ${client.name}: ${err.message}`)
  })
})

// ========== 启动 ==========
session.start()

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
  console.log('========================================')
})

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  session.stop()
  wss.close()
  server.close(() => {
    process.exit(0)
  })
})
