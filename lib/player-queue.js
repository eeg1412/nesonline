/**
 * 玩家排队管理器
 * 处理观众→玩家的申请队列、游玩时间限制、倒计时交接
 */
class PlayerQueue {
  constructor(maxPlayTime, countdownDuration, maxQueueSize) {
    this.maxPlayTime = maxPlayTime // 秒
    this.countdownDuration = countdownDuration // 秒
    this.maxQueueSize = maxQueueSize

    this.currentPlayer = null // { ws, startTime, id, name }
    this.queue = [] // [{ ws, requestTime, id, name }]
    this.countdown = null // { endTime, timer }
    this.clients = new Map() // ws -> { id, name, role }

    // 外部回调
    this.onStateUpdate = null
    this.onPlayerChange = null
  }

  /**
   * 添加新客户端连接
   */
  addClient(ws) {
    const name = '玩家' + this._randomId(4)
    const client = { name, role: 'viewer' }
    this.clients.set(ws, client)
    return client
  }

  /**
   * 生成指定长度的随机英数字 ID
   */
  _randomId(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    var result = ''
    for (var i = 0; i < len; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  /**
   * 移除客户端连接（断开时调用）
   */
  removeClient(ws) {
    const client = this.clients.get(ws)
    if (!client) return

    // 当前玩家断开
    if (this.currentPlayer && this.currentPlayer.ws === ws) {
      this.clearCountdown()
      this.currentPlayer = null
      if (this.onPlayerChange) {
        this.onPlayerChange(null)
      }
      this.promoteNext()
    }

    // 从队列移除
    this.queue = this.queue.filter(q => q.ws !== ws)

    this.clients.delete(ws)
    this.emitStateUpdate()
  }

  /**
   * 申请游玩
   */
  requestPlay(ws) {
    const client = this.clients.get(ws)
    if (!client) return { success: false, error: '未知客户端' }

    // 已在游玩
    if (this.currentPlayer && this.currentPlayer.ws === ws) {
      return { success: false, error: '你已经在游玩中' }
    }

    // 已在排队
    if (this.queue.some(q => q.ws === ws)) {
      return { success: false, error: '你已经在排队中' }
    }

    // 队列已满
    if (this.queue.length >= this.maxQueueSize) {
      return { success: false, error: '排队已满，请稍后再试' }
    }

    // 没有当前玩家：直接成为玩家
    if (!this.currentPlayer) {
      this.setCurrentPlayer(ws, client)
      return { success: true, role: 'player' }
    }

    // 入队（使用高精度时间戳 + 微随机偏移处理并发）
    const now = performance.now()
    const requestTime = now + Math.random() * 0.001
    this.queue.push({ ws, requestTime, name: client.name })
    this.queue.sort((a, b) => a.requestTime - b.requestTime)
    client.role = 'queued'

    // 检查当前玩家是否超时
    this.checkPlayTime()

    this.emitStateUpdate()
    const position = this.queue.findIndex(q => q.ws === ws) + 1
    return { success: true, role: 'queued', position }
  }

  /**
   * 取消排队
   */
  cancelQueue(ws) {
    const client = this.clients.get(ws)
    if (!client) return

    const before = this.queue.length
    this.queue = this.queue.filter(q => q.ws !== ws)
    if (this.queue.length < before) {
      client.role = 'viewer'
    }

    // 如果队列清空了且正在倒计时中，取消倒计时
    if (this.queue.length === 0 && this.countdown) {
      this.clearCountdown()
    }

    this.emitStateUpdate()
  }

  /**
   * 主动结束游玩
   */
  releasePlay(ws) {
    if (!this.currentPlayer || this.currentPlayer.ws !== ws) return

    this.clearCountdown()
    const client = this.clients.get(ws)
    if (client) client.role = 'viewer'
    this.currentPlayer = null
    if (this.onPlayerChange) {
      this.onPlayerChange(null)
    }
    this.promoteNext()
  }

  /**
   * 设置当前玩家
   */
  setCurrentPlayer(ws, client) {
    this.currentPlayer = {
      ws,
      startTime: Date.now(),
      name: client.name
    }
    client.role = 'player'
    if (this.onPlayerChange) {
      this.onPlayerChange(this.currentPlayer)
    }
    this.emitStateUpdate()
  }

  /**
   * 提升队列中下一位为当前玩家
   */
  promoteNext() {
    if (this.queue.length === 0) {
      this.emitStateUpdate()
      return
    }

    const next = this.queue.shift()
    const client = this.clients.get(next.ws)
    if (!client) {
      // 客户端已断开，递归提升下一位
      this.promoteNext()
      return
    }

    this.setCurrentPlayer(next.ws, client)
  }

  /**
   * 检查当前玩家是否超时
   */
  checkPlayTime() {
    if (!this.currentPlayer || this.queue.length === 0) return
    if (this.countdown) return // 已在倒计时

    const playTime = (Date.now() - this.currentPlayer.startTime) / 1000
    if (playTime >= this.maxPlayTime) {
      this.startCountdown()
    }
  }

  /**
   * 启动倒计时
   */
  startCountdown() {
    if (this.countdown) return

    const endTime = Date.now() + this.countdownDuration * 1000

    // 通知当前玩家
    this.sendToClient(this.currentPlayer.ws, {
      type: 'countdown_start',
      seconds: this.countdownDuration,
      message: `你还有 ${this.countdownDuration} 秒游玩时间`
    })

    this.countdown = {
      endTime,
      timer: setTimeout(() => {
        this.onCountdownEnd()
      }, this.countdownDuration * 1000)
    }

    this.emitStateUpdate()
  }

  /**
   * 倒计时结束回调
   */
  onCountdownEnd() {
    this.countdown = null

    if (this.currentPlayer) {
      const client = this.clients.get(this.currentPlayer.ws)
      if (client) client.role = 'viewer'

      this.sendToClient(this.currentPlayer.ws, {
        type: 'turn_ended',
        message: '你的游玩时间已结束'
      })

      this.currentPlayer = null
      if (this.onPlayerChange) {
        this.onPlayerChange(null)
      }
    }

    this.promoteNext()
  }

  /**
   * 清除倒计时
   */
  clearCountdown() {
    if (this.countdown) {
      clearTimeout(this.countdown.timer)
      this.countdown = null
    }
  }

  /**
   * 获取当前玩家的游玩时长（秒）
   */
  getPlayTime() {
    if (!this.currentPlayer) return 0
    return Math.floor((Date.now() - this.currentPlayer.startTime) / 1000)
  }

  /**
   * 生成发送给指定客户端的状态信息
   */
  getState(forWs) {
    const client = this.clients.get(forWs)
    const queuePosition = this.queue.findIndex(q => q.ws === forWs) + 1

    return {
      type: 'state',
      currentPlayer: this.currentPlayer
        ? {
            name: this.currentPlayer.name,
            playTime: this.getPlayTime()
          }
        : null,
      queueLength: this.queue.length,
      role: client ? client.role : 'viewer',
      queuePosition: queuePosition > 0 ? queuePosition : null,
      countdown: this.countdown
        ? Math.max(0, Math.ceil((this.countdown.endTime - Date.now()) / 1000))
        : null,
      viewerCount: this.clients.size
    }
  }

  /**
   * 发出状态更新通知
   */
  emitStateUpdate() {
    if (this.onStateUpdate) {
      this.onStateUpdate()
    }
  }

  /**
   * 向指定客户端发送 JSON 消息
   */
  sendToClient(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data))
    }
  }

  /**
   * 将所有玩家重置为观众（游戏重启时使用）
   */
  resetAllToViewers() {
    // 清除倒计时
    this.clearCountdown()

    // 当前玩家变为观众
    if (this.currentPlayer) {
      const client = this.clients.get(this.currentPlayer.ws)
      if (client) client.role = 'viewer'
      this.currentPlayer = null
      if (this.onPlayerChange) {
        this.onPlayerChange(null)
      }
    }

    // 排队中的玩家全部变为观众
    for (const q of this.queue) {
      const client = this.clients.get(q.ws)
      if (client) client.role = 'viewer'
    }
    this.queue = []

    this.emitStateUpdate()
  }

  /**
   * 每秒调用，检查超时并更新状态
   */
  tick() {
    this.checkPlayTime()
  }
}

module.exports = PlayerQueue
