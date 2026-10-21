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
  const saves = []
  const baseURL = 'http://127.0.0.1:6888'
  const state = {
    configured: true,
    autoInsert: false,
    applyDefaults: true,
    bindToTurn: true,
    baseURL,
    model: 'h3参考',
    minimal: false,
    dimensions: false,
    describeAlter: null,
    describeGate: Promise.withResolvers(),
    configureGate: null,
    submitGate: null,
    optionGroups: [{ id: 'group-1', label: '夹具候选组', values: ['fixture-model.safetensors', 'other-model.safetensors'] }],
    jobs: [
      { id: 'fixture-ready', model: 'h3参考', status: 'ready', createdAt: '2026-10-16T10:00:00Z', replayable: true,
        attachments: [{ kind: 'image', name: '夹具生成图', url: '/api/dsh-runninghub/media?id=fixture-ready' }] },
      { id: 'fixture-running', model: 'another', status: 'running', progress: 0.42,
        createdAt: '2026-10-16T10:01:00Z', attachments: [] },
    ],
    pregen: {
      settings: { count: 2, perTurn: 1, maxAge: 6, review: true },
      entries: [
        { id: 'pg-fixture-ready', status: 'ready', description: '窗边回头，阳光落在肩上', createdAt: '2026-10-16T09:58:00Z',
          createdTurn: 3, summary: '就绪', workflow: 'h3参考',
          attachments: [{ kind: 'video', name: 'fixture-pregen.mp4', mediaType: 'video/mp4',
            url: '/api/dsh-runninghub/media?id=pregen-ready&index=0' }] },
        { id: 'pg-fixture-generating', status: 'generating', description: '推门进来，停在门口', createdAt: '2026-10-16T09:59:00Z',
          createdTurn: 4, summary: '生成中', workflow: 'h3参考', progress: 0.4 },
        { id: 'pg-fixture-stale', status: 'stale', description: '浴室里的水汽', createdAt: '2026-10-16T09:50:00Z',
          createdTurn: 1, summary: '就绪', staleNote: '规划后 6 轮没用到', workflow: 'h3参考',
          attachments: [{ kind: 'video', name: 'fixture-stale.mp4', mediaType: 'video/mp4',
            url: '/api/dsh-runninghub/media?id=pregen-stale&index=0' }] },
      ],
      live: 2, ready: 1, generating: 1,
    },
  }
  function description(model) {
    const another = model === 'another'
    const base = {
      alias: model,
      revision: another ? 'rev-another' : 'rev-h3',
      customFields: [
        { key: 'stabilize', label: '镜头稳定', type: 'boolean', defaultValue: !another },
        { key: 'quality', label: '质量档位', type: 'select',
          options: [{ value: 1, label: '标准' }, { value: 2, label: '精细' }], defaultValue: 2 },
        { key: 'strength', label: '参考强度', type: 'number', min: 1, max: 10, defaultValue: 9 },
        { key: 'seed', label: '随机种子', type: 'number', randomize: true },
      ],
      referenceSlots: [
        { nodeId: 'image-ref', label: '参考图片', kind: 'image' },
        { nodeId: 'audio-ref', label: '参考音频', kind: 'audio', bypassed: true },
      ],
      seedTargets: [
        { target: '9.noise_seed', nodeId: '9', field: 'noise_seed', classType: 'RandomNoise', templateValue: 123, pinnedValue: another ? 456 : undefined },
      ],
      modelFields: [
        { target: '95.unet_name', nodeId: '95', field: 'unet_name', classType: 'UNETLoader', groupTitle: 'MODELS',
          value: another ? 'other-model.safetensors' : 'fixture-model.safetensors', canvasValue: 'canvas-model.safetensors', groupId: 'group-1' },
      ],
      capabilities: { resolutionFields: ['aspect_ratio', 'megapixels'] },
      defaults: {
        updatedAt: 'updated-h3',
        custom: { stabilize: !another, quality: another ? 2 : 1, strength: another ? 4 : 2 },
        resolution: { aspect_ratio: '16:9', megapixels: another ? 2 : 1 },
        references: [{ nodeId: 'image-ref', kind: 'image', name: '夹具默认图.png' }],
        referencePools: [],
        presetIds: [],
        promptSuffix: '',
      },
      videoDuration: { seconds: another ? 8 : 5, fps: 24 },
    }
    if (state.savedDefaults) base.defaults = { ...base.defaults, ...state.savedDefaults }
    if (state.savedDuration !== undefined) base.videoDuration = { ...base.videoDuration, seconds: state.savedDuration }
    if (state.minimal) {
      delete base.capabilities
      delete base.videoDuration
      delete base.defaults.resolution
    }
    if (state.dimensions) {
      base.capabilities = { resolutionFields: ['width', 'height'] }
      delete base.defaults.resolution
    }
    if (state.describeAlter) state.describeAlter(base)
    return base
  }
  const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) })
  // 所有 GET/POST 均为内存夹具，包括 configure 和 submit；没有真实网关、生成或费用。
  async function fixtureFetch(url, options = {}) {
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    const target = new URL(url, 'http://localhost')
    calls.push({ url: target.pathname, query: target.search, method, body, credentials: options.credentials, cache: options.cache, headers: options.headers ? { ...options.headers } : undefined })
    if (target.pathname !== '/api/dsh-runninghub' || !['GET', 'POST'].includes(method)) {
      unexpectedRequests.push({ url: String(url), method })
      throw new Error('禁止访问真实网络：' + url)
    }
    if (options.signal?.aborted) throw new window.DOMException('夹具请求已取消', 'AbortError')
    if (method === 'GET') {
      return response({ configured: state.configured, autoInsert: state.autoInsert,
        applyDefaults: state.applyDefaults !== false, bindToTurn: state.bindToTurn !== false, workflowSettings: true, baseURL: state.baseURL,
        model: state.model, defaultModel: 'h3参考', templateMode: 'h3-ref2va', adapter: 'ui-fixture', jobs: state.jobs,
        pregen: structuredClone(state.pregen),
        workflows: [{ alias: 'h3参考', revision: 'rev-h3' }, { alias: 'another', revision: 'rev-another' }] })
    }
    switch (body.action) {
      case 'select-model':
        if (!['h3参考', 'another'].includes(body.model)) break
        state.model = body.model
        return response({ model: state.model, templateMode: 'h3-ref2va' })
      case 'describe': {
        if (!['h3参考', 'another'].includes(body.model)) break
        const gate = state.describeGate
        if (gate) await gate.promise
        return response(description(body.model))
      }
      case 'preferences': {
        const keys = ['autoInsert', 'applyDefaults', 'bindToTurn'].filter(key => body[key] !== undefined)
        assert.ok(keys.length, 'preferences 至少带一个布尔值')
        for (const key of keys) {
          assert.equal(typeof body[key], 'boolean')
          state[key] = body[key]
        }
        return response({ autoInsert: state.autoInsert, applyDefaults: state.applyDefaults, bindToTurn: state.bindToTurn })
      }
      case 'pregen-settings': {
        assert.equal(body.gameId, 'fixture-game')
        const next = { ...state.pregen.settings }
        for (const key of ['count', 'perTurn', 'maxAge']) if (body[key] !== undefined) next[key] = body[key]
        if (body.review !== undefined) next.review = body.review
        state.pregen = { ...state.pregen, settings: next }
        return response({ pregen: structuredClone(state.pregen) })
      }
      case 'pregen-refill':
        assert.equal(body.gameId, 'fixture-game')
        return response({ pregen: structuredClone(state.pregen) })
      case 'pregen-delete': {
        assert.equal(body.gameId, 'fixture-game')
        state.pregen = { ...state.pregen, entries: state.pregen.entries.filter(entry => entry.id !== body.id) }
        state.pregen.live = state.pregen.entries.filter(entry => ['ready', 'generating'].includes(entry.status)).length
        state.pregen.ready = state.pregen.entries.filter(entry => entry.status === 'ready').length
        state.pregen.generating = state.pregen.entries.filter(entry => entry.status === 'generating').length
        return response({ pregen: structuredClone(state.pregen) })
      }
      case 'pregen-send': {
        assert.equal(body.gameId, 'fixture-game')
        state.pregen.entries = state.pregen.entries.map(entry => entry.id === body.id ? { ...entry, status: 'used', summary: '已发送' } : entry)
        state.pregen.live = state.pregen.entries.filter(entry => ['ready', 'generating'].includes(entry.status)).length
        state.pregen.ready = state.pregen.entries.filter(entry => entry.status === 'ready').length
        state.pregen.generating = state.pregen.entries.filter(entry => entry.status === 'generating').length
        return response({ sent: true, queued: false, pool_id: body.id, pregen: structuredClone(state.pregen) })
      }
      case 'option-groups':
        return response({ groups: state.optionGroups })
      case 'save-settings': {
        saves.push(structuredClone(body))
        if (body.defaults) {
          state.savedDefaults = { ...(state.savedDefaults || {}), ...body.defaults }
          if (body.defaults.resolution === null) state.savedDefaults.resolution = null
        }
        if (body.duration) state.savedDuration = body.duration.seconds
        return response({ model: state.model, workflow: description(state.model) })
      }
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
      case 'regenerate': {
        const source = state.jobs.find(job => job.id === body.id)
        assert.ok(source, '重新生成必须指向已有任务')
        const job = { id: 'fixture-regenerated', model: source.model, status: 'queued', replayable: true,
          createdAt: '2026-10-16T10:03:00Z', attachments: [] }
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
    await until(() => actionCalls('describe').length > count, '选择写回后触发 describe')
    const described = actionCalls('describe').slice(count)
    assert.ok(described.length >= 1, '切换后应读取新工作流参数')
    assert.deepEqual([...new Set(described.map(call => call.body.model))], ['another'])
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

  await t.test('提示词原文输入与清空；自定义参数恢复默认', async () => {
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
    // 改动会自动写回客户端，不再有“保存设置 / 重置”按钮。
    assert.equal(container.textContent.includes('应用工作流默认值'), false, '不再提供会和客户端分叉的开关')
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
        apply_defaults: true,
        duration_seconds: 6,
        resolution: { aspect_ratio: '9:16', megapixels: 1.5 },
        custom: { stabilize: false, quality: 2, strength: 3.5 },
        references: [
          { nodeId: 'image-ref', name: 'fixture.png', mimeType: 'image/png', data: imageBytes.toString('base64'), note: '主角参考图' },
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

  async function waitWorkflow() {
    await until(() => {
      try { return field('参考强度').disabled === false } catch { return false }
    }, '工作流加载完成')
  }
  function fieldLabelExists(label) {
    return [...container.querySelectorAll('.rh-field-label')].some(node => node.textContent === label)
  }
  async function mountVariant(overrides = {}) {
    state.model = overrides.model ?? 'h3参考'
    state.minimal = overrides.minimal ?? false
    state.dimensions = overrides.dimensions ?? false
    state.describeAlter = overrides.alter ?? null
    // 每个用例从插件默认偏好和干净的客户端设置开始，避免上一条用例的自动同步串场。
    state.applyDefaults = true
    state.bindToTurn = true
    state.savedDefaults = undefined
    state.savedDuration = undefined
    if (root) await act(async () => { root.unmount(); root = null })
    await mount()
    await waitWorkflow()
  }

  await t.test('默认素材预览仅用 src，不含 key/fileName', async () => {
    await mountVariant()
    const img = query('img[alt="客户端默认参考图片"]')
    assert.ok(img.getAttribute('src').startsWith('/api/dsh-runninghub/reference?'), '默认素材走同源 reference 端点')
    assert.match(img.getAttribute('src'), /[?&]model=/)
    assert.match(img.getAttribute('src'), /[?&]nodeId=image-ref/)
    assert.match(img.getAttribute('src'), /[?&]v=rev-h3/)
    assert.equal(/key/i.test(img.getAttribute('src')), false, 'src 不得携带网关 Key')
    assert.equal(img.getAttribute('src').includes('fileName'), false, 'src 不得携带上传文件名')
    assert.equal(img.getAttribute('src').includes('name='), false, 'src 不得携带素材名称参数')
  })

  await t.test('面板选择写回宿主，同步后以宿主 summary.model 为准', async () => {
    await mountVariant({ model: 'another' })
    assert.equal(query('select[aria-label="工作流"]').value, 'another', '非 h3 默认模型从 summary.model 跟随')
    await input(query('select[aria-label="工作流"]'), 'h3参考')
    await until(() => field('参考强度').value === '2', '切到 h3 参考并加载默认')
    assert.equal(query('select[aria-label="工作流"]').value, 'h3参考', '已选择 h3 参考')
    await until(() => actionCalls('select-model').length >= 1, '选择已写回宿主')
    assert.equal(state.model, 'h3参考', '夹具宿主记住选择')
    state.model = 'another'
    await click(button('同步客户端'))
    await until(() => query('select[aria-label="工作流"]').value === 'another', '宿主变更后跟随 summary.model')
    assert.equal(query('select[aria-label="工作流"]').value, 'another', '面板以宿主的选择为准')
  })

  await t.test('无分辨率 / 时长能力时不出现对应字段', async () => {
    await mountVariant({ minimal: true })
    assert.equal(fieldLabelExists('画面比例'), false, '无 resolutionFields 不渲染画面比例')
    assert.equal(fieldLabelExists('像素量 / MP'), false, '无 resolutionFields 不渲染像素量')
    assert.equal(fieldLabelExists('片长 / 秒'), false, '无 videoDuration 不渲染片长')
    assert.match(query('#rh-create-view').textContent, /分辨率沿用客户端工作流；未声明可覆盖字段/)
    assert.ok(fieldLabelExists('镜头稳定'), '自定义字段仍随工作流描述渲染')
  })

  await t.test('只声明宽高能力时显示宽高并正确提交 width/height', async () => {
    await mountVariant({ dimensions: true })
    assert.equal(fieldLabelExists('宽度 / px'), true, '宽高能力渲染宽度')
    assert.equal(fieldLabelExists('高度 / px'), true, '宽高能力渲染高度')
    assert.equal(fieldLabelExists('画面比例'), false, '不渲染比例')
    assert.equal(fieldLabelExists('像素量 / MP'), false, '不渲染像素量')
    await input(query('#rh-prompt'), '仅宽高的构图测试')
    await input(field('宽度 / px'), '512')
    await input(field('高度 / px'), '288')
    const before = submissions.length
    await click(button('开始生成'))
    await until(() => submissions.length === before + 1, '宽高提交触达夹具')
    const input2 = submissions[submissions.length - 1].input
    assert.deepEqual(input2.resolution, { width: 512, height: 288 }, '仅提交 width/height')
    assert.equal(input2.duration_seconds, undefined, '未声明时长能力时不含 duration_seconds')
    assert.equal(input2.apply_defaults, true)
  })

  await t.test('随机种子默认留空，不固化进提交', async () => {
    await mountVariant()
    await input(query('#rh-prompt'), '随机种子测试')
    const before = submissions.length
    await click(button('开始生成'))
    await until(() => submissions.length === before + 1, '提交触达夹具')
    const body = submissions[submissions.length - 1].input
    assert.equal(body.custom, undefined, '未改动的随机种子不进入 custom')
    assert.deepEqual(body, { model: 'h3参考', prompt: '随机种子测试', apply_defaults: true })
  })

  await t.test('默认未改值提交中省略，仅保留 apply_defaults:true', async () => {
    await mountVariant()
    await input(query('#rh-prompt'), '仅默认值的极简提交')
    const before = submissions.length
    await click(button('开始生成'))
    await until(() => submissions.length === before + 1, '提交触达夹具')
    assert.deepEqual(submissions[submissions.length - 1].input,
      { model: 'h3参考', prompt: '仅默认值的极简提交', apply_defaults: true },
      '分辨率/时长/自定义/素材未改动时全部省略')
  })

  await t.test('客户端更改 defaults/custom/notes/pools/slots 后同步：保留用户编辑且字段即时生效', async () => {
    await mountVariant()
    await input(query('#rh-prompt'), '同步前已写好的提示词')
    await input(field('参考强度'), '7')
    await upload('参考图片', imageFile())
    await input(field('素材备注', query('.rh-slot')), '主角参考图')
    assert.equal(field('镜头稳定').checked, true, '未改动项的默认值为 true')
    state.describeAlter = base => {
      base.customFields = base.customFields.filter(item => item.key !== 'quality')
      base.customFields.push({ key: 'extra', label: '新参数', type: 'text' })
      base.defaults.custom.stabilize = false
    }
    const before = submissions.length
    await click(button('同步客户端'))
    await until(() => fieldLabelExists('新参数'), '新增字段即时出现')
    assert.equal(submissions.length, before, '同步本身不提交任何请求')
    assert.equal(query('#rh-prompt').value, '同步前已写好的提示词', '用户提示词保留')
    assert.equal(field('参考强度').value, '7', '用户自定义覆盖保留')
    assert.ok(query('img[alt="已选参考图片"]'), '用户上传文件保留')
    assert.equal(fieldLabelExists('质量档位'), false, '被移除字段即时消失')
    assert.equal(field('镜头稳定').checked, false, '未改动项跟随新的工作流默认值更新')
    await click(button('开始生成'))
    await until(() => submissions.length === before + 1, '同步后提交触达夹具')
    const body = submissions[submissions.length - 1].input
    assert.deepEqual(body.custom, { strength: 7 }, '仅提交改动字段，不携带已移除 / 默认项')
    assert.equal(body.resolution, undefined, '未改动分辨率不提交')
    assert.equal(body.references[0].name, 'fixture.png', '文件名保留')
    assert.equal(body.references[0].note, '主角参考图', '素材备注以 note 字段提交')
    assert.equal(body.apply_defaults, true)
  })

  await t.test('同步期间不锁定现有表单，客户端备注与随机池实时更新', async () => {
    await mountVariant()
    await input(query('#rh-prompt'), '同步期间继续编辑')
    state.describeGate = Promise.withResolvers()
    state.describeAlter = base => {
      base.revision = 'updated-assets'
      base.defaults.references[0].note = '客户端更新的人物备注'
      base.defaults.referencePools = [{ nodeId: 'image-ref', galleryIds: ['a', 'b'], note: '客户端随机池备注' }]
      base.referenceSlots.push({ nodeId: 'new-slot', kind: 'image', label: '新增参考槽' })
    }
    await click(button('同步客户端'))
    assert.equal(field('参考强度').disabled, false, '后台同步不能打断现有表单编辑')
    await input(field('参考强度'), '6')
    await releaseDescribe()
    await until(() => container.querySelector('input[aria-label="上传新增参考槽"]'), '客户端新增槽位')
    assert.match(query('.rh-slots').textContent, /客户端随机图库池 · 2 张/)
    assert.equal(field('素材备注', query('.rh-slot')).value, '客户端随机池备注')
    assert.equal(field('参考强度').value, '6')
    assert.match(query('img[alt="客户端默认参考图片"]').getAttribute('src'), /updated-assets/)
  })

  await t.test('LoRA 动态候选与推荐强度同源，恢复默认一并清除强度覆盖', async () => {
    await mountVariant({ alter: base => {
      base.customFields.push({ key: 'lora', label: '姿势 LoRA', type: 'string', aiLora: true, strengthKey: 'strength',
        aiLoraOptions: [{ value: 'pose.safetensors', label: '客户端姿势', strength: 0.8 }] })
      base.customFields.find(item => item.key === 'strength').min = 0
    } })
    await input(field('姿势 LoRA'), 'pose.safetensors')
    assert.equal(field('参考强度').value, '0.8')
    await input(field('姿势 LoRA'), '')
    assert.equal(field('参考强度').value, '2', '回到客户端强度默认值')
    await input(query('#rh-prompt'), '清除 LoRA 覆盖')
    const before = submissions.length
    await click(button('开始生成'))
    await until(() => submissions.length === before + 1, '仅默认参数提交')
    assert.equal(submissions.at(-1).input.custom, undefined, '不残留孤儿强度参数')
  })

  await t.test('设置抽屉展示完整工作流设置，并与单镜生成页共享同一份状态', async () => {
    await mountVariant()
    await click(button('设置'))
    const drawer = query('.rh-drawer')
    assert.match(drawer.textContent, /工作流、生成默认值与正文联动/)
    assert.equal(query('select[aria-label="设置里的工作流"]', drawer).value, 'h3参考')
    assert.equal(field('默认画面比例', drawer).placeholder, '16:9')
    assert.equal(field('默认像素量 / MP', drawer).placeholder, '1')
    assert.equal(field('默认片长 / 秒', drawer).placeholder, '5')
    assert.equal(field('镜头稳定', drawer).checked, true)
    assert.equal(field('质量档位', drawer).value, '1')
    await until(() => field('候选组', drawer).value === 'group-1', '候选组回显')
    assert.equal(field('候选组', drawer).value, 'group-1')
    assert.equal(field('模型', drawer).value, 'fixture-model.safetensors')
    assert.match(drawer.textContent, /9\.noise_seed/)
    assert.ok(query('input[aria-label="设置里上传参考图片"]', drawer), '设置里可管理默认参考素材')
    const audioSlot = [...drawer.querySelectorAll('.rh-slot')].find(node => node.textContent.includes('参考音频'))
    assert.ok(audioSlot, '设置里显示音频槽')
    assert.ok(audioSlot.querySelector('input[type="checkbox"]'), '旁路槽可在设置里启用')
    assert.equal(audioSlot.querySelector('input[type="file"]'), null, '旁路槽启用后才显示上传')
    assert.equal([...drawer.querySelectorAll('button')].some(node => node.textContent.includes('保存并同步')), false, '不再需要手动保存')
    assert.match(drawer.textContent, /与 6888 管理页「单镜生成」是同一份/)

    // 单镜生成页与抽屉共用同一个 model/设置状态：改抽屉里的默认画幅，单镜页摘要立即使用。
    await input(field('默认画面比例', drawer), '9:16')
    assert.equal(field('画面比例').value, '9:16', '抽屉和单镜页共享同一份生成状态')
    await click(query('.rh-drawer-head button[aria-label="关闭设置"]'))
    assert.equal(container.querySelector('.rh-drawer'), null)
  })

  await t.test('设置抽屉改动自动写回客户端，再显示已同步', async () => {
    await mountVariant()
    await click(button('设置'))
    const drawer = query('.rh-drawer')
    await input(field('默认画面比例', drawer), '9:16')
    await input(field('默认像素量 / MP', drawer), '1.5')
    await input(field('默认片长 / 秒', drawer), '7')
    await input(field('质量档位', drawer), '2')
    await until(() => field('模型', drawer).querySelector('option[value="other-model.safetensors"]'), '候选组加载')
    await input(field('模型', drawer), 'other-model.safetensors')
    await input(query('input[placeholder="每次随机"]', drawer), '123')
    const complete = candidate => candidate.duration?.seconds === 7 && candidate.seeds?.length && candidate.modelFields?.length
    await until(() => saves.some(complete), '自动同步完整设置')
    const saved = [...saves].reverse().find(complete)
    assert.equal(saved.action, 'save-settings')
    assert.equal(saved.model, 'h3参考')
    assert.deepEqual(saved.defaults.resolution, { aspect_ratio: '9:16', megapixels: 1.5 })
    assert.deepEqual(saved.defaults.custom, { stabilize: true, quality: 2, strength: 2 })
    assert.deepEqual(saved.defaults.references, [{ nodeId: 'image-ref', kind: 'image' }])
    assert.deepEqual(saved.defaults.referencePools, [])
    assert.equal(saved.defaults.baseUpdatedAt, 'updated-h3')
    assert.deepEqual(saved.duration, { seconds: 7 })
    assert.deepEqual(saved.seeds, [{ target: '9.noise_seed', value: 123 }])
    assert.deepEqual(saved.modelFields, [{ target: '95.unet_name', value: 'other-model.safetensors' }])
    assert.equal(saved.referenceSlots, undefined)
    await until(() => query('.rh-drawer').textContent.includes('已自动写入客户端'), '自动同步状态回显')
    assert.match(query('.rh-settings-status').getAttribute('data-state'), /saved|idle/)
  })

  await t.test('主面板的设置类参数也自动写回客户端', async () => {
    await mountVariant()
    const before = saves.length
    await click(field('镜头稳定'))
    const synced = candidate => candidate.defaults?.custom?.stabilize === false
    await until(() => saves.slice(before).some(synced), '布尔开关自动同步')
    const saved = saves.slice(before).find(synced)
    assert.equal(saved.action, 'save-settings')
    assert.equal(saved.defaults.custom.stabilize, false, '主面板的 Bool/自定义参数直接写进客户端')
    assert.equal(saved.defaults.custom.quality, 1, '未改动项保留客户端原值')
    assert.equal(field('镜头稳定').checked, false, '保存后仍显示客户端当前值')
  })

  await t.test('主面板的提示词与本次素材不写进客户端默认值', async () => {
    await mountVariant({ alter: base => {
      base.customFields.push({ key: 'shot_prompt', label: '镜头提示词', type: 'text' })
    } })
    await input(field('镜头提示词'), '本次镜头的提示词')
    await upload('参考图片', imageFile())
    const before = saves.length
    await click(field('镜头稳定'))
    const synced = candidate => candidate.defaults?.custom?.stabilize === false
    await until(() => saves.slice(before).some(synced), '设置自动同步')
    const saved = saves.slice(before).find(synced)
    assert.equal(saved.defaults.custom.shot_prompt, undefined, '主面板提示词只对本次生效，不写进客户端')
    assert.equal(saved.defaults.custom.stabilize, false, '设置类参数照常写回')
    assert.deepEqual(saved.defaults.references, [{ nodeId: 'image-ref', kind: 'image' }], '本次上传的素材不写进客户端默认值')
  })

  await t.test('预生成视频池：独立 tab 里设置、发送、删除与手动补池', async () => {
    await mountVariant()
    assert.equal(query('#rh-pregen-view').hidden, true, '预生成池有自己的 tab，不再放在单镜生成页')
    assert.equal(container.querySelector('#rh-create-view [aria-label="预生成视频池"]'), null)
    await click(query('#rh-pregen-tab'))
    assert.equal(query('#rh-pregen-view').hidden, false)
    assert.equal(query('#rh-pregen-tab').getAttribute('aria-selected'), 'true')
    assert.equal(query('#rh-create-view').hidden, true)
    let pool = query('#rh-pregen-view section[aria-label="预生成视频池"]')
    assert.match(pool.textContent, /窗边回头，阳光落在肩上/)
    assert.match(pool.textContent, /生成中/)
    assert.equal(field('预生成目标数量', pool).value, '2')
    assert.equal(field('预生成每轮上限', pool).value, '1')
    assert.equal(field('预生成自动退出轮数', pool).value, '6')
    assert.equal(checkbox('每轮复审', pool).checked, true)
    const preview = pool.querySelector('video[src="/api/dsh-runninghub/media?id=pregen-ready&index=0"]')
    assert.ok(preview, '就绪视频直接预览')
    // 媒体路由瞬时失败时客户端会自动带 retry 参数重载一次，而不是一直停在 0:00。
    await change(() => preview.dispatchEvent(new window.Event('error')))
    assert.match(preview.src, /[?&]retry=1(?:&|$)/)

    await input(field('预生成目标数量', pool), '3')
    await click(button('保存设置', pool))
    await until(() => actionCalls('pregen-settings').length > 0, '预生成设置保存')
    const saved = actionCalls('pregen-settings').at(-1).body
    assert.equal(saved.action, 'pregen-settings')
    assert.equal(saved.gameId, 'fixture-game')
    assert.equal(saved.count, 3)
    await until(() => query('section[aria-label="预生成视频池"]').textContent.includes('预生成设置已保存'), '设置保存提示')

    pool = query('section[aria-label="预生成视频池"]')
    const readyEntry = [...pool.querySelectorAll('.rh-pregen-entry')].find(node => node.textContent.includes('窗边回头'))
    await click([...readyEntry.querySelectorAll('button')].find(node => node.textContent === '发送到本轮'))
    await until(() => actionCalls('pregen-send').length > 0, '发送预生成视频')
    assert.equal(actionCalls('pregen-send').at(-1).body.id, 'pg-fixture-ready')
    await until(() => container.textContent.includes('视频已补到当前正文'), '发送提示')

    pool = query('section[aria-label="预生成视频池"]')
    const staleEntry = [...pool.querySelectorAll('.rh-pregen-entry')].find(node => node.textContent.includes('浴室里的水汽'))
    await click([...staleEntry.querySelectorAll('button')].find(node => node.textContent === '删除'))
    await until(() => actionCalls('pregen-delete').length > 0, '删除预生成视频')
    assert.equal(actionCalls('pregen-delete').at(-1).body.id, 'pg-fixture-stale')

    await click(button('补池', query('section[aria-label="预生成视频池"]')))
    await until(() => actionCalls('pregen-refill').length > 0, '手动补池')
    assert.equal(actionCalls('pregen-refill').at(-1).body.gameId, 'fixture-game')
  })

  await t.test('任务历史：可重放任务一键重新生成，按原任务新建而非重复 submit', async () => {
    state.jobs = [...state.jobs, { id: 'fixture-legacy', model: 'h3参考', status: 'failed',
      createdAt: '2026-10-16T09:59:00Z', attachments: [] }]
    await mountVariant()
    const beforeSubmit = submissions.length
    await click(query('#rh-history-tab'))
    await click(button('全部'))
    assert.equal([...container.querySelectorAll('button')].filter(node => node.textContent.trim() === '重新生成').length, 1,
      '只有保存了可重放输入的任务显示重新生成按钮')
    const legacyCard = [...container.querySelectorAll('.rh-job')].find(node => node.textContent.includes('fixture-legacy'))
    assert.ok(legacyCard, '旧任务仍显示在历史里')
    assert.equal([...legacyCard.querySelectorAll('button')].some(node => node.textContent.trim() === '重新生成'), false,
      '没有可重放输入的任务不显示重新生成按钮')
    await click(button('重新生成'))
    await until(() => actionCalls('regenerate').length === 1, '重新生成请求')
    const body = actionCalls('regenerate')[0].body
    assert.equal(body.action, 'regenerate')
    assert.equal(body.id, 'fixture-ready')
    assert.equal(body.gameId, 'fixture-game')
    assert.equal(body.bindToTurn, true)
    assert.match(body.requestId, /^[0-9a-f-]{36}$/, '重新生成请求必须带幂等 requestId')
    await until(() => container.textContent.includes('已按原任务重新提交'), '重新生成成功提示')
    await until(() => jobStatuses().filter(status => status === 'queued').length >= 2, '新任务进入任务列表')
    assert.equal(submissions.length, beforeSubmit, '重新生成不得走 submit 动作')
  })

  await t.test('视频完成：历史结果不补弹、完成通知、缩略图卡片与灯箱播放', async () => {
    const jobId = 'fixture-video-runtime'
    const oldId = 'fixture-video-history'
    state.jobs = [
      { id: oldId, model: 'h3参考', status: 'ready', createdAt: '2026-10-16T10:00:30Z', replayable: true,
        costCoins: 12, binding: { gameId: 'fixture-game', turn: 11, textVersion: 'v1' },
        attachments: [{ kind: 'video', name: 'old.mp4', mediaType: 'video/mp4',
          url: '/api/dsh-runninghub/media?id=' + oldId + '&index=0' }] },
      { id: jobId, model: 'h3参考', status: 'running', progress: 0.5,
        createdAt: '2026-10-16T10:04:00Z', attachments: [] },
      ...state.jobs.filter(job => job.id !== jobId && job.id !== oldId),
    ]
    await mountVariant()
    assert.equal(container.querySelector('.rh-video-toast'), null, '首屏已有的历史结果不补弹完成通知')
    const beforeCard = [...container.querySelectorAll('.rh-job')].find(node => node.textContent.includes('本地 · ' + jobId))
    assert.ok(beforeCard, '运行中的视频任务在历史里')
    assert.equal(beforeCard.querySelector('.rh-video-thumb-card'), null, '未完成时不显示播放缩略图')
    assert.ok(beforeCard.querySelector('.rh-job-wait'), '未完成时保留进度占位')

    state.jobs = state.jobs.map(job => job.id === jobId ? { ...job, status: 'ready', costCoins: 18, replayable: true,
      binding: { gameId: 'fixture-game', turn: 12, textVersion: 'v1' },
      attachments: [{ kind: 'video', name: 'runtime.mp4', mediaType: 'video/mp4',
        url: '/api/dsh-runninghub/media?id=' + jobId + '&index=0' }] } : job)
    const getsBefore = calls.filter(call => call.method === 'GET').length
    await click(button('刷新'))
    await until(() => calls.filter(call => call.method === 'GET').length > getsBefore, '视频完成后的刷新')
    await until(() => container.querySelector('.rh-video-toast'), '完成通知')
    const toast = container.querySelector('.rh-video-toast')
    assert.match(toast.textContent, /生成完成/)
    assert.match(toast.textContent, /已绑定正文/)
    assert.match(toast.textContent, /18 币/)
    assert.equal(container.querySelectorAll('.rh-video-toast').length, 1, '已完成的历史任务不重复补弹')

    const runtimeCard = [...container.querySelectorAll('.rh-job')].find(node => node.textContent.includes('本地 · ' + jobId))
    assert.ok(runtimeCard.querySelector('.rh-video-thumb-card'), '完成后任务卡改为缩略图')
    assert.equal(runtimeCard.querySelector('video[controls]'), null, '缩略图卡片不再内嵌大播放器')
    assert.ok(runtimeCard.querySelector('button[aria-label="播放视频：h3参考"]'), '缩略图有可访问的播放按钮')

    const thumb = runtimeCard.querySelector('.rh-video-thumb-hit')
    thumb.focus()
    await click(thumb)
    await until(() => container.querySelector('dialog.rh-player-dialog'), '打开视频灯箱')
    const dialog = container.querySelector('dialog.rh-player-dialog')
    assert.equal(dialog.hasAttribute('open'), true, '灯箱以模态状态打开')
    assert.match(dialog.textContent, /h3参考/)
    assert.match(dialog.textContent, /第 12 轮/)
    assert.match(dialog.textContent, /重新生成/)
    assert.ok(dialog.querySelector('video[controls]'), '灯箱内是完整播放器')
    assert.equal(dialog.querySelector('video').getAttribute('src'),
      '/api/dsh-runninghub/media?id=' + jobId + '&index=0', '灯箱播放对应任务的视频')

    await click([...dialog.querySelectorAll('button')].find(node => node.textContent.trim() === '关闭'))
    await until(() => !container.querySelector('dialog.rh-player-dialog'), '关闭视频灯箱')
    assert.equal(window.document.activeElement, thumb, '关闭后焦点回到缩略图')

    await click(toast.querySelector('.rh-video-toast-close'))
    await until(() => !container.querySelector('.rh-video-toast'), '手动收起完成通知')
    const getsAfterClose = calls.filter(call => call.method === 'GET').length
    await click(button('刷新'))
    await until(() => calls.filter(call => call.method === 'GET').length > getsAfterClose, '收起后的刷新')
    assert.equal(container.querySelector('.rh-video-toast'), null, '已收起的通知不会因轮询重新弹出')

    state.jobs = state.jobs.filter(job => job.id !== jobId && job.id !== oldId)
  })
})
