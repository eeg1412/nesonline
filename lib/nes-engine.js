const jsnes = require('jsnes')
const Mappers = require('jsnes/src/mappers')
const Tile = require('jsnes/src/tile')
const fs = require('fs')
const path = require('path')

// ── Mapper 74 补丁 ──────────────────────────────────────────────────────────
// Mapper 74 = MMC3 (mapper 4) 变种，其中 CHR bank 值 8、9 映射到 2KB CHR RAM
// 而非 CHR ROM（参考 FCEUX: setchr1r(0x10, A, V)）。
// jsnes 的 load1kVromBank 会将 ptTile 替换为 vromTile 的引用，如果直接对
// 这些引用调用 setScanline 会破坏 ROM tile 缓存，导致全屏花屏。
// 解决方案：CHR RAM 区域使用独立的 Tile 对象，避免与 vromTile 共享引用。
;(function patchMapper74() {
  if (Mappers[74]) return

  Mappers[74] = function (nes) {
    Mappers[4].call(this, nes)
    // 独立 2KB CHR RAM 缓冲区 (bank 8 → offset 0~1023, bank 9 → offset 1024~2047)
    this.chrRam = new Uint8Array(2048)
    // 128 个独立 Tile 对象用于 CHR RAM (2 banks × 64 tiles/bank)
    // 避免与 vromTile 共享引用，防止 setScanline 破坏 ROM 缓存
    this.chrRamTiles = new Array(128)
    for (var i = 0; i < 128; i++) {
      this.chrRamTiles[i] = new Tile()
    }
    // 跟踪 8 个 1KB PPU 槽位当前映射的 CHR RAM bank (-1 = CHR ROM)
    this.slotChrRamBank = new Int8Array(8)
    this.slotChrRamBank.fill(-1)
    this._ppuHooked = false
  }

  Mappers[74].prototype = Object.create(Mappers[4].prototype)
  Mappers[74].prototype.constructor = Mappers[74]

  /**
   * 安装 PPU writeMem 钩子，拦截对 CHR RAM 区域的写入并同步到 chrRam 缓冲区
   */
  Mappers[74].prototype._hookPpuWriteMem = function () {
    if (this._ppuHooked) return
    this._ppuHooked = true

    var mapper = this
    var ppu = this.nes.ppu
    var origWriteMem = ppu.writeMem

    ppu.writeMem = function (address, value) {
      // 对 CHR RAM 区域，先同步到 chrRam 缓冲区
      if (address < 0x2000) {
        var slot = (address >> 10) & 7
        var ramBank = mapper.slotChrRamBank[slot]
        if (ramBank >= 0) {
          mapper.chrRam[ramBank * 1024 + (address & 0x3ff)] = value
        }
      }
      origWriteMem.call(ppu, address, value)
    }
  }

  /**
   * 将 chrRam 缓冲区数据写入 vramMem，并用独立 Tile 对象替换 ptTile 引用
   */
  Mappers[74].prototype._restoreChrRam = function (ramBank, address) {
    var ppu = this.nes.ppu
    var ramOffset = ramBank * 1024
    var tileOffset = ramBank * 64

    // 复制 chrRam → vramMem
    for (var i = 0; i < 1024; i++) {
      ppu.vramMem[address + i] = this.chrRam[ramOffset + i]
    }

    // 用独立 Tile 对象替换 ptTile，防止写入 vromTile 引用导致 ROM 缓存损坏
    var baseIndex = address >> 4
    for (var t = 0; t < 64; t++) {
      var tile = this.chrRamTiles[tileOffset + t]
      ppu.ptTile[baseIndex + t] = tile
      var tileAddr = address + t * 16
      for (var y = 0; y < 8; y++) {
        tile.setScanline(
          y,
          ppu.vramMem[tileAddr + y],
          ppu.vramMem[tileAddr + y + 8]
        )
      }
    }
  }

  /**
   * 加载 1KB CHR bank。bank 值为 8 或 9 时使用 CHR RAM，否则加载 CHR ROM。
   */
  Mappers[74].prototype._load1kChr = function (bank, address) {
    var slot = (address >> 10) & 7

    if (bank === 8 || bank === 9) {
      var ramBank = bank - 8
      this.slotChrRamBank[slot] = ramBank
      this.nes.ppu.triggerRendering()
      this._restoreChrRam(ramBank, address)
    } else {
      this.slotChrRamBank[slot] = -1
      this.load1kVromBank(bank, address)
    }
  }

  /** 覆盖 loadROM 以安装 PPU 钩子 */
  Mappers[74].prototype.loadROM = function () {
    Mappers[4].prototype.loadROM.call(this)
    this._hookPpuWriteMem()
  }

  /** 覆盖 executeCommand，对 CHR 命令使用 _load1kChr */
  Mappers[74].prototype.executeCommand = function (cmd, arg) {
    var sel = this.chrAddressSelect
    switch (cmd) {
      case this.CMD_SEL_2_1K_VROM_0000:
        if (sel === 0) {
          this._load1kChr(arg, 0x0000)
          this._load1kChr(arg + 1, 0x0400)
        } else {
          this._load1kChr(arg, 0x1000)
          this._load1kChr(arg + 1, 0x1400)
        }
        break
      case this.CMD_SEL_2_1K_VROM_0800:
        if (sel === 0) {
          this._load1kChr(arg, 0x0800)
          this._load1kChr(arg + 1, 0x0c00)
        } else {
          this._load1kChr(arg, 0x1800)
          this._load1kChr(arg + 1, 0x1c00)
        }
        break
      case this.CMD_SEL_1K_VROM_1000:
        this._load1kChr(arg, sel === 0 ? 0x1000 : 0x0000)
        break
      case this.CMD_SEL_1K_VROM_1400:
        this._load1kChr(arg, sel === 0 ? 0x1400 : 0x0400)
        break
      case this.CMD_SEL_1K_VROM_1800:
        this._load1kChr(arg, sel === 0 ? 0x1800 : 0x0800)
        break
      case this.CMD_SEL_1K_VROM_1C00:
        this._load1kChr(arg, sel === 0 ? 0x1c00 : 0x0c00)
        break
      default:
        Mappers[4].prototype.executeCommand.call(this, cmd, arg)
    }
  }

  /** 序列化：保存 CHR RAM 数据和槽位映射 */
  Mappers[74].prototype.toJSON = function () {
    var s = Mappers[4].prototype.toJSON.call(this)
    s.chrRam = Array.from(this.chrRam)
    s.slotChrRamBank = Array.from(this.slotChrRamBank)
    return s
  }

  /** 反序列化：恢复 CHR RAM 数据、槽位映射和独立 Tile 对象 */
  Mappers[74].prototype.fromJSON = function (s) {
    Mappers[4].prototype.fromJSON.call(this, s)
    if (s.chrRam) {
      this.chrRam = new Uint8Array(s.chrRam)
    }
    if (s.slotChrRamBank) {
      this.slotChrRamBank = new Int8Array(s.slotChrRamBank)
    }
    this._hookPpuWriteMem()

    // 从 chrRam 重建独立 Tile 对象的像素数据
    for (var bank = 0; bank < 2; bank++) {
      var ramOffset = bank * 1024
      var tileOffset = bank * 64
      for (var t = 0; t < 64; t++) {
        var tile = this.chrRamTiles[tileOffset + t]
        var byteBase = ramOffset + t * 16
        for (var y = 0; y < 8; y++) {
          tile.setScanline(
            y,
            this.chrRam[byteBase + y],
            this.chrRam[byteBase + y + 8]
          )
        }
      }
    }

    // 恢复所有当前映射为 CHR RAM 的槽位
    for (var slot = 0; slot < 8; slot++) {
      var ramBank = this.slotChrRamBank[slot]
      if (ramBank >= 0) {
        this._restoreChrRam(ramBank, slot << 10)
      }
    }
  }

  /**
   * 在 NES.fromJSON 全部完成（包括 ppu.fromJSON）后调用。
   * ppu.fromJSON 会用保存的状态覆写 vramMem，此时 vramMem 才是最终权威数据源。
   * 这里从 vramMem 反向同步 chrRam，并重建 chrRamTiles，确保三者完全一致。
   */
  Mappers[74].prototype.postFromJSON = function () {
    var ppu = this.nes.ppu

    for (var slot = 0; slot < 8; slot++) {
      var ramBank = this.slotChrRamBank[slot]
      if (ramBank < 0) continue

      var address = slot << 10
      var ramOffset = ramBank * 1024
      var tileOffset = ramBank * 64

      // 以 ppu.vramMem 为权威数据反向同步 chrRam
      for (var i = 0; i < 1024; i++) {
        this.chrRam[ramOffset + i] = ppu.vramMem[address + i]
      }

      // 用同步后的 vramMem 重建 chrRamTiles 并设置 ptTile 引用
      var baseIndex = address >> 4
      for (var t = 0; t < 64; t++) {
        var tile = this.chrRamTiles[tileOffset + t]
        ppu.ptTile[baseIndex + t] = tile
        var tileAddr = address + t * 16
        for (var y = 0; y < 8; y++) {
          tile.setScanline(
            y,
            ppu.vramMem[tileAddr + y],
            ppu.vramMem[tileAddr + y + 8]
          )
        }
      }
    }
  }
})()
// ── Mapper 74 补丁结束 ──────────────────────────────────────────────────────

// ── PPU renderSpritesPartially 补丁 ─────────────────────────────────────────
// 修复 jsnes 原版 renderSpritesPartially 中的以下缺陷：
// 1. 可见性检查对 8x16 精灵使用 sprY+8 而非 sprY+16，导致上半截在渲染区域外
//    的 8x16 精灵被完全跳过，下半截不渲染。
// 2. srcy2 裁剪公式有 off-by-one/two 错误，导致精灵行像素"泄漏"到下一个部分
//    渲染区域。在 MMC3/Mapper 74 中帧切换 CHR bank 时，泄漏行使用错误的 tile
//    数据渲染，表现为精灵错位或撕裂。
;(function patchPpuSpriteRendering() {
  var PPU = require('jsnes/src/ppu')

  PPU.prototype.renderSpritesPartially = function (
    startscan,
    scancount,
    bgPri
  ) {
    if (this.f_spVisibility !== 1) return

    var spriteHeight = this.f_spriteSize === 0 ? 8 : 16

    for (var i = 0; i < 64; i++) {
      if (
        this.bgPriority[i] !== bgPri ||
        this.sprX[i] < 0 ||
        this.sprX[i] >= 256
      )
        continue

      // 修复 1：可见性检查使用实际精灵高度
      if (
        this.sprY[i] + spriteHeight < startscan ||
        this.sprY[i] >= startscan + scancount
      )
        continue

      if (this.f_spriteSize === 0) {
        // ── 8x8 精灵 ──
        var srcy1 = 0
        var srcy2 = 8

        if (this.sprY[i] < startscan) {
          srcy1 = startscan - this.sprY[i] - 1
        }
        // 修复 2：srcy2 公式从 +1 修正为 -1
        if (this.sprY[i] + 8 > startscan + scancount) {
          srcy2 = startscan + scancount - this.sprY[i] - 1
        }

        var tileIdx =
          this.f_spPatternTable === 0 ? this.sprTile[i] : this.sprTile[i] + 256

        this.ptTile[tileIdx].render(
          this.buffer,
          0,
          srcy1,
          8,
          srcy2,
          this.sprX[i],
          this.sprY[i] + 1,
          this.sprCol[i],
          this.sprPalette,
          this.horiFlip[i],
          this.vertFlip[i],
          i,
          this.pixrendered
        )
      } else {
        // ── 8x16 精灵 ──
        var top = this.sprTile[i]
        if ((top & 1) !== 0) {
          top = this.sprTile[i] - 1 + 256
        }

        // 上半部分 (tile rows 0-7, 屏幕行 sprY+1 ~ sprY+8)
        var srcy1 = 0
        var srcy2 = 8

        if (this.sprY[i] < startscan) {
          srcy1 = startscan - this.sprY[i] - 1
        }
        // 修复 3：srcy2 公式从 -sprY 修正为 -sprY-1
        if (this.sprY[i] + 8 > startscan + scancount) {
          srcy2 = startscan + scancount - this.sprY[i] - 1
        }

        this.ptTile[top + (this.vertFlip[i] ? 1 : 0)].render(
          this.buffer,
          0,
          srcy1,
          8,
          srcy2,
          this.sprX[i],
          this.sprY[i] + 1,
          this.sprCol[i],
          this.sprPalette,
          this.horiFlip[i],
          this.vertFlip[i],
          i,
          this.pixrendered
        )

        // 下半部分 (tile rows 0-7, 屏幕行 sprY+9 ~ sprY+16)
        srcy1 = 0
        srcy2 = 8

        if (this.sprY[i] + 8 < startscan) {
          srcy1 = startscan - (this.sprY[i] + 8 + 1)
        }
        // 修复 4：srcy2 公式从 -(sprY+8) 修正为 -(sprY+8)-1
        if (this.sprY[i] + 16 > startscan + scancount) {
          srcy2 = startscan + scancount - (this.sprY[i] + 8) - 1
        }

        this.ptTile[top + (this.vertFlip[i] ? 0 : 1)].render(
          this.buffer,
          0,
          srcy1,
          8,
          srcy2,
          this.sprX[i],
          this.sprY[i] + 1 + 8,
          this.sprCol[i],
          this.sprPalette,
          this.horiFlip[i],
          this.vertFlip[i],
          i,
          this.pixrendered
        )
      }
    }
  }
})()
// ── PPU renderSpritesPartially 补丁结束 ─────────────────────────────────────

/**
 * NES 模拟器引擎封装
 * 封装 jsnes，提供帧缓冲和音频采样的捕获
 */

// 状态格式版本号，不匹配时丢弃旧存档
var STATE_VERSION = 2

// 精简快照时需要剔除的 PPU 渲染缓冲区（每帧会重新生成）
var PPU_STRIP_KEYS = ['buffer', 'bgbuffer', 'pixrendered', 'attrib', 'scantile']

class NESEngine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100
    this.frameBuffer = null
    this.audioSamples = []

    this.nes = new jsnes.NES({
      onFrame: buffer => {
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

  /**
   * 序列化模拟器完整状态（save state）
   * @param {boolean} [slim=false] 为 true 时剔除 romData 和渲染缓冲区以减小体积
   * @returns {Object} JSON 可序列化的状态对象
   */
  saveState(slim) {
    var state = this.nes.toJSON()
    state._ver = STATE_VERSION
    if (slim) {
      delete state.romData
      for (var i = 0; i < PPU_STRIP_KEYS.length; i++) {
        delete state.ppu[PPU_STRIP_KEYS[i]]
      }
    }
    return state
  }

  /**
   * 从序列化状态恢复模拟器（load state）
   * @param {Object} state 由 saveState() 返回的状态对象
   * @returns {boolean} 恢复成功返回 true，版本不兼容返回 false
   */
  loadState(state) {
    // 仅当 _ver 明确存在且不匹配时才拒绝；缺失 _ver 的旧存档视为兼容
    if (state._ver !== STATE_VERSION) {
      return false
    }
    this.nes.fromJSON(state)

    // ppu.fromJSON 最后执行，此时 vramMem 已是权威数据。
    // 对于 Mapper 74，需要从 vramMem 反向同步 chrRam 和 chrRamTiles。
    if (this.nes.mmap && typeof this.nes.mmap.postFromJSON === 'function') {
      this.nes.mmap.postFromJSON()
    }

    // 被 slim 模式剔除的 PPU 渲染缓冲区在首帧渲染时自动重建；
    // 但部分关键数组如果为 undefined 会导致崩溃，这里补回来。
    var ppu = this.nes.ppu
    if (!ppu.buffer) ppu.buffer = new Array(256 * 240)
    if (!ppu.bgbuffer) ppu.bgbuffer = new Array(256 * 240)
    if (!ppu.pixrendered) ppu.pixrendered = new Array(256 * 240)
    if (!ppu.attrib) ppu.attrib = new Array(32)
    if (!ppu.scantile) ppu.scantile = new Array(32)

    return true
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

NESEngine.STATE_VERSION = STATE_VERSION

module.exports = NESEngine
