/**
 * Canvas 渲染器
 * 接收瓦片差量数据，更新 ImageData 并绘制到 Canvas
 */
/* exported Renderer */
class Renderer {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.imageData = this.ctx.createImageData(256, 240)
    this.palette = [] // [{ r, g, b }]

    // 初始化黑屏
    var data = this.imageData.data
    for (var i = 0; i < data.length; i += 4) {
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 255
    }
    this.ctx.putImageData(this.imageData, 0, 0)
  }

  /**
   * 更新调色盘
   * @param {Uint8Array} paletteData 每 4 字节一个条目 (R, G, B, A)
   */
  updatePalette(paletteData) {
    this.palette = []
    for (var i = 0; i < paletteData.length; i += 4) {
      this.palette.push({
        r: paletteData[i],
        g: paletteData[i + 1],
        b: paletteData[i + 2]
      })
    }
  }

  /**
   * 应用单个瓦片差量
   * @param {number} pos 瓦片位置 (0-959, row*32+col)
   * @param {Uint8Array} tilePixels 64 字节调色盘索引
   */
  applyTileDelta(pos, tilePixels) {
    var tx = pos % 32
    var ty = Math.floor(pos / 32)
    var data = this.imageData.data

    for (var py = 0; py < 8; py++) {
      for (var px = 0; px < 8; px++) {
        var paletteIdx = tilePixels[py * 8 + px]
        var color = this.palette[paletteIdx]
        if (!color) continue

        var imgX = tx * 8 + px
        var imgY = ty * 8 + py
        var offset = (imgY * 256 + imgX) * 4
        data[offset] = color.r
        data[offset + 1] = color.g
        data[offset + 2] = color.b
        data[offset + 3] = 255
      }
    }
  }

  /**
   * 将 ImageData 绘制到 Canvas
   */
  flush() {
    this.ctx.putImageData(this.imageData, 0, 0)
  }
}
