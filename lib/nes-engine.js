const jsnes = require('jsnes')
const fs = require('fs')
const path = require('path')

/**
 * NES 模拟器引擎封装
 * 封装 jsnes，提供帧缓冲和音频采样的捕获
 */
class NESEngine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100
    this.frameBuffer = null
    this.audioSamples = []

    this.nes = new jsnes.NES({
      onFrame: (buffer) => {
        // buffer 是 PPU 内部数组的引用，需要拷贝
        if (!this.frameBuffer) {
          this.frameBuffer = new Array(buffer.length)
        }
        for (let i = 0; i < buffer.length; i++) {
          this.frameBuffer[i] = buffer[i]
        }
      },
      onAudioSample: (left, _right) => {
        // NES 本质单声道，取左声道
        this.audioSamples.push(left)
      },
      sampleRate: this.sampleRate
    })
  }

  /**
   * 加载 ROM 文件
   * @param {string} romPath ROM 文件的路径
   */
  loadROM(romPath) {
    const resolvedPath = path.resolve(romPath)
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`ROM file not found: ${resolvedPath}`)
    }
    const data = fs.readFileSync(resolvedPath, { encoding: 'binary' })
    this.nes.loadROM(data)
  }

  /**
   * 运行一帧并返回帧数据
   * @returns {{ pixels: Array, audio: number[] }}
   */
  frame() {
    this.audioSamples = []
    this.nes.frame()
    return {
      pixels: this.frameBuffer,
      audio: this.audioSamples
    }
  }

  /**
   * 按下按钮
   * @param {number} controller 控制器编号 (1 或 2)
   * @param {number} button 按钮编号 (0-7)
   */
  buttonDown(controller, button) {
    this.nes.buttonDown(controller, button)
  }

  /**
   * 释放按钮
   * @param {number} controller 控制器编号 (1 或 2)
   * @param {number} button 按钮编号 (0-7)
   */
  buttonUp(controller, button) {
    this.nes.buttonUp(controller, button)
  }
}

// NES 按钮常量
NESEngine.BUTTON = {
  A: 0,
  B: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7
}

module.exports = NESEngine
