const jsnes = require('jsnes')
const Mappers = require('jsnes/src/mappers')
const Tile = require('jsnes/src/tile')
const fs = require('fs')
const path = require('path')

// ── Mapper 74 补丁 ──────────────────────────────────────────────────────────
// 参考 tsnes Mapper74 设计：Mapper 74 = MMC3 (Mapper 4) 变种，
// CHR bank 值 8、9 映射到 2KB CHR-RAM 而非 CHR-ROM。
// tsnes 中 Mapper74 直接继承 Mapper4 无需额外代码（因其 CHR 全部可写），
// 但 jsnes 的 ptTile/vromTile 引用体系要求 CHR-RAM 使用独立 Tile 对象。
// 核心思路：仅重写 load1kVromBank 拦截 bank 8/9，完全复用 Mapper4 的
// bank 选择逻辑（executeCommand），避免重复代码。
;(function patchMapper74() {
  if (Mappers[74]) return

  // 保存 Mapper0 原始 load1kVromBank 引用，供 CHR-ROM bank 调用
  var baseLoad1kVromBank = Mappers[0].prototype.load1kVromBank

  Mappers[74] = function (nes) {
    Mappers[4].call(this, nes)
    // 2KB CHR-RAM 缓冲区 (bank 8 → offset 0~1023, bank 9 → offset 1024~2047)
    this.chrRam = new Uint8Array(2048)
    // 128 个独立 Tile 对象 (2 banks × 64 tiles/bank)，隔离 vromTile 引用
    this.chrRamTiles = new Array(128)
    for (var i = 0; i < 128; i++) {
      this.chrRamTiles[i] = new Tile()
    }
    // 8 个 1KB PPU 槽位的 CHR-RAM bank 映射 (-1 = CHR-ROM)
    this.slotChrRamBank = new Int8Array(8)
    this.slotChrRamBank.fill(-1)
    this._ppuHooked = false
  }

  Mappers[74].prototype = Object.create(Mappers[4].prototype)
  Mappers[74].prototype.constructor = Mappers[74]

  /**
   * 安装 PPU writeMem 钩子，拦截对 CHR-RAM 区域的写入
   */
  Mappers[74].prototype._hookPpuWriteMem = function () {
    if (this._ppuHooked) return
    this._ppuHooked = true

    var mapper = this
    var ppu = this.nes.ppu
    var origWriteMem = ppu.writeMem

    ppu.writeMem = function (address, value) {
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
   * 将 chrRam 数据写入 vramMem 并用独立 Tile 替换 ptTile 引用
   */
  Mappers[74].prototype._loadChrRamBank = function (ramBank, address) {
    var ppu = this.nes.ppu
    var ramOffset = ramBank * 1024
    var tileOffset = ramBank * 64

    for (var i = 0; i < 1024; i++) {
      ppu.vramMem[address + i] = this.chrRam[ramOffset + i]
    }

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
   * 重写 load1kVromBank：bank 8/9 使用 CHR-RAM，其余委托父类加载 CHR-ROM。
   * Mapper4 的 executeCommand 调用 this.load1kVromBank()，
   * 因此无需重写 executeCommand 即可拦截所有 CHR bank 切换。
   */
  Mappers[74].prototype.load1kVromBank = function (bank1k, address) {
    var slot = (address >> 10) & 7

    if (bank1k === 8 || bank1k === 9) {
      this.slotChrRamBank[slot] = bank1k - 8
      this.nes.ppu.triggerRendering()
      this._loadChrRamBank(bank1k - 8, address)
    } else {
      this.slotChrRamBank[slot] = -1
      baseLoad1kVromBank.call(this, bank1k, address)
    }
  }

  /** 覆盖 loadROM 以安装 PPU 钩子 */
  Mappers[74].prototype.loadROM = function () {
    Mappers[4].prototype.loadROM.call(this)
    this._hookPpuWriteMem()
  }

  /** 序列化：附加 CHR-RAM 数据 */
  Mappers[74].prototype.toJSON = function () {
    var s = Mappers[4].prototype.toJSON.call(this)
    s.chrRam = Array.from(this.chrRam)
    s.slotChrRamBank = Array.from(this.slotChrRamBank)
    return s
  }

  /** 反序列化：恢复 CHR-RAM 数据和 Tile 对象 */
  Mappers[74].prototype.fromJSON = function (s) {
    Mappers[4].prototype.fromJSON.call(this, s)
    if (s.chrRam) {
      this.chrRam = new Uint8Array(s.chrRam)
    }
    if (s.slotChrRamBank) {
      this.slotChrRamBank = new Int8Array(s.slotChrRamBank)
    }
    this._hookPpuWriteMem()

    // 从 chrRam 重建 Tile 像素数据
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

    // 恢复所有 CHR-RAM 槽位
    for (var slot = 0; slot < 8; slot++) {
      var ramBank = this.slotChrRamBank[slot]
      if (ramBank >= 0) {
        this._loadChrRamBank(ramBank, slot << 10)
      }
    }
  }

  /**
   * ppu.fromJSON 之后调用，从 vramMem（权威数据源）反向同步 chrRam 和 Tile
   */
  Mappers[74].prototype.postFromJSON = function () {
    var ppu = this.nes.ppu

    for (var slot = 0; slot < 8; slot++) {
      var ramBank = this.slotChrRamBank[slot]
      if (ramBank < 0) continue

      var address = slot << 10
      var ramOffset = ramBank * 1024
      var tileOffset = ramBank * 64

      // vramMem → chrRam 反向同步
      for (var i = 0; i < 1024; i++) {
        this.chrRam[ramOffset + i] = ppu.vramMem[address + i]
      }

      // 重建 Tile 并设置 ptTile 引用
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

// ── PPU 逐扫描线精灵渲染补丁 ────────────────────────────────────────────────
// 采用 jsnes PR#633 的每扫描线精灵评估方案，替代原版有缺陷的批量裁剪渲染。
// 原版 renderSpritesPartially 的 srcy1/srcy2 裁剪公式有 off-by-one 错误，
// 当精灵跨越 triggerRendering 分段边界时，像素会"泄漏"到相邻段，
// 在 MMC3/Mapper 74 帧中切换 CHR bank 时表现为精灵错位或撕裂。
//
// 新方案：
// 1. evaluateSpritesForScanlines() 预计算每条扫描线上的精灵列表（最多8个/行）
// 2. renderSpritesPartially() 逐扫描线渲染，每个精灵只渲染1行，无需裁剪计算
// 3. 副产物：正确实现硬件 8-sprite-per-scanline 限制和溢出标志
;(function patchPpuSpriteRendering() {
  var PPU = require('jsnes/src/ppu')

  // 懒初始化每扫描线精灵评估缓冲区（无法修改构造函数，首次调用时创建）
  function ensureSpriteBuffers(ppu) {
    if (!ppu._spriteCountOnLine) {
      ppu._spriteCountOnLine = new Uint8Array(240)
      ppu._spritesOnLine = new Uint8Array(240 * 8)
    }
  }

  /**
   * 评估每条扫描线上的精灵，模拟 NES PPU 硬件行为：
   * 按 OAM 顺序（sprite 0 优先）扫描，每条扫描线最多选择8个精灵。
   * 第9个精灵触发溢出标志（$2002 bit 5）。
   * 参考: https://www.nesdev.org/wiki/PPU_sprite_evaluation
   */
  PPU.prototype.evaluateSpritesForScanlines = function (startscan, scancount) {
    ensureSpriteBuffers(this)

    var spriteHeight = this.f_spriteSize === 0 ? 8 : 16
    var endScan = startscan + scancount
    if (endScan > 240) endScan = 240

    var counts = this._spriteCountOnLine
    var sprites = this._spritesOnLine

    // 清零当前渲染范围
    for (var s = startscan; s < endScan; s++) {
      counts[s] = 0
    }

    // 按 OAM 顺序评估所有64个精灵
    for (var i = 0; i < 64; i++) {
      // 精灵屏幕Y范围: sprY[i]+1 .. sprY[i]+spriteHeight (含)
      var sprTop = this.sprY[i] + 1
      var sprBot = sprTop + spriteHeight

      // 与渲染范围求交集
      var scanStart = sprTop < startscan ? startscan : sprTop
      var scanEnd = sprBot > endScan ? endScan : sprBot
      if (scanStart >= scanEnd) continue

      for (var s = scanStart; s < scanEnd; s++) {
        var count = counts[s]
        if (count < 8) {
          sprites[s * 8 + count] = i
          counts[s] = count + 1
        } else if (count === 8) {
          // 第9个精灵 — 设置溢出标志，停止对此行记录
          this.setStatusFlag(this.STATUS_SLSPRITECOUNT, true)
          counts[s] = 9
        }
      }
    }
  }

  /**
   * 逐扫描线渲染精灵。使用 evaluateSpritesForScanlines() 预计算的
   * 每扫描线精灵列表，每个精灵只渲染当前扫描线对应的1行像素。
   * 彻底避免 srcy 裁剪计算及其边界 bug。
   */
  PPU.prototype.renderSpritesPartially = function (
    startscan,
    scancount,
    bgPri
  ) {
    if (this.f_spVisibility !== 1) return
    ensureSpriteBuffers(this)

    var endScan = startscan + scancount
    if (endScan > 240) endScan = 240

    var counts = this._spriteCountOnLine
    var sprites = this._spritesOnLine

    for (var scan = startscan; scan < endScan; scan++) {
      var count = counts[scan]
      if (count > 8) count = 8

      for (var n = 0; n < count; n++) {
        var i = sprites[scan * 8 + n]

        if (this.bgPriority[i] !== bgPri) continue
        if (this.sprX[i] < 0 || this.sprX[i] >= 256) continue

        // 精灵内部行号 (0-7 for 8x8, 0-15 for 8x16)
        var sprRow = scan - this.sprY[i] - 1

        if (this.f_spriteSize === 0) {
          // ── 8x8 精灵 ──
          var tileIdx =
            this.f_spPatternTable === 0
              ? this.sprTile[i]
              : this.sprTile[i] + 256

          this.ptTile[tileIdx].render(
            this.buffer,
            0,
            sprRow,
            8,
            sprRow + 1,
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

          if (sprRow < 8) {
            // 上半部分
            this.ptTile[top + (this.vertFlip[i] ? 1 : 0)].render(
              this.buffer,
              0,
              sprRow,
              8,
              sprRow + 1,
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
            // 下半部分
            this.ptTile[top + (this.vertFlip[i] ? 0 : 1)].render(
              this.buffer,
              0,
              sprRow - 8,
              8,
              sprRow - 8 + 1,
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
    }
  }

  // 包装 renderFramePartially，在渲染精灵前先执行精灵评估
  var origRenderFramePartially = PPU.prototype.renderFramePartially
  PPU.prototype.renderFramePartially = function (startScan, scanCount) {
    if (this.f_spVisibility === 1) {
      this.evaluateSpritesForScanlines(startScan, scanCount)
    }
    origRenderFramePartially.call(this, startScan, scanCount)
  }
})()
// ── PPU 逐扫描线精灵渲染补丁结束 ───────────────────────────────────────────

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
