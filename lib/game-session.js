/**
 * 游戏会话
 * 协调 NES 引擎、帧编码器、玩家队列，驱动 60fps 游戏循环并广播帧数据
 */
const FrameTierManager = require('./frame-tier-manager')

class GameSession {
  constructor(nesEngine, frameEncoder, playerQueue) {
    this.engine = nesEngine
    this.encoder = frameEncoder
    this.queue = playerQueue

    this.clients = new Set() // 所有 WebSocket 连接
    this.audioEnabledClients = new Set() // 主动开启音效的客户端（默认关闭节省带宽）
    this.running = false
    this.frameInterval = 1000 / 60 // ~16.667ms

    // 新连接需要收到关键帧，标记待发送
    this.pendingKeyframeClients = new Set()

    // 帧率分级管理器（多级帧率编码与自动调节）
    this.tierManager = new FrameTierManager(frameEncoder.keyframeInterval)

    // 暂停/恢复回调（由 server.js 设置，用于控制快照管理器等）
    this.onPause = null
    this.onResume = null

    // 绑定队列状态更新回调
    this.queue.onStateUpdate = () => this.broadcastStateToAll()
    this.queue.onPlayerChange = () => {
      // 玩家切换时释放所有按键
      for (let btn = 0; btn <= 7; btn++) {
        this.engine.buttonUp(1, btn)
      }
    }
  }

  /**
   * 添加客户端连接
   */
  addClient(ws) {
    this.clients.add(ws)
    this.pendingKeyframeClients.add(ws)
    this.tierManager.addClient(ws)
    const client = this.queue.addClient(ws)

    // 发送初始状态
    const state = this.queue.getState(ws)
    state.fpsPreference = this.tierManager.getPreference(ws)
    state.fpsTier = this.tierManager.getEffectiveTier(ws)
    ws.send(JSON.stringify(state))

    // 第一个客户端连接时恢复游戏循环
    if (this.clients.size === 1) {
      this._resume()
    }

    return client
  }

  /**
   * 移除客户端连接
   */
  removeClient(ws) {
    this.clients.delete(ws)
    this.audioEnabledClients.delete(ws)
    this.pendingKeyframeClients.delete(ws)
    this.tierManager.removeClient(ws)
    this.queue.removeClient(ws)

    // 最后一个客户端断开时暂停游戏循环
    if (this.clients.size === 0) {
      this._pause()
    }
  }

  /**
   * 处理玩家输入
   */
  handleInput(ws, button, state) {
    // 只接受当前玩家的输入
    if (!this.queue.currentPlayer || this.queue.currentPlayer.ws !== ws) return
    if (button < 0 || button > 7) return

    if (state === 1) {
      this.engine.buttonDown(1, button)
    } else {
      this.engine.buttonUp(1, button)
    }
  }

  /**
   * 处理 WebSocket 消息（二进制或文本）
   */
  handleMessage(ws, data, isBinary) {
    if (isBinary) {
      // 二进制消息：输入指令 [state(1B), button(1B)]
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buf.length >= 2) {
        const state = buf.readUInt8(0)
        const button = buf.readUInt8(1)
        if (button <= 7 && (state === 0 || state === 1)) {
          this.handleInput(ws, button, state)
        }
      }
      return
    }

    // 文本消息：JSON
    try {
      const msg = JSON.parse(data.toString())
      switch (msg.type) {
        case 'request_play': {
          const result = this.queue.requestPlay(ws)
          ws.send(JSON.stringify({ type: 'request_play_result', ...result }))
          break
        }
        case 'cancel_queue': {
          this.queue.cancelQueue(ws)
          break
        }
        case 'release_play': {
          this.queue.releasePlay(ws)
          break
        }
        case 'set_audio': {
          if (msg.enabled === true) {
            this.audioEnabledClients.add(ws)
          } else {
            this.audioEnabledClients.delete(ws)
          }
          break
        }
        case 'set_fps': {
          var fps = msg.fps
          if (fps === 'auto' || fps === 60 || fps === 30 || fps === 15) {
            this.tierManager.setPreference(ws, fps)
            var fpsState = this.queue.getState(ws)
            fpsState.fpsPreference = this.tierManager.getPreference(ws)
            fpsState.fpsTier = this.tierManager.getEffectiveTier(ws)
            ws.send(JSON.stringify(fpsState))
          }
          break
        }
        case 'pong': {
          if (typeof msg.t === 'number') {
            this.tierManager.handlePong(ws, msg.t)
          }
          break
        }
        case 'set_name': {
          const client = this.queue.clients.get(ws)
          if (client && msg.name && typeof msg.name === 'string') {
            // 限制昵称长度，过滤特殊字符
            client.name = msg.name.replace(/[<>&"']/g, '').substring(0, 20)
            if (
              this.queue.currentPlayer &&
              this.queue.currentPlayer.ws === ws
            ) {
              this.queue.currentPlayer.name = client.name
            }
            const queueEntry = this.queue.queue.find(q => q.ws === ws)
            if (queueEntry) {
              queueEntry.name = client.name
            }
            this.broadcastStateToAll()
          }
          break
        }
      }
    } catch (_e) {
      // 忽略无效消息
    }
  }

  /**
   * 启动 60fps 游戏循环
   */
  start() {
    if (this.running) return
    this.running = true

    let nextFrameTime = performance.now()
    let stateTickCounter = 0

    const loop = () => {
      if (!this.running) return

      // === 运行一帧 ===
      const { pixels, audio } = this.engine.frame()

      // === 帧率分级编码与广播 ===
      const tierResults = this.tierManager.processFrame(pixels, audio)

      for (const ws of this.clients) {
        if (ws.readyState !== 1) continue
        const tier = this.tierManager.getEffectiveTier(ws)
        const encoded = tierResults.get(tier)
        if (!encoded) continue
        ws.send(
          this.audioEnabledClients.has(ws) ? encoded.full : encoded.noAudio
        )
      }

      // === 每秒发送状态更新 ===
      stateTickCounter++
      if (stateTickCounter >= 60) {
        stateTickCounter = 0
        this.queue.tick()
        this.broadcastStateToAll()
        this._sendAutoPings()
      }

      // === 调度下一帧（漂移校正） ===
      nextFrameTime += this.frameInterval
      const now = performance.now()
      const delay = Math.max(0, nextFrameTime - now)

      // 如果落后太多（>100ms），重置时基
      if (nextFrameTime < now - 100) {
        nextFrameTime = now
      }

      setTimeout(loop, delay)
    }

    nextFrameTime = performance.now()
    loop()
    console.log('Game loop started at 60 FPS')
  }

  /**
   * 停止游戏循环
   */
  stop() {
    this.running = false
  }

  /**
   * 恢复游戏循环（有客户端连接时调用）
   */
  _resume() {
    if (this.running) return
    console.log('Game loop resumed (clients connected)')
    if (this.onResume) this.onResume()
    this.start()
  }

  /**
   * 暂停游戏循环（无客户端时调用）
   */
  _pause() {
    if (!this.running) return
    console.log('Game loop paused (no clients)')
    this.stop()
    if (this.onPause) this.onPause()
  }

  /**
   * 向所有客户端广播状态
   */
  broadcastStateToAll() {
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue
      const state = this.queue.getState(ws)
      state.fpsPreference = this.tierManager.getPreference(ws)
      state.fpsTier = this.tierManager.getEffectiveTier(ws)
      ws.send(JSON.stringify(state))
    }
  }

  /**
   * 向 auto 模式客户端发送 RTT ping
   */
  _sendAutoPings() {
    const clients = this.tierManager.getClientsNeedingPing()
    const now = Date.now()
    for (let i = 0; i < clients.length; i++) {
      const ws = clients[i]
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', t: now }))
      }
    }
  }

  /**
   * 重置游戏会话
   * 停止循环、释放所有按键、重置编码器和队列，为重新加载 ROM 做准备
   */
  reset() {
    // 停止游戏循环
    this.stop()

    // 释放所有按键
    for (let btn = 0; btn <= 7; btn++) {
      this.engine.buttonUp(1, btn)
    }

    // 重置帧编码器状态
    this.encoder.reset()

    // 重置帧率分级管理器
    this.tierManager.reset()

    // 将所有玩家重置为观众
    this.queue.resetAllToViewers()

    // 标记所有客户端需要接收关键帧
    for (const ws of this.clients) {
      this.pendingKeyframeClients.add(ws)
    }

    // 广播重置通知和新状态
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue
      ws.send(
        JSON.stringify({ type: 'turn_ended', message: '游戏已被管理员重启' })
      )
    }
    this.broadcastStateToAll()

    // 如果有客户端，恢复游戏循环
    if (this.clients.size > 0) {
      this.start()
    }
  }
}

module.exports = GameSession
