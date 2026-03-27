/**
 * 客户端主入口
 * 建立 WebSocket 连接，协调渲染器、音频播放器、输入处理器和 UI
 */
;(function () {
  'use strict'

  var AUDIO_SAMPLE_RATE = 44100

  // 初始化各模块
  var canvas = document.getElementById('game-canvas')
  var renderer = new Renderer(canvas)
  var audioPlayer = new AudioPlayer(AUDIO_SAMPLE_RATE)
  var ui = new UI()

  var ws = null
  var reconnectTimer = null
  var connected = false
  var audioEnabled = false // 默认关闭，用户手动开启
  var fpsPreference = loadFPSPreference()

  function loadFPSPreference() {
    var v = localStorage.getItem('fpsPreference')
    if (v === '60' || v === '30' || v === '15' || v === 'auto') {
      return v
    }
    return 'auto'
  }

  function saveFPSPreference(v) {
    localStorage.setItem('fpsPreference', v)
  }

  // ========== WebSocket 连接 ==========

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(protocol + '//' + location.host)
    ws.binaryType = 'arraybuffer'

    ws.onopen = function () {
      connected = true
      ui.hideConnecting()
      ui.showToast('已连接到服务器')

      // 重连后恢复音频偏好（服务端默认为关闭，开启时需重新告知）
      if (audioEnabled) {
        sendJSON({ type: 'set_audio', enabled: true })
      }

      // 恢复帧率偏好
      sendJSON({
        type: 'set_fps',
        fps: fpsPreference === 'auto' ? 'auto' : parseInt(fpsPreference, 10)
      })

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    ws.onmessage = function (event) {
      if (event.data instanceof ArrayBuffer) {
        handleFrame(event.data)
      } else {
        handleTextMessage(event.data)
      }
    }

    ws.onclose = function () {
      connected = false
      ui.showConnecting()
      ui.showToast('连接断开，正在重连...')
      audioPlayer.reset()
      scheduleReconnect()
    }

    ws.onerror = function () {
      // onclose 会紧随其后触发
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connect()
    }, 2000)
  }

  // ========== 帧数据处理 ==========

  function handleFrame(buffer) {
    var view = new DataView(buffer)
    var offset = 0

    if (buffer.byteLength < 8) return

    // 帧头 (8 bytes)
    var packetType = view.getUint8(offset)
    offset += 1
    if (packetType !== 0x01) return

    // var frameSeq = view.getUint32(offset, true)
    offset += 4
    // var flags = view.getUint8(offset)
    offset += 1
    var paletteSize = view.getUint16(offset, true)
    offset += 2

    // 调色盘
    if (paletteSize > 0) {
      var paletteByteLen = paletteSize * 4
      if (offset + paletteByteLen > buffer.byteLength) return
      var paletteData = new Uint8Array(buffer, offset, paletteByteLen)
      renderer.updatePalette(paletteData)
      offset += paletteByteLen
    }

    // 瓦片数量
    if (offset + 2 > buffer.byteLength) return
    var tileCount = view.getUint16(offset, true)
    offset += 2

    // 瓦片差量
    for (var i = 0; i < tileCount; i++) {
      if (offset + 66 > buffer.byteLength) break
      var pos = view.getUint16(offset, true)
      offset += 2
      var tileData = new Uint8Array(buffer, offset, 64)
      renderer.applyTileDelta(pos, tileData)
      offset += 64
    }

    renderer.flush()

    // 音频
    if (offset + 2 > buffer.byteLength) return
    var sampleCount = view.getUint16(offset, true)
    offset += 2

    if (sampleCount > 0 && offset + sampleCount * 2 <= buffer.byteLength) {
      var pcmData = new Int16Array(buffer, offset, sampleCount)
      audioPlayer.scheduleSamples(pcmData)
    }
  }

  // ========== 文本消息处理 ==========

  function handleTextMessage(data) {
    try {
      var msg = JSON.parse(data)

      switch (msg.type) {
        case 'state':
          ui.updateState(msg)
          break

        case 'ping':
          if (typeof msg.t === 'number') {
            sendJSON({ type: 'pong', t: msg.t })
          }
          break

        case 'request_play_result':
          if (msg.success) {
            if (msg.role === 'player') {
              ui.showToast('你现在是玩家！')
            } else {
              ui.showToast('已加入排队，位置: 第' + msg.position + '位')
            }
          } else {
            ui.showToast(msg.error)
          }
          break

        case 'countdown_start':
          ui.showToast(msg.message, 5000)
          break

        case 'turn_ended':
          ui.showToast(msg.message)
          break
      }
    } catch (_e) {
      // 忽略解析错误
    }
  }

  // ========== 输入发送 ==========

  function sendJSON(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
    }
  }

  function sendInput(button, state) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      var buffer = new ArrayBuffer(2)
      var view = new DataView(buffer)
      view.setUint8(0, state)
      view.setUint8(1, button)
      ws.send(buffer)
    }
  }

  // ========== 初始化输入处理器 ==========

  // eslint-disable-next-line no-unused-vars
  var inputHandler = new InputHandler(sendInput)

  // ========== UI 按钮事件 ==========

  document
    .getElementById('btn-request-play')
    .addEventListener('click', function () {
      audioPlayer.init()
      audioPlayer.resume()
      sendJSON({ type: 'request_play' })
    })

  document
    .getElementById('btn-cancel-queue')
    .addEventListener('click', function () {
      sendJSON({ type: 'cancel_queue' })
    })

  document
    .getElementById('btn-release-play')
    .addEventListener('click', function () {
      sendJSON({ type: 'release_play' })
    })

  // ========== 音效切换 ==========

  function updateSoundButtonUI() {
    var btn = document.getElementById('btn-toggle-sound')
    if (!btn) return
    btn.textContent = audioEnabled ? '🔊' : '🔇'
    btn.title = audioEnabled ? '关闭音效' : '开启音效'
    btn.setAttribute('aria-label', audioEnabled ? '关闭音效' : '开启音效')
    if (audioEnabled) {
      btn.classList.add('sound-on')
    } else {
      btn.classList.remove('sound-on')
    }
  }

  document
    .getElementById('btn-toggle-sound')
    .addEventListener('click', function () {
      audioEnabled = !audioEnabled
      audioPlayer.init()
      audioPlayer.resume()
      audioPlayer.setMuted(!audioEnabled)
      sendJSON({ type: 'set_audio', enabled: audioEnabled })
      updateSoundButtonUI()
      ui.showToast(audioEnabled ? '音效已开启' : '音效已关闭', 1500)
    })

  // ========== 帧率模式切换 ==========
  var fpsModeEl = document.getElementById('fps-mode')
  if (fpsModeEl) {
    fpsModeEl.value = fpsPreference
    fpsModeEl.addEventListener('change', function () {
      fpsPreference = fpsModeEl.value
      saveFPSPreference(fpsPreference)
      sendJSON({
        type: 'set_fps',
        fps: fpsPreference === 'auto' ? 'auto' : parseInt(fpsPreference, 10)
      })
    })
  }

  // ========== 音频激活（浏览器策略要求用户交互后才能播放音频）==========

  function activateAudio() {
    audioPlayer.init()
    audioPlayer.resume()
  }

  document.addEventListener('click', activateAudio, { once: true })
  document.addEventListener('touchstart', activateAudio, { once: true })
  document.addEventListener('keydown', activateAudio, { once: true })

  // ========== 启动连接 ==========

  connect()
})()
