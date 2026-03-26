/**
 * 帧差量编码器
 * 将 NES 帧缓冲区编码为瓦片差量 + PCM 音频的二进制数据包
 *
 * 二进制帧包格式:
 * [1B]  packet_type      (0x01 = 游戏帧)
 * [4B]  frame_seq        (uint32 LE, 帧序号)
 * [1B]  flags            (bit0: keyframe, bit1: palette_changed)
 * [2B]  palette_size     (uint16 LE, 调色盘条目数, 0 表示无更新)
 * [N*4B] palette_data    (每条目: R, G, B, 0xFF)
 * [2B]  tile_count       (uint16 LE)
 * [M*(2+64)B] tile_data  (每瓦片: pos uint16 LE + 64B 像素索引)
 * [2B]  sample_count     (uint16 LE, 单声道采样数)
 * [K*2B] pcm_int16       (int16 LE 音频采样)
 */
class FrameEncoder {
  constructor(keyframeInterval) {
    this.keyframeInterval = keyframeInterval || 300
    this.frameCount = 0

    // 动态调色盘：从帧缓冲颜色值映射到紧凑索引
    this.palette = []
    this.colorToIndex = new Map()

    // 瓦片差量状态
    this.prevTileHash = new Uint32Array(960) // 30 行 × 32 列
    this.prevTileHash.fill(0xffffffff) // 初始哈希设为不可能命中的值
  }

  /**
   * 将颜色值注册到调色盘，返回是否是新颜色
   */
  registerColor(color) {
    if (this.colorToIndex.has(color)) {
      return false
    }
    this.colorToIndex.set(color, this.palette.length)
    this.palette.push(color)
    return true
  }

  /**
   * 简单快速哈希，用于瓦片差量比较
   */
  hashTile(data) {
    let hash = 0x811c9dc5
    for (let i = 0; i < 64; i++) {
      hash ^= data[i]
      hash = (hash * 0x01000193) >>> 0
    }
    return hash
  }

  /**
   * 从像素帧缓冲中提取 8×8 瓦片的调色盘索引
   */
  extractTile(indexed, tx, ty) {
    const tile = new Uint8Array(64)
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const imgX = tx * 8 + px
        const imgY = ty * 8 + py
        tile[py * 8 + px] = indexed[imgY * 256 + imgX]
      }
    }
    return tile
  }

  /**
   * 编码一帧，返回 Buffer
   * @param {Array} pixels 帧缓冲 (256×240 颜色值数组)
   * @param {number[]} audioSamples 本帧音频采样 (float -1~1)
   * @returns {Buffer}
   */
  encodeFrame(pixels, audioSamples) {
    this.frameCount++
    const isKeyframe = this.frameCount % this.keyframeInterval === 1

    // 1. 将每个像素映射到调色盘索引
    let paletteChanged = false
    const indexed = new Uint8Array(256 * 240)
    for (let i = 0; i < pixels.length; i++) {
      const color = pixels[i]
      if (this.registerColor(color)) {
        paletteChanged = true
      }
      indexed[i] = this.colorToIndex.get(color)
    }

    // 2. 提取瓦片并计算差量
    const changedTiles = []
    for (let ty = 0; ty < 30; ty++) {
      for (let tx = 0; tx < 32; tx++) {
        const tileIdx = ty * 32 + tx
        const tileData = this.extractTile(indexed, tx, ty)
        const hash = this.hashTile(tileData)

        if (isKeyframe || hash !== this.prevTileHash[tileIdx]) {
          changedTiles.push({ pos: tileIdx, data: tileData })
          this.prevTileHash[tileIdx] = hash
        }
      }
    }

    // 3. 构建二进制数据包
    const sendPalette = isKeyframe || paletteChanged
    return this.buildPacket(isKeyframe, sendPalette, changedTiles, audioSamples)
  }

  /**
   * 构建二进制帧数据包
   */
  buildPacket(isKeyframe, sendPalette, changedTiles, audioSamples) {
    const paletteEntryCount = sendPalette ? this.palette.length : 0
    const headerSize = 8
    const paletteDataSize = paletteEntryCount * 4
    const tileCountSize = 2
    const tileDataSize = changedTiles.length * 66 // 2B pos + 64B data
    const audioCountSize = 2
    const audioDataSize = audioSamples.length * 2

    const totalSize =
      headerSize +
      paletteDataSize +
      tileCountSize +
      tileDataSize +
      audioCountSize +
      audioDataSize
    const buffer = Buffer.alloc(totalSize)
    let offset = 0

    // === 帧头 (8B) ===
    buffer.writeUInt8(0x01, offset)
    offset += 1
    buffer.writeUInt32LE(this.frameCount, offset)
    offset += 4
    const flags = (isKeyframe ? 1 : 0) | (sendPalette ? 2 : 0)
    buffer.writeUInt8(flags, offset)
    offset += 1
    buffer.writeUInt16LE(paletteEntryCount, offset)
    offset += 2

    // === 调色盘 ===
    if (sendPalette) {
      for (let i = 0; i < this.palette.length; i++) {
        const c = this.palette[i]
        buffer.writeUInt8((c >> 16) & 0xff, offset)
        offset += 1 // R
        buffer.writeUInt8((c >> 8) & 0xff, offset)
        offset += 1 // G
        buffer.writeUInt8(c & 0xff, offset)
        offset += 1 // B
        buffer.writeUInt8(0xff, offset)
        offset += 1 // A
      }
    }

    // === 瓦片差量 ===
    buffer.writeUInt16LE(changedTiles.length, offset)
    offset += 2
    for (const tile of changedTiles) {
      buffer.writeUInt16LE(tile.pos, offset)
      offset += 2
      buffer.set(tile.data, offset)
      offset += 64
    }

    // 记录音频区起始位置（后续用于生成无音频版本）
    const audioOffset = offset

    // === 音频 PCM int16 ===
    buffer.writeUInt16LE(audioSamples.length, offset)
    offset += 2
    for (let i = 0; i < audioSamples.length; i++) {
      const sample = Math.max(-1, Math.min(1, audioSamples[i]))
      buffer.writeInt16LE(Math.round(sample * 32767), offset)
      offset += 2
    }

    // 无音频包：复制帧头+调色盘+瓦片部分，末尾追加 sample_count=0
    // 节省关闭音效客户端的下行带宽（省略 PCM 数据）
    const noAudio = Buffer.allocUnsafe(audioOffset + 2)
    buffer.copy(noAudio, 0, 0, audioOffset)
    noAudio.writeUInt16LE(0, audioOffset)

    return { full: buffer, noAudio }
  }
}

module.exports = FrameEncoder
