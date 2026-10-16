// 路徑： test\run-test.js
// 用假的 vscode 模組測 extension.js（不需安裝任何套件）：相符的終端機被切換並回寫 ack、太舊的請求不理、別的 pid 不動。用法：node test/run-test.js
'use strict'
const Module = require('module')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haley-switch-'))
process.env.HALEY_COCKPIT_DATA = tmp
const shown = []
const terminal = (name, pid) => ({ name, processId: Promise.resolve(pid), show: () => shown.push(name) })
const fake = {
  window: {
    terminals: [terminal('Claude A', 100), terminal('Claude B', 200)],
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
}
const load = Module._load
Module._load = function (request, ...rest) {
  return request === 'vscode' ? fake : load.call(this, request, ...rest)
}

const ext = require('../extension.js')
const context = { subscriptions: [] }
ext.activate(context)

const request = obj => fs.writeFileSync(path.join(tmp, 'switch-request.json'), JSON.stringify(obj))
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  try {
    request({ id: 't1', at: Date.now(), pids: [999, 200, 5], project: 'beta' })
    await sleep(400)
    assert.deepStrictEqual(shown, ['Claude B'], '相符的終端機要被切換')
    const ack = JSON.parse(fs.readFileSync(path.join(tmp, 'switch-ack.json'), 'utf8'))
    assert.strictEqual(ack.id, 't1')
    assert.strictEqual(ack.ok, true)
    assert.strictEqual(ack.terminal, 'Claude B')

    request({ id: 't2', at: Date.now() - 60000, pids: [100] })
    await sleep(400)
    assert.deepStrictEqual(shown, ['Claude B'], '太舊的請求不理')

    request({ id: 't3', at: Date.now(), pids: [12345] })
    await sleep(400)
    assert.deepStrictEqual(shown, ['Claude B'], '本視窗沒有的 pid 不動')
    const ack3 = JSON.parse(fs.readFileSync(path.join(tmp, 'switch-ack.json'), 'utf8'))
    assert.strictEqual(ack3.id, 't1', '沒找到時不回寫 ack，讓擁有它的視窗回答')
    console.log('通過：3 項')
  } catch (err) {
    console.error('失敗：', err.message)
    process.exitCode = 1
  } finally {
    for (const d of context.subscriptions) d.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})()
