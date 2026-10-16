window.__ModuleLoader__.load({
  id: 'dsh-runninghub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    const API = '/api/dsh-runninghub'
    const DEFAULT_MODEL = 'h3参考'
    const DEFAULT_BASE = 'http://127.0.0.1:6888'
    const MB = 1024 * 1024
    // 仅在内存中保留未确认请求；面板重新挂载时也不生成新的请求 ID。
    const pendingRequests = new Map()
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
    const message = error => typeof error === 'string' ? error : error?.message || '未知错误'
    const statuses = {
      preparing: '准备中', submitting: '提交中', submit_unknown: '提交结果未知',
      queued: '排队中', running: '生成中', downloading: '下载中', ready: '已就绪',
      failed: '失败', download_failed: '下载失败',
    }
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 12, minWidth: 0,
        color: 'var(--foreground, var(--text-color, CanvasText))', overflowWrap: 'anywhere' },
      box: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, minWidth: 0,
        border: '1px solid var(--border, var(--border-color, rgba(128,128,128,.35)))', borderRadius: 8 },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px', minWidth: 0 },
      input: { boxSizing: 'border-box', width: '100%', minWidth: 0, padding: '6px 8px',
        font: 'inherit', color: 'inherit', background: 'var(--background, Canvas)',
        border: '1px solid var(--border, var(--border-color, rgba(128,128,128,.45)))', borderRadius: 5 },
      button: { padding: '6px 10px', font: 'inherit', cursor: 'pointer', borderRadius: 5,
        border: '1px solid var(--border, var(--border-color, rgba(128,128,128,.45)))',
        background: 'var(--background, ButtonFace)', color: 'inherit' },
      note: { fontSize: 12, opacity: 0.8, margin: 0 },
      error: { whiteSpace: 'pre-wrap', borderLeft: '3px solid var(--destructive, #b94343)', paddingLeft: 8 },
      media: { display: 'block', maxWidth: '100%', maxHeight: 420, borderRadius: 5 },
    }

    async function request(body, signal) {
      let response
      try {
        response = await fetch(API, {
          method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        })
      } catch (error) {
        if (error.name === 'AbortError') throw error
        const failure = new Error('网络请求失败：' + message(error))
        failure.uncertain = true
        throw failure
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        if (error.name === 'AbortError') throw error
        const failure = new Error(`HTTP ${response.status}：无法读取 JSON 响应（${message(error)}）`)
        failure.uncertain = response.ok || response.status >= 500 || response.status === 408
        throw failure
      }
      if (!response.ok) {
        const failure = new Error(data?.error ? message(data.error) : `HTTP ${response.status}：请求失败`)
        failure.uncertain = response.status >= 500 || response.status === 408
        throw failure
      }
      return data
    }

    function readBase64(file, signal) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        const cleanup = () => {
          signal.removeEventListener('abort', abort)
          reader.onload = reader.onerror = reader.onabort = null
        }
        const fail = error => { cleanup(); reject(error) }
        const abort = () => {
          reader.abort()
          fail(new DOMException('读取已取消', 'AbortError'))
        }
        reader.onload = () => {
          const result = String(reader.result)
          const comma = result.indexOf(',')
          cleanup()
          if (comma < 0) reject(new Error('无法读取文件：' + file.name))
          else resolve(result.slice(comma + 1))
        }
        reader.onerror = () => fail(reader.error || new Error('读取文件失败：' + file.name))
        reader.onabort = () => fail(new DOMException('读取已取消', 'AbortError'))
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        reader.readAsDataURL(file)
      })
    }

    function button(label, onClick, disabled, key) {
      return h('button', { key, type: 'button', style: styles.button, onClick, disabled }, label)
    }
    function field(label, control, key) {
      return h('label', { key, style: styles.field }, h('span', null, label), control)
    }
    function note(text, key) { return h('p', { key, style: styles.note }, text) }
    function alert(text, key) {
      return text ? h('div', { key, role: 'alert', style: styles.error }, text) : null
    }
    function checkbox(label, checked, onChange, disabled, key) {
      return h('label', { key, style: styles.row }, h('input', {
        type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked),
      }), label)
    }

    function Panel({ gameId, visible }) {
      const contextKey = gameId == null ? '__unbound__' : String(gameId)
      const [summary, setSummary] = useState(null)
      const [baseURL, setBaseURL] = useState(DEFAULT_BASE)
      const [apiKey, setApiKey] = useState('')
      const [configBusy, setConfigBusy] = useState(false)
      const [autoInsertBusy, setAutoInsertBusy] = useState(false)
      const [autoInsertError, setAutoInsertError] = useState('')
      const autoInsertLock = useRef(false)
      const [configError, setConfigError] = useState('')
      const [configNotice, setConfigNotice] = useState('')
      const [configVersion, setConfigVersion] = useState(0)
      const [refreshVersion, setRefreshVersion] = useState(0)
      const [refreshBusy, setRefreshBusy] = useState(false)
      const [refreshError, setRefreshError] = useState('')
      const [model, setModel] = useState(DEFAULT_MODEL)
      const [workflow, setWorkflow] = useState(null)
      const [workflowBusy, setWorkflowBusy] = useState(false)
      const [workflowError, setWorkflowError] = useState('')
      const [prompt, setPrompt] = useState('')
      const [applyDefaults, setApplyDefaults] = useState(true)
      const [duration, setDuration] = useState('')
      const [ratio, setRatio] = useState('')
      const [megapixels, setMegapixels] = useState('')
      const [custom, setCustom] = useState({})
      const [references, setReferences] = useState({})
      const [referenceErrors, setReferenceErrors] = useState({})
      const [bindToTurn, setBindToTurn] = useState(true)
      const [submitBusy, setSubmitBusy] = useState(false)
      const [submitError, setSubmitError] = useState('')
      const [submitNotice, setSubmitNotice] = useState('')
      const [pending, setPending] = useState(() => pendingRequests.get(contextKey) || null)
      const [retrying, setRetrying] = useState({})
      const [downloadErrors, setDownloadErrors] = useState({})
      const alive = useRef(false)
      const controllers = useRef(new Set())
      const configLock = useRef(false)
      const submitLock = useRef(false)
      const downloadLocks = useRef(new Set())
      const baseInitialized = useRef(false)
      const baseDirty = useRef(false)
      const pendingRef = useRef(pending)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          controllers.current.forEach(controller => controller.abort())
          controllers.current.clear()
        }
      }, [])

      function controller() {
        const value = new AbortController()
        controllers.current.add(value)
        return value
      }
      function rememberPending(value) {
        pendingRef.current = value
        if (value) pendingRequests.set(contextKey, value)
        else pendingRequests.delete(contextKey)
        if (alive.current) setPending(value)
      }
      function mergeJob(job) {
        if (!job || typeof job.id !== 'string') throw new Error('宿主未返回有效的任务 ID')
        setSummary(previous => ({
          ...(previous || {}), jobs: [job, ...(previous?.jobs || []).filter(item => item.id !== job.id)],
        }))
      }

      useEffect(() => {
        if (visible === false) return
        let active = true
        let inFlight = false
        let current
        async function refresh() {
          if (inFlight) return
          inFlight = true
          current = controller()
          setRefreshBusy(true)
          try {
            const data = await request(null, current.signal)
            if (!active || !alive.current) return
            if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.workflows)) {
              throw new Error('宿主状态格式无效：缺少 jobs 或 workflows')
            }
            setSummary({ configured: data.configured, baseURL: data.baseURL,
              autoInsert: data.autoInsert === true, adapter: data.adapter, model: data.model, jobs: data.jobs, workflows: data.workflows,
              gatewayError: data.gatewayError || '' })
            if (!baseInitialized.current) {
              if (!baseDirty.current) setBaseURL(data.baseURL || DEFAULT_BASE)
              baseInitialized.current = true
            }
            setRefreshError('')
          } catch (error) {
            if (active && alive.current && error.name !== 'AbortError') setRefreshError(message(error))
          } finally {
            controllers.current.delete(current)
            inFlight = false
            if (active && alive.current) setRefreshBusy(false)
          }
        }
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => {
          active = false
          clearInterval(timer)
          if (current) { current.abort(); controllers.current.delete(current) }
        }
      }, [visible, refreshVersion])

      useEffect(() => {
        if (!summary?.configured || visible === false) return
        let active = true
        const current = controller()
        setWorkflow(null)
        setWorkflowBusy(true)
        setWorkflowError('')
        request({ action: 'describe', model }, current.signal).then(data => {
          if (!active || !alive.current) return
          if (!data || !Array.isArray(data.customFields) || !Array.isArray(data.referenceSlots)) {
            throw new Error('工作流描述格式无效：缺少 customFields 或 referenceSlots')
          }
          setWorkflow(data)
        }).catch(error => {
          if (active && alive.current && error.name !== 'AbortError') setWorkflowError(message(error))
        }).finally(() => {
          controllers.current.delete(current)
          if (active && alive.current) setWorkflowBusy(false)
        })
        return () => { active = false; current.abort(); controllers.current.delete(current) }
      }, [model, summary?.configured, configVersion, visible])

      async function saveConfig() {
        if (configLock.current || submitLock.current || pendingRef.current) return
        configLock.current = true
        setConfigBusy(true)
        setConfigError('')
        setConfigNotice('')
        const current = controller()
        try {
          const body = { action: 'configure', baseURL: baseURL.trim() || DEFAULT_BASE }
          if (apiKey.trim()) body.apiKey = apiKey.trim()
          const data = await request(body, current.signal)
          if (!alive.current) return
          setApiKey('')
          if (data?.baseURL) setBaseURL(data.baseURL)
          setSummary(previous => ({ ...(previous || {}), configured: data.configured,
            baseURL: data.baseURL, adapter: data.adapter }))
          setConfigNotice('连接设置已保存，Key 输入已清空。')
          setConfigVersion(value => value + 1)
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setConfigError(message(error))
        } finally {
          controllers.current.delete(current)
          configLock.current = false
          if (alive.current) setConfigBusy(false)
        }
      }

      async function saveAutoInsert(value) {
        if (autoInsertLock.current) return
        autoInsertLock.current = true
        setAutoInsertBusy(true)
        setAutoInsertError('')
        const current = controller()
        try {
          const data = await request({ action: 'preferences', autoInsert: value }, current.signal)
          if (alive.current) {
            setSummary(previous => ({ ...(previous || {}), autoInsert: data.autoInsert === true }))
            setRefreshVersion(previous => previous + 1)
          }
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setAutoInsertError(message(error))
        } finally {
          autoInsertLock.current = false
          controllers.current.delete(current)
          if (alive.current) setAutoInsertBusy(false)
        }
      }

      function selectModel(value) {
        setModel(value)
        setWorkflow(null)
        setCustom({})
        setReferences({})
        setReferenceErrors({})
        setDuration('')
        setRatio('')
        setMegapixels('')
        setSubmitError('')
        setSubmitNotice('')
      }
      function updateReference(nodeId, patch) {
        setReferences(previous => ({ ...previous, [nodeId]: { ...previous[nodeId], ...patch } }))
      }
      function chooseFile(slot, event) {
        const file = event.target.files?.[0]
        let error = ''
        if (file) {
          if (file.size > 10 * MB) error = '单个文件不能超过 10MB。'
          else if (!file.type.startsWith(slot.kind + '/')) error = '文件类型不符或 MIME 类型无法识别。'
          const others = Object.entries(references).reduce((sum, [key, entry]) =>
            sum + (key === String(slot.nodeId) ? 0 : entry.file?.size || 0), 0)
          if (!error && others + file.size > 25 * MB) error = '参考文件总大小不能超过 25MB。'
        }
        if (error) event.target.value = ''
        updateReference(slot.nodeId, { file: error ? null : file || null })
        setReferenceErrors(previous => ({ ...previous, [slot.nodeId]: error }))
      }

      async function makeInput(signal) {
        if (!workflow) throw new Error('请先加载工作流描述。')
        const input = { model, prompt, apply_defaults: applyDefaults }
        function positive(value, label) {
          const number = Number(value)
          if (!Number.isFinite(number) || number <= 0) throw new Error(label + '必须是大于 0 的数字。')
          return number
        }
        if (duration.trim()) input.duration_seconds = positive(duration, '时长')
        const resolution = {}
        if (ratio.trim()) resolution.aspect_ratio = ratio.trim()
        if (megapixels.trim()) resolution.megapixels = positive(megapixels, '百万像素')
        if (Object.keys(resolution).length) input.resolution = resolution
        const values = {}
        for (const definition of workflow.customFields) {
          if (!own(custom, definition.key)) continue
          let value = custom[definition.key]
          if (definition.type === 'number' || definition.type === 'integer') {
            if (String(value).trim() === '') continue
            value = Number(value)
            if (!Number.isFinite(value) || (definition.type === 'integer' && !Number.isInteger(value))) {
              throw new Error((definition.label || definition.key) + '必须是有效' +
                (definition.type === 'integer' ? '整数。' : '数字。'))
            }
            if (definition.min != null && value < Number(definition.min)) {
              throw new Error((definition.label || definition.key) + '不能小于 ' + definition.min)
            }
            if (definition.max != null && value > Number(definition.max)) {
              throw new Error((definition.label || definition.key) + '不能大于 ' + definition.max)
            }
          }
          values[definition.key] = value
        }
        if (Object.keys(values).length) input.custom = values
        const selected = workflow.referenceSlots.filter(slot => references[slot.nodeId]?.file)
        for (const slot of selected) {
          if (slot.bypassed && !references[slot.nodeId].enable) {
            throw new Error((slot.label || slot.nodeId) + '处于旁路状态，请显式勾选启用后再提交。')
          }
        }
        if (Object.values(referenceErrors).some(Boolean)) throw new Error('请先修正参考素材错误。')
        const total = selected.reduce((sum, slot) => sum + references[slot.nodeId].file.size, 0)
        if (total > 25 * MB) throw new Error('参考文件总大小不能超过 25MB。')
        const files = []
        for (const slot of selected) {
          const entry = references[slot.nodeId]
          if (entry.file.size > 10 * MB) throw new Error('单个文件不能超过 10MB。')
          files.push({ nodeId: slot.nodeId, name: entry.note?.trim() || entry.file.name,
            mimeType: entry.file.type, data: await readBase64(entry.file, signal),
            ...(slot.bypassed ? { enable: true } : {}) })
        }
        if (files.length) input.references = files
        return input
      }

      async function submit(retry) {
        if (submitLock.current || configLock.current) return
        if (!retry && pendingRef.current) return
        if (retry && !pendingRef.current) return
        submitLock.current = true
        setSubmitBusy(true)
        setSubmitError('')
        setSubmitNotice('')
        const current = controller()
        let entry = retry ? pendingRef.current : null
        let sent = false
        try {
          if (!entry) {
            const input = await makeInput(current.signal)
            if (!alive.current || current.signal.aborted) return
            const body = { action: 'submit', input, gameId: gameId ?? null, bindToTurn, requestId: crypto.randomUUID() }
            if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 25 * MB) {
              throw new Error('含 base64 编码的完整请求超过 25MB，请减小参考文件。')
            }
            entry = { body, uncertain: true, error: '' }
          }
          entry = { ...entry, uncertain: true, error: '' }
          rememberPending(entry)
          sent = true
          const job = await request(entry.body, current.signal)
          if (!alive.current) return
          // 成功响应格式异常也不能当成未提交，必须保留原 ID。
          if (!job || typeof job.id !== 'string') {
            const error = new Error('宿主未返回有效任务，提交结果未知。')
            error.uncertain = true
            throw error
          }
          mergeJob(job)
          rememberPending(null)
          setSubmitNotice('已记录任务 ' + job.id + '；刷新只查询状态，不会重新提交。')
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (error.name === 'AbortError') return
          if (sent) {
            rememberPending({ ...entry, uncertain: Boolean(error.uncertain), error: message(error) })
          }
          if (alive.current) setSubmitError(message(error))
        } finally {
          controllers.current.delete(current)
          submitLock.current = false
          if (alive.current) setSubmitBusy(false)
        }
      }

      async function retryDownload(id) {
        if (downloadLocks.current.has(id)) return
        downloadLocks.current.add(id)
        setRetrying(previous => ({ ...previous, [id]: true }))
        setDownloadErrors(previous => ({ ...previous, [id]: '' }))
        const current = controller()
        try {
          const job = await request({ action: 'retry-download', id }, current.signal)
          if (!alive.current) return
          mergeJob(job)
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') {
            setDownloadErrors(previous => ({ ...previous, [id]: message(error) }))
          }
        } finally {
          controllers.current.delete(current)
          downloadLocks.current.delete(id)
          if (alive.current) setRetrying(previous => ({ ...previous, [id]: false }))
        }
      }

      const locked = configBusy || submitBusy || Boolean(pending)
      const formDisabled = locked || workflowBusy || !workflow
      const aliases = Array.from(new Set([DEFAULT_MODEL, ...(summary?.workflows || []).map(item => item.alias)]))
        .filter(Boolean)
      function renderCustom(definition) {
        const changed = own(custom, definition.key)
        const defaultValue = own(workflow.defaults?.custom, definition.key)
          ? workflow.defaults.custom[definition.key] : definition.defaultValue
        const value = changed ? custom[definition.key] : defaultValue ?? ''
        const change = next => setCustom(previous => ({ ...previous, [definition.key]: next }))
        const props = { style: styles.input, disabled: formDisabled }
        let control
        if (definition.type === 'boolean') {
          control = h('input', { type: 'checkbox', checked: value === true || value === 'true',
            disabled: formDisabled, onChange: event => change(event.target.checked) })
        } else if (definition.type === 'select') {
          const options = (definition.options || []).map(option =>
            typeof option === 'object' && option !== null ? option : { value: option, label: String(option) })
          control = h('select', { ...props, value: String(value), onChange: event => {
            const option = options.find(item => String(item.value) === event.target.value)
            change(option ? option.value : event.target.value)
          } }, !options.some(option => String(option.value) === String(value))
            ? h('option', { value: String(value) }, value === '' ? '使用默认值' : String(value)) : null,
          options.map((option, index) => h('option', { key: index, value: String(option.value) },
            option.label ?? String(option.value))))
        } else if (definition.type === 'text') {
          control = h('textarea', { ...props, rows: 3, value, onChange: event => change(event.target.value) })
        } else {
          const numeric = definition.type === 'number' || definition.type === 'integer'
          control = h('input', { ...props, type: numeric ? 'number' : 'text', value,
            ...(numeric ? { min: definition.min, max: definition.max,
              step: definition.type === 'integer' ? 1 : 'any' } : {}),
            onChange: event => change(event.target.value) })
        }
        return h('div', { key: definition.key, style: styles.field },
          field(definition.label || definition.key, control),
          note(definition.randomize ? '默认随机；只有手动修改才发送此参数。' : '未修改时不发送此参数。'),
          changed ? button('恢复默认（不发送）', () => setCustom(previous => {
            const next = { ...previous }; delete next[definition.key]; return next
          }), formDisabled) : null)
      }
      function renderReference(slot) {
        const entry = references[slot.nodeId] || {}
        const supported = slot.kind === 'image' || slot.kind === 'audio'
        return h('div', { key: slot.nodeId, style: styles.box },
          h('strong', null, (slot.label || slot.nodeId) + (slot.bypassed ? '（旁路）' : '')),
          note(`节点 ${slot.nodeId}${slot.tag ? ' · ' + slot.tag : ''} · ${slot.kind}`),
          supported ? field('上传参考' + (slot.kind === 'audio' ? '音频' : '图片'), h('input', {
            key: model + ':' + slot.nodeId, type: 'file', accept: slot.kind + '/*',
            style: styles.input, disabled: formDisabled, onChange: event => chooseFile(slot, event),
          })) : note('此素材类型暂不支持上传。'),
          entry.file ? note(`${entry.file.name} · ${(entry.file.size / MB).toFixed(2)}MB`) : null,
          field('名称/备注（可选，仅作为素材名称）', h('input', {
            type: 'text', style: styles.input, value: entry.note || '', disabled: formDisabled,
            onChange: event => updateReference(slot.nodeId, { note: event.target.value }),
          })),
          slot.bypassed ? checkbox('显式启用此旁路节点（上传前必须勾选）', Boolean(entry.enable),
            enable => updateReference(slot.nodeId, { enable }), formDisabled) : null,
          alert(referenceErrors[slot.nodeId]))
      }
      function renderAttachment(item, index) {
        const valid = typeof item.url === 'string' && /^\/api\/dsh-runninghub\/media\?/.test(item.url)
        let media = null
        if (valid && item.kind === 'video') {
          media = h('video', { src: item.url, controls: true, preload: 'metadata', playsInline: true,
            style: styles.media })
        } else if (valid && item.kind === 'image') {
          media = h('img', { src: item.url, alt: item.name || '生成图片', loading: 'lazy', style: styles.media })
        } else if (valid && item.kind === 'audio') {
          media = h('audio', { src: item.url, controls: true, preload: 'metadata', style: styles.media })
        }
        return h('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          note(item.name || item.kind || '附件'), media || note('此附件暂无可预览媒体。'))
      }
      function renderJob(job) {
        return h('article', { key: job.id, style: styles.box },
          h('div', { style: styles.row }, h('strong', null, statuses[job.status] || job.status),
            h('span', null, job.model || ''),
            job.costCoins != null ? h('span', null, '费用：' + job.costCoins + ' 币') : null),
          note('任务 ID：' + job.id),
          job.remoteTaskId ? note('远端任务 ID：' + job.remoteTaskId) : null,
          job.queryError ? alert('查询错误：' + message(job.queryError)) : null,
          job.error ? alert(message(job.error)) : null,
          job.binding?.generationId ? note('自动插入：已锁定提交时的正文生成回合。') : null,
          job.insertionError ? alert('正文插入失败（媒体已保留，将重试插入）：' + message(job.insertionError)) : null,
          job.status === 'submit_unknown' ? note('远端提交结果未知，请先核对任务，不要重复生成。') : null,
          ...(job.attachments || []).map(renderAttachment),
          job.status === 'download_failed' ? button(retrying[job.id] ? '正在重试下载…' : '仅重试下载（不重新生成）',
            () => retryDownload(job.id), Boolean(retrying[job.id])) : null,
          alert(downloadErrors[job.id]))
      }

      return h('div', { style: styles.root },
        h('section', { style: styles.box },
          h('strong', null, 'RunningHub 连接设置'),
          note('使用网页登录网关适配（gateway），不是 RunningHub 官方 API。网关由宿主同源接口访问。'),
          note(summary == null ? '连接状态尚未读取。' : summary.configured ? '已配置网关。' : '尚未配置网关。'),
          h('div', { style: styles.row },
            field('网关地址', h('input', { type: 'url', style: styles.input, value: baseURL, disabled: locked,
              onChange: event => { baseDirty.current = true; setBaseURL(event.target.value) } })),
            field('网关 Key（留空保留已有 Key）', h('input', { type: 'password', style: styles.input,
              autoComplete: 'new-password', value: apiKey, disabled: locked,
              onChange: event => setApiKey(event.target.value) }))),
          h('div', { style: styles.row }, button(configBusy ? '保存中…' : '保存连接设置', saveConfig, locked)),
          alert(configError), configNotice ? note(configNotice) : null),
        h('section', { style: styles.box },
          h('strong', null, '正文视频'),
          checkbox('视频完成后自动插入对应正文', summary?.autoInsert === true, saveAutoInsert, autoInsertBusy || !summary),
          note('全局选项，默认关闭。开启后，AI 在正文前提交的任务会锁定本次生成；先显示正文，视频后台完成后补入，不等待出片。'),
          note('要求模型按正文提交三个分镜任务；不会仅因打开开关自动生成或收费。anchor 指定正文原句时插在该句后，否则放在正文末尾。关闭只影响新任务，已提交任务仍按原约定插入。'),
          alert(autoInsertError)),
        h('section', { style: styles.box },
          h('strong', null, '工作流与生成参数'),
          field('工作流', h('select', { style: styles.input, value: model, disabled: locked,
            onChange: event => selectModel(event.target.value) },
          aliases.map(alias => h('option', { key: alias, value: alias }, alias)))),
          workflowBusy ? note('正在读取工作流描述…') : null,
          alert(workflowError),
          workflowError ? button('重新读取工作流', () => setConfigVersion(value => value + 1), locked) : null,
          checkbox('应用工作流默认值', applyDefaults, setApplyDefaults, locked),
          note('关闭默认值仅停用保存的默认覆盖，不会清空画布已有素材；要替换原素材，请上传并覆盖所有启用的参考槽。'),
          workflow ? h('div', { style: styles.box },
            note('默认时长：' + (workflow.videoDuration?.seconds ?? '未提供') + ' 秒；帧数：' +
              (workflow.videoDuration?.frames ?? '未提供') + '；帧率：' + (workflow.videoDuration?.fps ?? '未提供')),
            note('默认画幅：' + (workflow.videoAspect == null ? '未提供' :
              typeof workflow.videoAspect === 'object' ? JSON.stringify(workflow.videoAspect) : workflow.videoAspect)),
            note('默认分辨率：' + (workflow.defaults?.resolution ? JSON.stringify(workflow.defaults.resolution) : '未提供')),
            ...(workflow.defaults?.references || []).map((reference, index) =>
              note(`默认素材：${reference.name || '未命名'}（${reference.kind}，节点 ${reference.nodeId}）`, index)),
            !(workflow.defaults?.references || []).length ? note('未提供默认素材名称。') : null) : null,
          field('提示词（不会自动改写）', h('textarea', { style: styles.input, rows: 5, value: prompt,
            disabled: locked, onChange: event => setPrompt(event.target.value) })),
          h('div', { style: styles.row },
            field('时长覆盖（秒，可留空）', h('input', { style: styles.input, type: 'number', min: 0, step: 'any',
              value: duration, disabled: formDisabled, onChange: event => setDuration(event.target.value) })),
            field('画幅比例覆盖（可留空，如 16:9）', h('input', { style: styles.input, type: 'text',
              value: ratio, disabled: formDisabled, onChange: event => setRatio(event.target.value) })),
            field('百万像素覆盖（可留空）', h('input', { style: styles.input, type: 'number', min: 0, step: 'any',
              value: megapixels, disabled: formDisabled, onChange: event => setMegapixels(event.target.value) }))),
          workflow?.customFields.length ? h('div', { style: styles.box },
            h('strong', null, '自定义参数'), h('div', { style: styles.row }, workflow.customFields.map(renderCustom))) : null,
          h('strong', null, '参考素材'),
          note('每个文件最多 10MB，文件总计及含 base64 的完整请求均不得超过 25MB。未选文件不会发送素材覆盖。'),
          ...(workflow?.referenceSlots || []).map(renderReference),
          workflow && !workflow.referenceSlots.length ? note('此工作流未声明可上传槽位。') : null,
          checkbox('绑定当前对话轮次', bindToTurn, setBindToTurn, locked),
          note('当前游戏：' + (gameId ?? '未就绪') + '。绑定默认开启；对话未就绪时由宿主返回明确错误。'),
          h('div', { style: styles.row }, button(submitBusy ? '正在准备/提交…' : '提交生成任务',
            () => submit(false), formDisabled || !summary?.configured)),
          alert(submitError), submitNotice ? note(submitNotice) : null,
          pending ? h('div', { style: styles.box },
            h('strong', null, pending.uncertain ? '提交结果未知，请勿另建请求重复提交。' : '请求失败，可使用原请求手动重试。'),
            note('请求 ID：' + pending.body.requestId),
            note('参数与素材已锁定；重试使用同一份内容和同一个请求 ID，绝不自动重提。请先刷新任务状态。'),
            pending.error ? alert(pending.error) : null,
            button('手动重试原请求（相同 ID）', () => submit(true), submitBusy || configBusy),
            !pending.uncertain ? button('返回编辑（下一次生成新请求 ID）', () => {
              rememberPending(null); setSubmitError('')
            }, submitBusy) : null) : null),
        h('section', { style: styles.box },
          h('div', { style: styles.row }, h('strong', null, '任务历史'),
            button(refreshBusy ? '正在刷新…' : '刷新任务状态', () => setRefreshVersion(value => value + 1),
              refreshBusy || visible === false)),
          note(visible === false ? '面板隐藏，状态轮询已暂停。' : '每 5 秒查询状态；刷新只发 GET，不会提交任务。'),
          alert(refreshError), alert(summary?.gatewayError),
          ...(summary?.jobs || []).map(renderJob),
          summary && !summary.jobs?.length ? note('暂无任务。') : null))
    }

    return {
      name: 'dsh-runninghub',
      inject: ['tavernUi'],
      apply(ctx) {
        ctx.tavernUi.registerPanel({
          id: 'studio', title: 'RunningHub',
          render: ({ gameId, visible }) => h(Panel, { key: gameId ?? '__unbound__', gameId, visible }),
        })
      },
    }
  },
})
