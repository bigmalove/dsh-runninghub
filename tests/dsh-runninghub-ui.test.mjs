import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { format } from 'node:util'
import vm from 'node:vm'

const depsEntry = process.env.DSH_UI_DEPS

// 不设置显式入口时，连 jsdom 和 React 的依赖解析也不执行。
test('RunningHub 重设计界面：jsdom + React DOM 隔离交互', {
  skip: depsEntry ? false : '未设置 DSH_UI_DEPS；跳过全部可选界面测试，保留零依赖单测',
  timeout: 30_000,
}, async t => {
  const deps = createRequire(resolve(depsEntry))
  const pluginDeps = createRequire(deps.resolve('./tavern-plugin/package.json'))
  const { JSDOM, VirtualConsole } = deps('jsdom')
  const React = pluginDeps('react')
  assert.match(React.version, /^18\./, '必须使用 tavern-plugin 的 React 18，不使用根目录 React 19')

  const runtimeErrors = []
  const consoleMessages = []
  const unexpectedRequests = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => runtimeErrors.push(String(error.stack || error)))
  const dom = new JSDOM('<!doctype html><div id="fixture-root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole,
  })
  const { window } = dom
  const container = window.document.getElementById('fixture-root')
  const previousGlobals = new Map()
  const previousConsole = { error: console.error, warn: console.warn }
  let root
  let act
  let panel
  let restored = false
  const createdURLs = new Map()
  const revokedURLs = []
  let urlCounter = 0
  window.URL.createObjectURL = file => {
    const url = 'blob:ui-fixture-' + ++urlCounter
    createdURLs.set(url, file)
    return url
  }
  window.URL.revokeObjectURL = url => {
    revokedURLs.push(url)
    createdURLs.delete(url)
  }
  window.TextEncoder = globalThis.TextEncoder
  let requestCounter = 0
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true,
    value: () => '00000000-0000-4000-8000-' + String(++requestCounter).padStart(12, '0') })

  const onWindowError = event => runtimeErrors.push(String(event.error?.stack || event.message))
  const onRejection = reason => runtimeErrors.push(String(reason?.stack || reason))
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onRejection)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtExceptionMonitor', onRejection)

  function replaceGlobal(key, value) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  function knownWarning(message) {
    return /^Warning: `ReactDOMTestUtils\.act` is deprecated/.test(message)
      || (/non-boolean attribute/.test(message) && /\binert\b/.test(message))
  }
  async function cleanup() {
    if (restored) return
    restored = true
    try {
      if (root) await act(async () => root.unmount())
    } finally {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onRejection)
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtExceptionMonitor', onRejection)
      dom.window.close()
      console.error = previousConsole.error
      console.warn = previousConsole.warn
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    }
  }
  t.after(async () => {
    await cleanup()
    for (const message of consoleMessages.filter(knownWarning)) t.diagnostic('已知兼容警告：' + message)
    t.diagnostic('本次 submit 夹具总数：' + submissions.length + '；全部为内存响应，不访问网关、不收费。')
    assert.deepEqual(runtimeErrors, [], '不得出现未捕获异常或 jsdom 运行错误')
    assert.deepEqual(consoleMessages.filter(message => !knownWarning(message)), [], '不得出现 React error 或非预期警告')
    assert.equal(createdURLs.size, 0, '卸载后必须释放全部图片预览 URL')
    assert.deepEqual(unexpectedRequests, [], '任何非夹具请求都必须失败并被记录')
    t.diagnostic('未出现 React 渲染错误、未捕获异常或非夹具网络请求；预览 URL 已全部释放。')
  })

  // React DOM 与 vm 客户端共用同一宿主 window；测试结束恢复所有全局属性。
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'File', 'FileReader',
    'DOMException', 'AbortController', 'URL']) {
    replaceGlobal(key, key === 'window' ? window : window[key])
  }
  replaceGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
  replaceGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
  replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  console.error = (...args) => consoleMessages.push(format(...args))
  console.warn = (...args) => consoleMessages.push(format(...args))
  window.console.error = console.error
  window.console.warn = console.warn
  const ReactDOM = pluginDeps('react-dom/client')
  ;({ act } = pluginDeps('react-dom/test-utils'))

  const calls = []
  const submissions = []
  const baseURL = 'http://127.0.0.1:6888'
  const state = {
    configured: true,
    autoInsert: false,
    baseURL,
    describeGate: Promise.withResolvers(),
    configureGate: null,
    submitGate: null,
    jobs: [
      { id: 'fixture-ready', model: 'h3参考', status: 'ready', createdAt: '2026-10-16T10:00:00Z',
        attachments: [{ kind: 'image', name: '夹具生成图', url: '/api/dsh-runninghub/media?id=fixture-ready' }] },
      { id: 'fixture-running', model: 'another', status: 'running', progress: 0.42,
        createdAt: '2026-10-16T10:01:00Z', attachments: [] },
    ],
  }
  function description(model) {
    const another = model === 'another'
    return {
      alias: model,
      customFields: [
        { key: 'stabilize', label: '镜头稳定', type: 'boolean', defaultValue: false },
        { key: 'quality', label: '质量档位', type: 'select',
          options: [{ value: 1, label: '标准' }, { value: 2, label: '精细' }], defaultValue: 2 },
        { key: 'strength', label: '参考强度', type: 'number', min: 1, max: 10, defaultValue: 9 },
      ],
      referenceSlots: [
        { nodeId: 'image-ref', label: '参考图片', kind: 'image' },
        { nodeId: 'audio-ref', label: '参考音频', kind: 'audio', bypassed: true },
      ],
      defaults: {
        custom: { stabilize: !another, quality: another ? 2 : 1, strength: another ? 4 : 2 },
        resolution: { aspect_ratio: '16:9', megapixels: another ? 2 : 1 },
        references: [{ nodeId: 'image-ref', name: '夹具默认图.png' }],
      },
      videoDuration: { seconds: another ? 8 : 5, fps: 24 },
    }
  }
  const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) })
  // 所有 GET/POST 均为内存夹具，包括 configure 和 submit；没有真实网关、生成或费用。
  async function fixtureFetch(url, options = {}) {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url, method, body, credentials: options.credentials, cache: options.cache, headers: options.headers ? { ...options.headers } : undefined })
    if (url !== '/api/dsh-runninghub' || !['GET', 'POST'].includes(method)) {
      unexpectedRequests.push({ url: String(url), method })
      throw new Error('禁止访问真实网络：' + url)
    }
    if (options.signal?.aborted) throw new window.DOMException('夹具请求已取消', 'AbortError')
    if (method === 'GET') {
      return response({ configured: state.configured, autoInsert: state.autoInsert, baseURL: state.baseURL,
        adapter: 'ui-fixture', jobs: state.jobs, workflows: [{ alias: 'h3参考' }, { alias: 'another' }] })
    }
    switch (body.action) {
      case 'describe': {
        if (!['h3参考', 'another'].includes(body.model)) break
        const gate = state.describeGate
        if (gate) await gate.promise
        return response(description(body.model))
      }
      case 'preferences':
        assert.equal(typeof body.autoInsert, 'boolean')
        state.autoInsert = body.autoInsert
        return response({ autoInsert: state.autoInsert })
      case 'configure':
        if (state.configureGate) await state.configureGate.promise
        state.configured = true
        state.baseURL = body.baseURL
        return response({ configured: true, baseURL: state.baseURL, adapter: 'ui-fixture' })
      case 'submit': {
        submissions.push(structuredClone(body))
        if (state.submitGate) await state.submitGate.promise
        const job = { id: 'fixture-submitted-' + submissions.length, model: body.input.model, status: 'queued',
          createdAt: '2026-10-16T10:02:00Z', attachments: [] }
        state.jobs = [job, ...state.jobs]
        return response(job)
      }
    }
    unexpectedRequests.push({ url, method, body })
    throw new Error('未声明的夹具请求：' + JSON.stringify(body))
  }
  window.fetch = fixtureFetch
  replaceGlobal('fetch', fixtureFetch)

  let moduleDefinition
  window.__ModuleLoader__ = {
    load(definition) {
      assert.equal(moduleDefinition, undefined, '客户端只能注册一次模块')
      moduleDefinition = definition
    },
  }
  const clientURL = new URL('../client.js', import.meta.url)
  new vm.Script(await readFile(clientURL, 'utf8'), { filename: clientURL.pathname })
    .runInContext(dom.getInternalVMContext())
  assert.equal(moduleDefinition.id, 'dsh-runninghub')
  const plugin = moduleDefinition.factory(name => {
    assert.equal(name, 'react', '客户端只能加载明确共享的 React')
    return React
  })
  plugin.apply({ tavernUi: { registerPanel(definition) {
    assert.equal(panel, undefined)
    panel = definition
  } } })
  assert.equal(panel.id, 'studio')

  function query(selector, scope = container) {
    const node = scope.querySelector(selector)
    assert.ok(node, '缺少界面元素：' + selector)
    return node
  }
  function button(text, scope = container) {
    const node = [...scope.querySelectorAll('button')].find(node => node.textContent.trim() === text)
    assert.ok(node, '缺少按钮：' + text)
    return node
  }
  function field(label, scope = container) {
    const node = [...scope.querySelectorAll('.rh-field-label')].find(node => node.textContent === label)
      ?.closest('label').querySelector('input,select,textarea')
    assert.ok(node, '缺少表单字段：' + label)
    return node
  }
  function checkbox(label, scope = container) {
    const node = [...scope.querySelectorAll('label')].find(node => node.textContent.trim() === label)
      ?.querySelector('input[type="checkbox"]')
    assert.ok(node, '缺少复选框：' + label)
    return node
  }
  async function change(callback) {
    await act(async () => { callback(); await nextTurn() })
  }
  async function click(node) {
    await change(() => node.click())
  }
  async function input(node, value) {
    await change(() => {
      const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
        : node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
      node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
    assert.equal(node.value, value)
  }
  async function upload(label, file) {
    const node = query('input[aria-label="上传' + label + '"]')
    await change(() => {
      Object.defineProperty(node, 'files', { configurable: true, value: file ? [file] : [] })
      node.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
  }
  async function until(predicate, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await act(async () => { await delay(5) })
    }
    assert.fail('等待界面状态超时：' + message)
  }
  async function mount() {
    await change(() => {
      root = ReactDOM.createRoot(container)
      root.render(panel.render({ gameId: 'fixture-game', visible: true }))
    })
  }
  async function releaseDescribe() {
    const gate = state.describeGate
    state.describeGate = null
    await change(() => gate.resolve())
    await until(() => field('参考强度').disabled === false, '工作流参数可编辑')
  }
  const actionCalls = action => calls.filter(call => call.body?.action === action)
  const alerts = () => [...container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join('\n')
  const jobStatuses = () => [...container.querySelectorAll('.rh-job .rh-status')].map(node => node.dataset.state)
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const audioBytes = Buffer.from([0xff, 0xfb, 0x10, 0, 1, 2])
  const imageFile = () => new window.File([imageBytes], 'fixture.png', { type: 'image/png' })
  const audioFile = () => new window.File([audioBytes], 'fixture.mp3', { type: 'audio/mpeg' })

  await t.test('原生模块加载；设置默认隐藏，工作流加载时禁用提交', async () => {
    await mount()
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(query('#rh-create-view').hidden, false)
    assert.equal(button('开始生成').disabled, true)
    await click(button('开始生成'))
    assert.equal(submissions.length, 0)
    assert.deepEqual(actionCalls('describe').map(call => call.body), [{ action: 'describe', model: 'h3参考' }])
    await releaseDescribe()
    assert.equal(button('开始生成').disabled, true, '工作流已加载但提示词为空时仍禁用')
  })

  await t.test('提示词、工作流、素材区域及三种自定义字段显示默认值', async () => {
    assert.equal(query('#rh-prompt').value, '')
    assert.equal(query('select[aria-label="工作流"]').value, 'h3参考')
    assert.deepEqual([...query('select[aria-label="工作流"]').options].map(option => option.value), ['h3参考', 'another'])
    assert.ok(query('section[aria-label="参考素材"]'))
    assert.equal(field('镜头稳定').checked, true)
    assert.equal(field('质量档位').value, '1')
    assert.equal(field('参考强度').value, '2')
    assert.equal(field('片长 / 秒').placeholder, '5')
    assert.equal(field('像素量 / MP').placeholder, '1')
    assert.equal(query('input[aria-label="上传参考图片"]').accept, 'image/*')
    assert.equal(query('input[aria-label="上传参考音频"]').accept, 'audio/*')
    assert.match(query('.rh-slots').textContent, /默认 · 夹具默认图\.png/)
    await click(query('details.rh-fold summary'))
    assert.equal(query('details.rh-fold').open, true)
    assert.deepEqual(jobStatuses(), ['ready', 'running'])
    assert.match(container.textContent, /1 个任务在后台运行/)
  })

  await t.test('设置打开、布尔偏好保存；配置提交精确且保存期间禁用创作', async () => {
    await click(button('设置'))
    const drawer = query('[role="dialog"]')
    assert.equal(drawer.getAttribute('aria-modal'), 'true')
    assert.equal(query('.rh-body').hasAttribute('inert'), true)
    const toggle = query('.rh-toggle-row input', drawer)
    assert.equal(toggle.checked, false)
    await click(toggle)
    await until(() => toggle.checked && !toggle.disabled, '自动插入开关保存')
    assert.deepEqual(actionCalls('preferences').map(call => call.body), [{ action: 'preferences', autoInsert: true }])
    assert.equal(state.autoInsert, true)
    assert.match(query('#rh-create-view').textContent, /正文视频自动插入已开启/)
    await input(field('网关地址', drawer), baseURL)
    await input(field('网关 Key', drawer), '  fixture-key-not-a-real-secret  ')
    state.configureGate = Promise.withResolvers()
    await click(button('保存连接设置', drawer))
    assert.equal(button('保存中…', drawer).disabled, true)
    assert.equal(query('#rh-prompt').disabled, true)
    assert.equal(button('开始生成').disabled, true)
    assert.deepEqual(actionCalls('configure').map(call => call.body), [
      { action: 'configure', baseURL, apiKey: 'fixture-key-not-a-real-secret' },
    ])
    const gate = state.configureGate
    state.configureGate = null
    await change(() => gate.resolve())
    await until(() => !button('保存连接设置', drawer).disabled, '连接配置保存结束')
    assert.equal(field('网关 Key', drawer).value, '')
    assert.match(drawer.textContent, /连接设置已保存/)
    await click(query('button[aria-label="关闭设置"]', drawer))
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(query('.rh-body').hasAttribute('inert'), false)
    assert.equal(submissions.length, 0)
  })

  await t.test('重新挂载 Panel 后从 GET 恢复自动插入偏好，Escape 关闭设置', async () => {
    await change(() => root.unmount())
    root = null
    const getCount = calls.filter(call => call.method === 'GET').length
    await mount()
    await until(() => container.querySelector('input[aria-label="上传参考图片"]'), '重新挂载的工作流')
    assert.ok(calls.filter(call => call.method === 'GET').length > getCount)
    assert.equal(container.querySelector('[role="dialog"]'), null)
    await click(button('设置'))
    assert.equal(query('.rh-toggle-row input').checked, true)
    await change(() => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(submissions.length, 0)
  })

  await t.test('工作流切换发 describe，清空覆盖值、素材及备注，并保留提示词', async () => {
    await input(query('#rh-prompt'), '切换工作流仍保留这段提示词')
    await input(field('片长 / 秒'), '6')
    await input(field('像素量 / MP'), '1.5')
    await input(field('画面比例'), '9:16')
    await click(field('镜头稳定'))
    await input(field('质量档位'), '2')
    await input(field('参考强度'), '7')
    await upload('参考图片', imageFile())
    await input(field('素材备注', query('.rh-slot')), '旧工作流备注')
    await upload('参考音频', audioFile())
    await click(checkbox('启用此旁路节点'))
    assert.equal(createdURLs.size, 1)
    const count = actionCalls('describe').length
    state.describeGate = Promise.withResolvers()
    await input(query('select[aria-label="工作流"]'), 'another')
    assert.equal(button('开始生成').disabled, true)
    assert.deepEqual(actionCalls('describe').slice(count).map(call => call.body), [{ action: 'describe', model: 'another' }])
    await releaseDescribe()
    assert.equal(field('片长 / 秒').value, '')
    assert.equal(field('像素量 / MP').value, '')
    assert.equal(field('画面比例').value, '')
    assert.equal(field('片长 / 秒').placeholder, '8')
    assert.equal(field('镜头稳定').checked, false)
    assert.equal(field('质量档位').value, '2')
    assert.equal(field('参考强度').value, '4')
    assert.equal(field('素材备注', query('.rh-slot')).value, '')
    assert.equal(checkbox('启用此旁路节点').checked, false)
    assert.equal(container.querySelectorAll('.rh-upload[data-selected="true"]').length, 0)
    assert.equal(createdURLs.size, 0)
    assert.ok(revokedURLs.length >= 1)
    assert.equal(query('#rh-prompt').value, '切换工作流仍保留这段提示词')
    await input(query('select[aria-label="工作流"]'), 'h3参考')
    await until(() => field('参考强度').value === '2', '恢复 h3参考默认字段')
    assert.equal(field('镜头稳定').checked, true)
  })

  await t.test('历史 tab 隐藏创作，全部、进行中、已完成和异常筛选正确', async () => {
    await click(query('#rh-history-tab'))
    assert.equal(query('#rh-create-view').hidden, true)
    assert.equal(query('#rh-history-tab').getAttribute('aria-selected'), 'true')
    assert.equal(query('#rh-history-view').getAttribute('role'), 'tabpanel')
    assert.deepEqual(jobStatuses(), ['ready', 'running'])
    await click(button('进行中'))
    assert.deepEqual(jobStatuses(), ['running'])
    assert.equal(button('进行中').getAttribute('aria-pressed'), 'true')
    await click(button('已完成'))
    assert.deepEqual(jobStatuses(), ['ready'])
    await click(button('异常'))
    assert.deepEqual(jobStatuses(), [])
    assert.match(query('#rh-history-view').textContent, /暂无符合筛选的任务/)
    await click(button('全部'))
    assert.deepEqual(jobStatuses(), ['ready', 'running'])
    await click(query('#rh-create-tab'))
    assert.equal(query('#rh-create-view').hidden, false)
    assert.equal(query('#rh-create-tab').getAttribute('aria-selected'), 'true')
    assert.equal(submissions.length, 0)
  })

  await t.test('提示词原文输入与清空；自定义参数恢复默认及生成参数重置', async () => {
    const prompt = '  林间晨光，镜头缓慢推进。\n保留换行与空格  '
    await input(query('#rh-prompt'), prompt)
    assert.match(query('.rh-prompt-meta').textContent, new RegExp(prompt.length + ' 字'))
    await click(button('清空'))
    assert.equal(query('#rh-prompt').value, '')
    assert.equal(button('清空').disabled, true)
    await input(query('#rh-prompt'), prompt)
    await input(field('参考强度'), '3.5')
    await click(button('恢复默认', field('参考强度').closest('.rh-stack')))
    assert.equal(field('参考强度').value, '2')
    await input(field('片长 / 秒'), '6')
    await click(checkbox('应用工作流默认值'))
    await click(button('重置'))
    assert.equal(field('片长 / 秒').value, '')
    assert.equal(checkbox('应用工作流默认值').checked, true)
    assert.equal(query('#rh-prompt').value, prompt)
  })

  await t.test('时长、像素量和自定义数值越界在提交前被拦截', async () => {
    for (const [label, invalid, expected] of [
      ['片长 / 秒', '0', /时长必须是大于 0 的数字/],
      ['像素量 / MP', '0', /百万像素必须是大于 0 的数字/],
      ['参考强度', '0', /参考强度不能小于 1/],
      ['参考强度', '11', /参考强度不能大于 10/],
    ]) {
      await input(field(label), invalid)
      await click(button('开始生成'))
      await until(() => expected.test(alerts()), '校验错误：' + label)
      assert.equal(submissions.length, 0, '无效参数不应触达提交夹具')
      await input(field(label), label === '参考强度' ? '3.5' : '')
    }
  })

  await t.test('图片与音频 MIME、单文件 10MB 和旁路启用校验；预览及移除', async () => {
    await upload('参考图片', audioFile())
    assert.match(alerts(), /文件类型不符或 MIME 类型无法识别/)
    assert.equal(query('input[aria-label="上传参考图片"]').value, '')
    await click(button('开始生成'))
    assert.match(alerts(), /请先修正参考素材错误/)
    assert.equal(submissions.length, 0)
    const oversized = new window.File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' })
    await upload('参考图片', oversized)
    assert.match(alerts(), /单个文件不能超过 10MB/)
    await click(button('开始生成'))
    assert.equal(submissions.length, 0)
    await upload('参考图片', imageFile())
    assert.equal(query('img[alt="已选参考图片"]').getAttribute('src').startsWith('blob:ui-fixture-'), true)
    const revokedCount = revokedURLs.length
    await click(button('移除素材', query('.rh-slot')))
    assert.equal(container.querySelector('img[alt="已选参考图片"]'), null)
    assert.equal(revokedURLs.length, revokedCount + 1)
    await upload('参考图片', imageFile())
    await upload('参考音频', imageFile())
    assert.match(alerts(), /文件类型不符或 MIME 类型无法识别/)
    await upload('参考音频', audioFile())
    await click(button('开始生成'))
    assert.match(alerts(), /参考音频处于旁路状态，请显式勾选启用后再提交/)
    assert.equal(submissions.length, 0)
    await click(checkbox('启用此旁路节点'))
    await input(field('素材备注', query('.rh-slot')), '  主角参考图  ')
  })

  await t.test('两份合法大小素材在 base64 编码后超过 25MB 时拦截完整请求', async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024)
    await upload('参考图片', new window.File([bytes], 'large.png', { type: 'image/png' }))
    await upload('参考音频', new window.File([bytes], 'large.mp3', { type: 'audio/mpeg' }))
    await click(button('开始生成'))
    await until(() => /含 base64 编码的完整请求超过 25MB/.test(alerts()), '编码后的请求大小限制')
    assert.equal(submissions.length, 0, '编码后超限不能触达提交夹具')
    await upload('参考图片', imageFile())
    await upload('参考音频', audioFile())
  })

  await t.test('精确提交 body、base64 与原始类型；提交中禁用并防止重复请求（全部为夹具，不收费）', async () => {
    await input(field('片长 / 秒'), '6')
    await input(field('画面比例'), '9:16')
    await input(field('像素量 / MP'), '1.5')
    await click(field('镜头稳定'))
    await input(field('质量档位'), '2')
    await input(field('参考强度'), '3.5')
    await click(checkbox('应用工作流默认值'))
    await click(checkbox('绑定当前对话轮次'))
    state.submitGate = Promise.withResolvers()
    const requestId = '00000000-0000-4000-8000-' + String(requestCounter + 1).padStart(12, '0')
    const submitButton = button('开始生成')
    await change(() => { submitButton.click(); submitButton.click() })
    await until(() => submissions.length === 1, '文件 base64 读取及夹具提交')
    assert.deepEqual(submissions, [{
      action: 'submit',
      input: {
        model: 'h3参考',
        prompt: '  林间晨光，镜头缓慢推进。\n保留换行与空格  ',
        apply_defaults: false,
        duration_seconds: 6,
        resolution: { aspect_ratio: '9:16', megapixels: 1.5 },
        custom: { stabilize: false, quality: 2, strength: 3.5 },
        references: [
          { nodeId: 'image-ref', name: '主角参考图', mimeType: 'image/png', data: imageBytes.toString('base64') },
          { nodeId: 'audio-ref', name: 'fixture.mp3', mimeType: 'audio/mpeg', data: audioBytes.toString('base64'), enable: true },
        ],
      },
      gameId: 'fixture-game',
      bindToTurn: false,
      requestId,
    }])
    assert.equal(button('正在提交…').disabled, true)
    assert.equal(query('#rh-prompt').disabled, true)
    assert.equal(query('select[aria-label="工作流"]').disabled, true)
    assert.equal(field('参考强度').disabled, true)
    assert.equal(query('input[aria-label="上传参考图片"]').disabled, true)
    await click(button('正在提交…'))
    assert.equal(submissions.length, 1)
    const gate = state.submitGate
    state.submitGate = null
    await change(() => gate.resolve())
    await until(() => container.querySelector('[role="status"]')?.textContent.includes('任务已提交'), '夹具任务成功提示')
    assert.equal(button('开始生成').disabled, false)
    assert.equal(query('#rh-prompt').disabled, false)
    assert.deepEqual(jobStatuses(), ['queued', 'ready', 'running'])
    for (const call of calls) {
      assert.equal(call.url, '/api/dsh-runninghub')
      assert.equal(call.credentials, 'same-origin')
      assert.equal(call.cache, 'no-store')
      if (call.method === 'POST') assert.deepEqual(call.headers, { 'Content-Type': 'application/json' })
      else assert.equal(call.body, undefined)
    }
    t.diagnostic('仅执行 1 次内存 submit 夹具；没有真实网络、网关调用或费用。')
  })

  await t.test('visible props 原生更新暂停/恢复刷新；页面主题跟随宿主 MutationObserver', async () => {
    await change(() => root.render(panel.render({ gameId: 'fixture-game', visible: false })))
    assert.equal(button('刷新').disabled, true)
    assert.match(container.textContent, /面板隐藏时暂停轮询/)
    await change(() => window.document.documentElement.setAttribute('data-color-mode', 'dark'))
    await until(() => query('.rh-studio').dataset.theme === 'dark', '宿主主题同步')
    await change(() => { window.document.documentElement.removeAttribute('data-color-mode'); window.document.body.setAttribute('data-ds-dark-theme', '') })
    await until(() => query('.rh-studio').dataset.theme === 'dark', 'DSH 原生暗色属性同步')
    await change(() => window.document.body.removeAttribute('data-ds-dark-theme'))
    await until(() => query('.rh-studio').dataset.theme === 'light', '恢复宿主浅色主题')
    await input(field('画面比例'), '5:4')
    assert.equal(field('画面比例').value, '5:4', '保留自定义画幅能力')
    await change(() => root.render(panel.render({ gameId: 'fixture-game', visible: true })))
    await until(() => !button('刷新').disabled && !field('参考强度').disabled, '重新显示面板')
    assert.equal(submissions.length, 1, '重新显示和刷新不能重新提交')
  })

  await t.test('空白提示词应禁用提交（真实缺陷回归断言，不修改客户端）', async () => {
    const before = submissions.length
    await click(button('清空'))
    assert.equal(query('#rh-prompt').value, '')
    const emptyDisabled = button('开始生成').disabled
    await input(query('#rh-prompt'), '  \n  ')
    const whitespaceDisabled = button('开始生成').disabled
    await click(button('开始生成'))
    await until(() => !query('#rh-prompt').disabled, '空白提示词尝试完成；仍然只访问内存夹具')
    const submittedWhitespace = submissions.slice(before).some(body => !body.input.prompt.trim())
    if (submittedWhitespace) t.diagnostic('已复现：空白 prompt 实际触达 submit 内存夹具；不是实际网关任务，不收费。')
    assert.deepEqual({ emptyDisabled, whitespaceDisabled, submittedWhitespace },
      { emptyDisabled: true, whitespaceDisabled: true, submittedWhitespace: false },
      '客户端没有阻止空提示词提交；宿主 validateInput 明确拒绝空白 prompt')
  })
})
