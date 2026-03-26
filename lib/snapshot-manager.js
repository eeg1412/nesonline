const fs = require('fs')
const path = require('path')

/**
 * 快照管理器
 * 定期对 NES 模拟器状态进行快照，支持快速快照和留档快照
 *
 * - 快速快照：每 N 秒保存一次，只保留最新一份（用于正常恢复）
 * - 留档快照：每 M 次快速快照后额外保留一份（用于灾难恢复），滚动保留最近 X 份
 *
 * 保存操作全部异步，不阻塞游戏循环
 */
class SnapshotManager {
  constructor(options) {
    this.snapshotDir = options.snapshotDir || './snapshots'
    this.snapshotIntervalSec = options.snapshotIntervalSec || 1
    this.archiveEveryN = options.archiveEveryN || 3600
    this.maxArchives = options.maxArchives || 72

    this.snapshotCount = 0
    this.timer = null
    this.saving = false  // 防止并发写入

    // 确保目录存在
    this.latestDir = path.join(this.snapshotDir, 'latest')
    this.archiveDir = path.join(this.snapshotDir, 'archive')
    fs.mkdirSync(this.latestDir, { recursive: true })
    fs.mkdirSync(this.archiveDir, { recursive: true })
  }

  /**
   * 获取最新快照路径
   */
  getLatestPath() {
    return path.join(this.latestDir, 'state.json')
  }

  /**
   * 启动定期快照
   * @param {Function} getStateFn 返回模拟器状态 JSON 的函数（同步，耗时很短）
   */
  start(getStateFn) {
    if (this.timer) return

    this.timer = setInterval(() => {
      this.takeSnapshot(getStateFn)
    }, this.snapshotIntervalSec * 1000)

    console.log(`Snapshot: every ${this.snapshotIntervalSec}s, archive every ${this.archiveEveryN} snapshots, max ${this.maxArchives} archives`)
  }

  /**
   * 停止定期快照
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 执行一次快照（同步获取状态，异步写盘）
   */
  takeSnapshot(getStateFn) {
    if (this.saving) return // 上一次还没写完，跳过

    // 同步获取状态（jsnes toJSON 在主线程执行，通常 < 1ms）
    let stateJSON
    try {
      stateJSON = getStateFn()
    } catch (err) {
      console.error('Snapshot: failed to get state:', err.message)
      return
    }

    this.snapshotCount++
    this.saving = true

    const data = JSON.stringify(stateJSON)
    const latestPath = this.getLatestPath()
    const isArchive = this.snapshotCount % this.archiveEveryN === 0

    // 先写临时文件再重命名（原子操作，防止写到一半断电导致损坏）
    const tmpPath = latestPath + '.tmp'

    fs.writeFile(tmpPath, data, 'utf8', (err) => {
      if (err) {
        console.error('Snapshot: write error:', err.message)
        this.saving = false
        return
      }

      fs.rename(tmpPath, latestPath, (err2) => {
        if (err2) {
          console.error('Snapshot: rename error:', err2.message)
          this.saving = false
          return
        }

        // 需要留档
        if (isArchive) {
          const archiveName = `state_${Date.now()}.json`
          const archivePath = path.join(this.archiveDir, archiveName)

          fs.copyFile(latestPath, archivePath, (err3) => {
            if (err3) {
              console.error('Snapshot: archive copy error:', err3.message)
            } else {
              this.pruneArchives()
            }
            this.saving = false
          })
        } else {
          this.saving = false
        }
      })
    })
  }

  /**
   * 清理超出上限的留档快照（保留最新的 maxArchives 份）
   */
  pruneArchives() {
    fs.readdir(this.archiveDir, (err, files) => {
      if (err) return

      const jsonFiles = files
        .filter(f => f.startsWith('state_') && f.endsWith('.json'))
        .sort()

      if (jsonFiles.length <= this.maxArchives) return

      const toDelete = jsonFiles.slice(0, jsonFiles.length - this.maxArchives)
      for (const file of toDelete) {
        fs.unlink(path.join(this.archiveDir, file), () => {})
      }
      console.log(`Snapshot: pruned ${toDelete.length} old archives`)
    })
  }

  /**
   * 加载最新快照（同步，启动时调用）
   * @returns {Object|null} 快照状态对象，无快照时返回 null
   */
  loadLatest() {
    const latestPath = this.getLatestPath()

    if (!fs.existsSync(latestPath)) {
      console.log('Snapshot: no latest snapshot found')
      return null
    }

    try {
      const data = fs.readFileSync(latestPath, 'utf8')
      const state = JSON.parse(data)
      console.log('Snapshot: loaded latest snapshot')
      return state
    } catch (err) {
      console.error('Snapshot: failed to load latest:', err.message)
      // 尝试从留档中恢复
      return this.loadLatestArchive()
    }
  }

  /**
   * 从留档快照中加载最新一份（灾难恢复）
   * @returns {Object|null}
   */
  loadLatestArchive() {
    try {
      const files = fs.readdirSync(this.archiveDir)
      const jsonFiles = files
        .filter(f => f.startsWith('state_') && f.endsWith('.json'))
        .sort()

      if (jsonFiles.length === 0) {
        console.log('Snapshot: no archive snapshots found')
        return null
      }

      const newest = jsonFiles[jsonFiles.length - 1]
      const data = fs.readFileSync(path.join(this.archiveDir, newest), 'utf8')
      const state = JSON.parse(data)
      console.log(`Snapshot: restored from archive ${newest}`)
      return state
    } catch (err) {
      console.error('Snapshot: failed to load archive:', err.message)
      return null
    }
  }

  /**
   * 立即执行一次快照（优雅关闭时调用，同步写入）
   */
  saveImmediate(getStateFn) {
    try {
      const stateJSON = getStateFn()
      const data = JSON.stringify(stateJSON)
      const latestPath = this.getLatestPath()
      const tmpPath = latestPath + '.tmp'
      fs.writeFileSync(tmpPath, data, 'utf8')
      fs.renameSync(tmpPath, latestPath)
      console.log('Snapshot: saved on shutdown')
    } catch (err) {
      console.error('Snapshot: shutdown save failed:', err.message)
    }
  }
}

module.exports = SnapshotManager
