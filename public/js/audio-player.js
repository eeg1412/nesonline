/**
 * 音频播放器
 * 使用 Web Audio API 精确调度 PCM 采样，避免抖动
 *
 * 核心原理：
 * - 服务端每帧发送 ~735 个 int16 采样 (44100Hz / 60fps)
 * - 客户端收到后不立即播放，而是追加到 AudioContext 时间轴上
 * - nextPlayTime 指针保证音频首尾相接，网络抖动不影响播放
 * - 初始缓冲 80ms，underrun 时重新对齐 40ms
 */
/* exported AudioPlayer */
class AudioPlayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100
    this.audioCtx = null
    this.gainNode = null
    this.nextPlayTime = 0
    this.started = false
    this.initialized = false
    this.muted = true  // 默认静音，用户主动开启
  }

  /**
   * 初始化 AudioContext（必须在用户交互事件中调用）
   */
  init() {
    if (this.initialized) return
    this.initialized = true

    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.sampleRate
      })
      this.gainNode = this.audioCtx.createGain()
      this.gainNode.gain.value = 0.7
      this.gainNode.connect(this.audioCtx.destination)
    } catch (e) {
      console.warn('AudioContext initialization failed:', e)
    }
  }

  /**
   * 恢复被浏览器自动暂停的 AudioContext
   */
  resume() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume()
    }
  }

  /**
   * 设置静音状态
   * @param {boolean} value true=静音，false=播放
   */
  setMuted(value) {
    this.muted = !!value
    if (this.muted) {
      // 静音时重置时间轴，下次开启时重新建立缓冲
      this.started = false
      this.nextPlayTime = 0
    }
  }

  /**
   * 调度一帧的 PCM 音频采样
   * @param {Int16Array} pcmInt16Samples 单声道 int16 采样数组
   */
  scheduleSamples(pcmInt16Samples) {
    if (this.muted) return  // 静音：服务端不应发音频，这里作为安全兜底
    if (!this.audioCtx || !this.gainNode) return
    if (pcmInt16Samples.length === 0) return

    var sampleCount = pcmInt16Samples.length
    var duration = sampleCount / this.sampleRate

    // int16 → float32
    var float32 = new Float32Array(sampleCount)
    for (var i = 0; i < sampleCount; i++) {
      float32[i] = pcmInt16Samples[i] / 32767
    }

    // 创建音频缓冲
    var audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.sampleRate)
    audioBuffer.copyToChannel(float32, 0)

    var source = this.audioCtx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.gainNode)

    var now = this.audioCtx.currentTime

    // 首次调度：建立 80ms 初始缓冲
    if (!this.started) {
      this.nextPlayTime = now + 0.08
      this.started = true
    }

    // Underrun 检测：如果调度时间已过，重新对齐
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.04
    }

    // 防止缓冲过大（>500ms 说明客户端处理积压）
    if (this.nextPlayTime > now + 0.5) {
      this.nextPlayTime = now + 0.08
    }

    source.start(this.nextPlayTime)
    this.nextPlayTime += duration
  }

  /**
   * 设置音量 (0 ~ 1)
   */
  setVolume(value) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, value))
    }
  }

  /**
   * 重置音频状态（玩家切换时调用）
   */
  reset() {
    this.started = false
    this.nextPlayTime = 0
  }
}
