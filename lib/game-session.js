/**
 * 游戏会话
 * 协调 NES 引擎、帧编码器、玩家队列，驱动 60fps 游戏循环并广播帧数据
 */
class GameSession {
  constructor(nesEngine, frameEncoder, playerQueue) {
    this.engine = nesEngine
    this.encoder = frameEncoder
    this.queue = playerQueue

    this.clients = new Set()  // 所有 WebSocket 连接
    this.audioEnabledClients = new Set()  // 主动开启音效的客户端（默认关闭节省带宽）
    this.running = false
    this.frameInterval = 1000 / 60 // ~16.667ms

    // 新连接需要收到关键帧，标记待发送
    this.pendingKeyframeClients = new Set()

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
    const client = this.queue.addClient(ws)

    // 发送初始状态
    const state = this.queue.getState(ws)
    ws.send(JSON.stringify(state))

    return client
  }

  /**
   * 移除客户端连接
   */
  removeClient(ws) {
    this.clients.delete(ws)
    this.audioEnabledClients.delete(ws)
    this.pendingKeyframeClients.delete(ws)
    this.queue.removeClient(ws)
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
        case 'set_name': {
          const client = this.queue.clients.get(ws)
          if (client && msg.name && typeof msg.name === 'string') {
            // 限制昵称长度，过滤特殊字符
            client.name = msg.name.replace(/[<>&"']/g, '').substring(0, 20)
            if (this.queue.currentPlayer && this.queue.currentPlayer.ws === ws) {
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
      const { full, noAudio } = this.encoder.encodeFrame(pixels, audio)

      // === 广播帧数据（音效开启者发完整包，关闭者发无音频包节省带宽）===
      for (const ws of this.clients) {
        if (ws.readyState !== 1) continue
        ws.send(this.audioEnabledClients.has(ws) ? full : noAudio)
      }

      // 清除待关键帧标记（刚编码的帧可能不是 keyframe，
      // 但下一个 keyframe 会在 keyframeInterval 时自动触发）
      this.pendingKeyframeClients.clear()

      // === 每秒发送状态更新 ===
      stateTickCounter++
      if (stateTickCounter >= 60) {
        stateTickCounter = 0
        this.queue.tick()
        this.broadcastStateToAll()
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
   * 向所有客户端广播状态
   */
  broadcastStateToAll() {
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue
      const state = this.queue.getState(ws)
      ws.send(JSON.stringify(state))
    }
  }
}

module.exports = GameSession
