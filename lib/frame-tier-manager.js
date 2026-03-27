/**
 * 帧率分级管理器
 * 管理多级帧率（60/30/15fps）的编码和分发
 * 按需创建编码器，只在有订阅者时才执行对应级别的编码
 *
 * 工作原理：
 * - 游戏循环始终以 60fps 运行，每帧调用 processFrame()
 * - 根据当前连接的客户端所需帧率级别，决定哪些级别需要编码
 * - 60fps: 每帧编码, 30fps: 每 2 帧编码, 15fps: 每 4 帧编码
 * - 音频在编码间隔期间累积，确保每个编码帧包含完整的音频数据
 * - 自动模式通过 RTT ping/pong 测量网络延迟来决定帧率级别
 */
const FrameEncoder = require('./frame-encoder')

class FrameTierManager {
  constructor(keyframeInterval) {
    this.keyframeInterval = keyframeInterval
    this.TIERS = [60, 30, 15]

    // 每级帧率的编码器（延迟创建，无订阅者时不存在）
    this.encoders = new Map()

    // 每级帧率的音频累积缓冲
    this.tierAudioBuffers = new Map()

    // 客户端帧率偏好: ws -> 'auto'|60|30|15
    this.clientPreference = new Map()

    // 客户端有效帧率: ws -> 60|30|15
    this.clientEffectiveTier = new Map()

    // RTT 测量（用于 auto 模式）: ws -> { lastPing, rtt, samples }
    this.clientRTT = new Map()

    // 待发关键帧的客户端（按帧率级别分组）: tier -> Set<ws>
    this.pendingKeyframe = new Map()

    this.frameCount = 0

    // Auto 模式 RTT 阈值
    this.RTT_TIER_60 = 80 // RTT < 80ms → 60fps
    this.RTT_TIER_30 = 200 // 80-200ms → 30fps, >200ms → 15fps

    // Ping 间隔（ms）
    this.PING_INTERVAL = 5000
  }

  /**
   * 注册客户端
   */
  addClient(ws, preference) {
    preference = preference || 'auto'
    this.clientPreference.set(ws, preference)
    this.clientRTT.set(ws, { lastPing: 0, rtt: -1, samples: [] })
    this._resolveEffectiveTier(ws)

    const tier = this.clientEffectiveTier.get(ws)
    this._addPendingKeyframe(tier, ws)
  }

  /**
   * 注销客户端
   */
  removeClient(ws) {
    this.clientPreference.delete(ws)
    this.clientEffectiveTier.delete(ws)
    this.clientRTT.delete(ws)
    for (const [, set] of this.pendingKeyframe) {
      set.delete(ws)
    }
    this._pruneEncoders()
  }

  /**
   * 设置客户端帧率偏好
   */
  setPreference(ws, preference) {
    if (preference !== 'auto' && !this.TIERS.includes(preference)) return

    const oldTier = this.clientEffectiveTier.get(ws)
    this.clientPreference.set(ws, preference)
    this._resolveEffectiveTier(ws)
    const newTier = this.clientEffectiveTier.get(ws)

    if (oldTier !== newTier) {
      this._addPendingKeyframe(newTier, ws)
      this._pruneEncoders()
    }
  }

  /**
   * 处理客户端 pong 响应，计算 RTT
   */
  handlePong(ws, sentTime) {
    const rttInfo = this.clientRTT.get(ws)
    if (!rttInfo) return

    const rtt = Date.now() - sentTime
    rttInfo.samples.push(rtt)
    if (rttInfo.samples.length > 5) rttInfo.samples.shift()

    // 使用中位数 RTT（比平均值更稳定）
    const sorted = rttInfo.samples.slice().sort(function (a, b) {
      return a - b
    })
    rttInfo.rtt = sorted[Math.floor(sorted.length / 2)]

    // Auto 模式下重新计算帧率级别
    if (this.clientPreference.get(ws) === 'auto') {
      const oldTier = this.clientEffectiveTier.get(ws)
      this._resolveEffectiveTier(ws)
      const newTier = this.clientEffectiveTier.get(ws)
      if (oldTier !== newTier) {
        this._addPendingKeyframe(newTier, ws)
        this._pruneEncoders()
      }
    }
  }

  /**
   * 获取客户端有效帧率
   */
  getEffectiveTier(ws) {
    return this.clientEffectiveTier.get(ws) || 30
  }

  /**
   * 获取客户端偏好设置
   */
  getPreference(ws) {
    return this.clientPreference.get(ws) || 'auto'
  }

  /**
   * 获取当前有订阅者的帧率级别集合
   */
  getActiveTiers() {
    const tiers = new Set()
    for (const [, tier] of this.clientEffectiveTier) {
      tiers.add(tier)
    }
    return tiers
  }

  /**
   * 处理一帧：累积音频，在适当时机对活跃级别执行编码
   * @param {Array} pixels NES 帧缓冲
   * @param {number[]} audioSamples 本帧音频采样
   * @returns {Map<number, {full: Buffer, noAudio: Buffer}>} 各级别的编码结果
   */
  processFrame(pixels, audioSamples) {
    this.frameCount++
    const results = new Map()
    const activeTiers = this.getActiveTiers()

    // 为每个活跃帧率级别累积音频
    for (const tier of activeTiers) {
      if (!this.tierAudioBuffers.has(tier)) {
        this.tierAudioBuffers.set(tier, [])
      }
      const buf = this.tierAudioBuffers.get(tier)
      for (let i = 0; i < audioSamples.length; i++) {
        buf.push(audioSamples[i])
      }
    }

    // 对每个活跃帧率级别，检查是否到了编码时机
    for (const tier of activeTiers) {
      const interval = Math.round(60 / tier) // 60→1, 30→2, 15→4
      if (this.frameCount % interval !== 0) continue

      // 确保编码器存在
      let encoder = this.encoders.get(tier)
      if (!encoder) {
        // 按比例调整关键帧间隔，保持各级别关键帧时间间隔一致
        const adjustedInterval = Math.max(
          1,
          Math.round(this.keyframeInterval / interval)
        )
        encoder = new FrameEncoder(adjustedInterval)
        this.encoders.set(tier, encoder)
      }

      // 检查是否有待发关键帧
      const pending = this.pendingKeyframe.get(tier)
      if (pending && pending.size > 0) {
        encoder.forceNextKeyframe()
        pending.clear()
      }

      // 编码（使用累积的音频）
      const accumulated = this.tierAudioBuffers.get(tier) || []
      const encoded = encoder.encodeFrame(pixels, accumulated)
      results.set(tier, encoded)

      // 清空此级别的音频缓冲
      this.tierAudioBuffers.set(tier, [])
    }

    return results
  }

  /**
   * 获取需要发送 ping 的 auto 模式客户端列表
   */
  getClientsNeedingPing() {
    const now = Date.now()
    const clients = []
    for (const [ws, rttInfo] of this.clientRTT) {
      if (
        this.clientPreference.get(ws) === 'auto' &&
        now - rttInfo.lastPing >= this.PING_INTERVAL
      ) {
        rttInfo.lastPing = now
        clients.push(ws)
      }
    }
    return clients
  }

  /**
   * 重置所有编码器（游戏重启时调用）
   */
  reset() {
    this.encoders.clear()
    this.tierAudioBuffers.clear()
    this.pendingKeyframe.clear()
    this.frameCount = 0

    // 标记所有客户端需要关键帧
    for (const [ws, tier] of this.clientEffectiveTier) {
      this._addPendingKeyframe(tier, ws)
    }
  }

  // ========== 内部方法 ==========

  /**
   * 计算客户端的有效帧率级别
   */
  _resolveEffectiveTier(ws) {
    const pref = this.clientPreference.get(ws)
    if (pref !== 'auto') {
      this.clientEffectiveTier.set(ws, pref)
      return
    }

    // Auto 模式：根据 RTT 决定
    const rttInfo = this.clientRTT.get(ws)
    if (!rttInfo || rttInfo.rtt < 0) {
      // 无 RTT 数据时默认原始帧率（向下兼容）
      this.clientEffectiveTier.set(ws, 60)
      return
    }

    if (rttInfo.rtt < this.RTT_TIER_60) {
      this.clientEffectiveTier.set(ws, 60)
    } else if (rttInfo.rtt < this.RTT_TIER_30) {
      this.clientEffectiveTier.set(ws, 30)
    } else {
      this.clientEffectiveTier.set(ws, 15)
    }
  }

  /**
   * 标记客户端需要在指定帧率级别上接收关键帧
   */
  _addPendingKeyframe(tier, ws) {
    if (!this.pendingKeyframe.has(tier)) {
      this.pendingKeyframe.set(tier, new Set())
    }
    this.pendingKeyframe.get(tier).add(ws)
  }

  /**
   * 清理无订阅者的编码器，释放资源
   */
  _pruneEncoders() {
    const activeTiers = this.getActiveTiers()
    for (const [tier] of this.encoders) {
      if (!activeTiers.has(tier)) {
        this.encoders.delete(tier)
        this.tierAudioBuffers.delete(tier)
      }
    }
  }
}

module.exports = FrameTierManager
