/**
 * 输入处理器
 * 捕获键盘和触摸屏输入，通过回调发送到服务器
 */
/* exported InputHandler */
class InputHandler {
  constructor(sendInputFn) {
    this.sendInput = sendInputFn
    this.activeKeys = new Set()

    // 键盘映射 (code → NES button index)
    this.keyMap = {
      'ArrowUp': 4,
      'ArrowDown': 5,
      'ArrowLeft': 6,
      'ArrowRight': 7,
      'KeyZ': 0,        // A
      'KeyX': 1,        // B
      'Space': 2,       // Select
      'Enter': 3,       // Start
      'KeyA': 0,        // A (WASD 备选)
      'KeyS': 1,        // B (WASD 备选)
      'KeyW': 4,        // Up (WASD 备选)
      'KeyD': 7,        // Right (WASD 备选)
      'ShiftRight': 2,  // Select 备选
      'Backspace': 2    // Select 备选
    }

    this.setupKeyboard()
    this.setupTouch()
  }

  /**
   * 键盘事件绑定
   */
  setupKeyboard() {
    var self = this

    document.addEventListener('keydown', function (e) {
      // 避免在输入框中拦截按键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

      var button = self.keyMap[e.code]
      if (button !== undefined && !self.activeKeys.has(e.code)) {
        e.preventDefault()
        self.activeKeys.add(e.code)
        self.sendInput(button, 1)
      }
    })

    document.addEventListener('keyup', function (e) {
      var button = self.keyMap[e.code]
      if (button !== undefined) {
        e.preventDefault()
        self.activeKeys.delete(e.code)
        self.sendInput(button, 0)
      }
    })

    // 窗口失焦时释放所有按键
    window.addEventListener('blur', function () {
      self.activeKeys.forEach(function (code) {
        var button = self.keyMap[code]
        if (button !== undefined) {
          self.sendInput(button, 0)
        }
      })
      self.activeKeys.clear()
    })
  }

  /**
   * 触摸按钮事件绑定
   */
  setupTouch() {
    var self = this
    var buttons = document.querySelectorAll('[data-btn]')

    buttons.forEach(function (btn) {
      var buttonId = parseInt(btn.dataset.btn, 10)

      function onPress(e) {
        e.preventDefault()
        if (!btn.classList.contains('pressed')) {
          btn.classList.add('pressed')
          self.sendInput(buttonId, 1)
        }
      }

      function onRelease(e) {
        e.preventDefault()
        if (btn.classList.contains('pressed')) {
          btn.classList.remove('pressed')
          self.sendInput(buttonId, 0)
        }
      }

      // 触摸事件
      btn.addEventListener('touchstart', onPress, { passive: false })
      btn.addEventListener('touchend', onRelease, { passive: false })
      btn.addEventListener('touchcancel', onRelease, { passive: false })

      // 鼠标事件（桌面端测试用）
      btn.addEventListener('mousedown', onPress)
      btn.addEventListener('mouseup', onRelease)
      btn.addEventListener('mouseleave', onRelease)
    })

    // 在控制区域内阻止默认触摸行为（防止页面滚动）
    var touchControls = document.getElementById('touch-controls')
    if (touchControls) {
      touchControls.addEventListener('touchmove', function (e) {
        e.preventDefault()
      }, { passive: false })
    }
  }
}
