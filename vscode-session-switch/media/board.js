// 路徑： media\board.js
// 駕駛艙面板的網頁端：收到擴充送來的 HTML 就換上，依 data-pct 設定進度條寬度；點一列（或在列上按 Enter）請擴充切換終端機。
// 內容安全政策不允許行內 style，所以寬度在這裡用腳本設定。
;(function () {
  const vscode = acquireVsCodeApi()
  const root = document.getElementById('root')

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || msg.type !== 'render') return
    root.innerHTML = msg.html
    for (const el of root.querySelectorAll('[data-pct]')) {
      const pct = Math.max(0, Math.min(100, Number(el.getAttribute('data-pct')) || 0))
      el.style.width = pct + '%'
    }
  })

  function act(target) {
    const action = target.closest('[data-action]')
    if (action) {
      vscode.postMessage({ type: action.getAttribute('data-action') })
      return
    }
    const row = target.closest('[data-key]')
    if (row) vscode.postMessage({ type: 'switch', key: row.getAttribute('data-key') })
  }

  root.addEventListener('click', event => act(event.target))
  root.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      act(event.target)
    }
  })

  vscode.postMessage({ type: 'ready' })
})()
