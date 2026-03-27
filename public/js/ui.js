/**
 * UI 管理器
 * 更新界面状态：玩家信息、排队信息、角色状态、倒计时、Toast 提示
 */
/* exported UI */
class UI {
  constructor() {
    this.els = {
      viewerCount: document.getElementById('viewer-count'),
      currentPlayer: document.getElementById('current-player-info'),
      playTime: document.getElementById('play-time'),
      roleInfo: document.getElementById('role-info'),
      queueInfo: document.getElementById('queue-info'),
      fpsCurrent: document.getElementById('fps-current'),
      fpsMode: document.getElementById('fps-mode'),
      btnRequestPlay: document.getElementById('btn-request-play'),
      btnCancelQueue: document.getElementById('btn-cancel-queue'),
      btnReleasePlay: document.getElementById('btn-release-play'),
      countdownOverlay: document.getElementById('countdown-overlay'),
      countdownText: document.getElementById('countdown-text'),
      connectionOverlay: document.getElementById('connection-overlay'),
      toast: document.getElementById('toast'),
      keyboardHint: document.getElementById('keyboard-hint'),
      closeHint: document.getElementById('close-hint'),
      touchControls: document.getElementById('touch-controls')
    }

    this.currentRole = 'viewer'
    this.toastTimer = null
    this.playTimeTimer = null
    this.lastPlayTimeBase = 0 // 服务端告知的游玩时间基准（秒）
    this.lastPlayTimeUpdate = 0 // 上次状态更新时间

    this.setupKeyboardHint()
    this.startPlayTimeTicker()
  }

  /**
   * 键盘提示弹窗
   */
  setupKeyboardHint() {
    var self = this

    // 检查是否非触摸设备
    if (!('ontouchstart' in window)) {
      self.els.keyboardHint.classList.remove('hidden')
    }

    if (self.els.closeHint) {
      self.els.closeHint.addEventListener('click', function () {
        self.els.keyboardHint.classList.add('hidden')
      })
    }
  }

  /**
   * 客户端侧每秒更新游玩时间显示（避免依赖服务端 1s 间隔）
   */
  startPlayTimeTicker() {
    var self = this
    this.playTimeTimer = setInterval(function () {
      if (self.lastPlayTimeBase > 0 && self.currentRole !== 'none') {
        var elapsed = Math.floor((Date.now() - self.lastPlayTimeUpdate) / 1000)
        var total = self.lastPlayTimeBase + elapsed
        self.els.playTime.textContent = '游玩时间: ' + self.formatTime(total)
      }
    }, 1000)
  }

  /**
   * 根据服务端状态更新 UI
   * @param {Object} state 服务端状态消息
   */
  updateState(state) {
    // 在线人数
    this.els.viewerCount.textContent = '在线: ' + (state.viewerCount || 0)

    // 当前玩家
    if (state.currentPlayer) {
      this.els.currentPlayer.textContent =
        '当前玩家: ' + state.currentPlayer.name
      this.els.playTime.textContent =
        '游玩时间: ' + this.formatTime(state.currentPlayer.playTime)
      this.els.playTime.classList.remove('hidden')

      // 更新本地计时基准
      this.lastPlayTimeBase = state.currentPlayer.playTime
      this.lastPlayTimeUpdate = Date.now()
    } else {
      this.els.currentPlayer.textContent = '当前玩家: 无'
      this.els.playTime.textContent = ''
      this.els.playTime.classList.add('hidden')
      this.lastPlayTimeBase = 0
    }

    // 角色
    this.currentRole = state.role
    var roleLabels = {
      viewer: '观众',
      player: '玩家',
      queued: '排队中'
    }
    this.els.roleInfo.textContent =
      '角色: ' + (roleLabels[state.role] || state.role)

    // 帧率显示（原始帧率=60fps）
    var tierLabel = {
      60: '原始帧率',
      30: '30帧率',
      15: '15帧率'
    }
    if (this.els.fpsCurrent) {
      this.els.fpsCurrent.textContent =
        '当前帧率: ' + (tierLabel[state.fpsTier] || '原始帧率')
    }
    if (this.els.fpsMode && state.fpsPreference !== undefined) {
      this.els.fpsMode.value = String(state.fpsPreference)
    }

    // 排队信息
    if (state.role === 'queued' && state.queuePosition) {
      this.els.queueInfo.textContent =
        '排队位置: 第' +
        state.queuePosition +
        '位 (共' +
        state.queueLength +
        '人)'
      this.els.queueInfo.classList.remove('hidden')
    } else if (state.queueLength > 0) {
      this.els.queueInfo.textContent = '排队人数: ' + state.queueLength
      this.els.queueInfo.classList.remove('hidden')
    } else {
      this.els.queueInfo.classList.add('hidden')
    }

    // 按钮显示
    this.toggleElement(this.els.btnRequestPlay, state.role === 'viewer')
    this.toggleElement(this.els.btnCancelQueue, state.role === 'queued')
    this.toggleElement(this.els.btnReleasePlay, state.role === 'player')

    // 虚拟按钮仅对玩家显示
    this.toggleElement(this.els.touchControls, state.role === 'player')

    // 倒计时
    if (
      state.countdown !== null &&
      state.countdown !== undefined &&
      state.countdown > 0
    ) {
      this.els.countdownOverlay.classList.remove('hidden')
      this.els.countdownText.textContent = state.countdown + 's'
    } else {
      this.els.countdownOverlay.classList.add('hidden')
    }
  }

  /**
   * 显示连接状态覆盖层
   */
  showConnecting() {
    this.els.connectionOverlay.classList.remove('hidden')
  }

  /**
   * 隐藏连接状态覆盖层
   */
  hideConnecting() {
    this.els.connectionOverlay.classList.add('hidden')
  }

  /**
   * 显示 Toast 提示
   */
  showToast(message, duration) {
    duration = duration || 3000
    this.els.toast.textContent = message
    this.els.toast.classList.remove('hidden')

    var self = this
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(function () {
      self.els.toast.classList.add('hidden')
    }, duration)
  }

  /**
   * 格式化秒数为 m:ss
   */
  formatTime(seconds) {
    var m = Math.floor(seconds / 60)
    var s = seconds % 60
    return m + ':' + (s < 10 ? '0' : '') + s
  }

  /**
   * 切换元素显示/隐藏
   */
  toggleElement(el, show) {
    if (show) {
      el.classList.remove('hidden')
    } else {
      el.classList.add('hidden')
    }
  }
}
