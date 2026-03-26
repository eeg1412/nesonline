/**
 * 快照写入 Worker
 * 在独立线程中执行 JSON.stringify + 文件写入，避免阻塞游戏主循环
 */
const { parentPort } = require('worker_threads')
const fs = require('fs')
const path = require('path')

parentPort.on('message', msg => {
  switch (msg.type) {
    case 'save':
      handleSave(msg)
      break
  }
})

function handleSave(msg) {
  try {
    var data = JSON.stringify(msg.state)
    var tmpPath = msg.latestPath + '.tmp'

    fs.writeFileSync(tmpPath, data, 'utf8')
    fs.renameSync(tmpPath, msg.latestPath)

    if (msg.archivePath) {
      fs.copyFileSync(msg.latestPath, msg.archivePath)
    }

    parentPort.postMessage({
      type: 'saved',
      archivePath: msg.archivePath || null
    })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message })
  }
}
