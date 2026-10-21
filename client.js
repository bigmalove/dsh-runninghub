window.__ModuleLoader__.load({
  id: 'dsh-runninghub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    const API = '/api/dsh-runninghub'
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
    // Visual system follows the local RunningHub client, scoped to this panel.
    const css = `
.rh-studio{--rh-bg:#f4f6f8;--rh-surface:#fff;--rh-soft:#f8fafb;--rh-ink:#18212f;--rh-muted:#667085;--rh-line:#dde3ea;--rh-brand:#175cd3;--rh-brand-soft:#eff5ff;--rh-success:#087a55;--rh-success-soft:#ecfdf3;--rh-danger:#b42318;--rh-warning:#a15c07;--rh-shadow:0 1px 2px #10182806,0 8px 24px #10182806;container-type:inline-size;position:relative;isolation:isolate;min-width:0;min-height:700px;background:var(--rh-bg);color:var(--rh-ink);font:13px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;color-scheme:light}
.rh-studio[data-theme="dark"]{--rh-bg:#141a23;--rh-surface:#1b2430;--rh-soft:#202c3a;--rh-ink:#e9eef5;--rh-muted:#a4b2c4;--rh-line:#344153;--rh-brand:#8db6ff;--rh-brand-soft:#233b60;--rh-success:#74ddb5;--rh-success-soft:#1d3b35;--rh-danger:#ffaaa2;--rh-warning:#f6d08b;color-scheme:dark}
.rh-studio *{box-sizing:border-box}.rh-studio button,.rh-studio input,.rh-studio textarea,.rh-studio select{font:inherit}.rh-studio button{cursor:pointer}.rh-studio button:disabled{cursor:not-allowed;opacity:.48}.rh-studio button:focus-visible,.rh-studio input:focus-visible,.rh-studio select:focus-visible,.rh-studio textarea:focus-visible,.rh-studio summary:focus-visible{outline:3px solid color-mix(in srgb,var(--rh-brand) 35%,transparent);outline-offset:3px}.rh-studio h2,.rh-studio h3,.rh-studio p{margin:0}.rh-studio h2{font-size:22px;line-height:1.35;letter-spacing:-.04em}.rh-studio h3{font-size:14px;font-weight:700}.rh-studio svg{flex-shrink:0;display:block}
.rh-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 24px;background:var(--rh-surface);border-bottom:1px solid var(--rh-line)}.rh-brand{display:flex;align-items:center;gap:10px;min-width:0}.rh-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#172b4d;color:#fff;font-size:15px;font-weight:800;letter-spacing:-1px}.rh-brand-name{font-size:15px;font-weight:750;letter-spacing:-.3px}.rh-kicker{font-size:10px;letter-spacing:1.6px;color:var(--rh-muted);font-weight:600}.rh-top-actions,.rh-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.rh-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--rh-line);border-radius:30px;padding:5px 10px;font-size:11px;white-space:nowrap;color:var(--rh-muted)}.rh-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.rh-pill[data-state="online"]{color:var(--rh-success);background:var(--rh-success-soft);border-color:transparent}
.rh-body{padding:22px 24px 24px;max-width:1440px;margin:auto}.rh-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:20px}.rh-tabs{display:flex;align-items:center;padding:4px;background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:10px;gap:4px}.rh-tab{display:flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--rh-muted);padding:7px 13px;border-radius:7px;font-size:12px;font-weight:600}.rh-tab[aria-selected="true"]{background:var(--rh-brand-soft);color:var(--rh-brand)}.rh-count{font-size:10px;min-width:18px;text-align:center;background:var(--rh-bg);border-radius:5px;padding:0 4px}.rh-context{color:var(--rh-muted);font-size:11px;display:flex;align-items:center;gap:6px}
.rh-card{background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:14px;box-shadow:var(--rh-shadow);min-width:0}.rh-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 20px;border-bottom:1px solid var(--rh-line)}.rh-card-body{padding:20px}.rh-note{color:var(--rh-muted);font-size:11px;line-height:1.7;margin:0}.rh-eyebrow{color:var(--rh-brand);font-size:10px;font-weight:700;letter-spacing:1.7px;margin-bottom:9px}.rh-lead{font-size:12px;color:var(--rh-muted);margin-top:9px!important}.rh-hero{padding:24px 24px 20px}.rh-workflow{display:flex;align-items:center;gap:12px;margin-top:20px;padding:12px 14px;border-radius:10px;background:var(--rh-soft);border:1px solid var(--rh-line)}.rh-workflow-label{color:var(--rh-muted);font-size:11px;flex-shrink:0}.rh-workflow select{flex:1;min-width:0;max-width:420px;background:var(--rh-surface)}.rh-workflow-hint{margin-left:auto;font-size:10px;color:var(--rh-muted);white-space:nowrap}
.rh-composer{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:0;border-top:1px solid var(--rh-line)}.rh-prompt-pane{min-width:0;padding:22px 24px}.rh-section-label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;font-size:12px;font-weight:650}.rh-prompt{width:100%;resize:vertical;min-height:270px;padding:16px;border:1px solid var(--rh-line);border-radius:10px;background:var(--rh-surface);color:var(--rh-ink);line-height:1.9;outline:none}.rh-prompt:focus{border-color:var(--rh-brand);box-shadow:0 0 0 3px var(--rh-brand-soft)}.rh-prompt::placeholder{color:var(--rh-muted);opacity:.7}.rh-prompt-meta{display:flex;justify-content:space-between;gap:12px;margin-top:10px}.rh-side{padding:22px 20px;background:var(--rh-soft);border-left:1px solid var(--rh-line);min-width:0}.rh-stack{display:flex;flex-direction:column;gap:15px}.rh-field{display:flex;flex-direction:column;gap:7px;min-width:0}.rh-field-label{font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}.rh-input{box-sizing:border-box;width:100%;min-width:0;padding:9px 11px;color:var(--rh-ink);background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:8px;transition:border-color .15s}.rh-input:focus{outline:none;border-color:var(--rh-brand)}.rh-input::placeholder{color:var(--rh-muted)}.rh-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.rh-rule{height:1px;background:var(--rh-line);margin:2px 0}.rh-check{display:flex;align-items:center;gap:9px;font-size:11px;cursor:pointer}.rh-check input{width:15px;height:15px;accent-color:var(--rh-brand);margin:0;flex-shrink:0}.rh-fold{border-top:1px solid var(--rh-line);padding-top:14px}.rh-fold summary{cursor:pointer;color:var(--rh-ink);font-weight:600;font-size:12px;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px}.rh-fold summary:after{content:'+';font-size:16px;color:var(--rh-muted)}.rh-fold[open] summary:after{content:'−'}.rh-fold-content{padding-top:14px;display:flex;flex-direction:column;gap:14px}.rh-meta-list{display:flex;flex-direction:column;gap:6px;color:var(--rh-muted);font-size:11px}
.rh-references{border-top:1px solid var(--rh-line);padding:19px 24px 22px}.rh-slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:14px}.rh-slot{display:flex;flex-direction:column;gap:10px;min-width:0;padding:13px;border:1px solid var(--rh-line);border-radius:11px;background:var(--rh-soft)}.rh-slot-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.rh-slot-title{font-size:12px;font-weight:650}.rh-slot-tag{font-size:9px;color:var(--rh-muted);border:1px solid var(--rh-line);border-radius:4px;padding:1px 5px}.rh-upload{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;height:112px;border:1px dashed var(--rh-line);border-radius:8px;background:var(--rh-surface);color:var(--rh-muted);text-align:center;padding:10px;cursor:pointer;overflow:hidden}.rh-upload:hover{border-color:var(--rh-brand);color:var(--rh-brand);background:var(--rh-brand-soft)}.rh-upload:focus-within{outline:3px solid var(--rh-brand-soft);border-color:var(--rh-brand)}.rh-upload input[type="file"]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.rh-upload strong{font-size:11px;color:var(--rh-ink);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rh-upload small{font-size:10px}.rh-reference-image{width:100%;height:100%;object-fit:contain;position:absolute;inset:0}.rh-upload[data-selected="true"]{border-style:solid;border-color:var(--rh-brand)}.rh-remove{border:0;background:none;color:var(--rh-muted);font-size:10px;padding:0;cursor:pointer}.rh-filename{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--rh-muted)}
.rh-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 12px;border:1px solid var(--rh-line);border-radius:8px;background:var(--rh-surface);color:var(--rh-ink);font-size:11px;line-height:1.5;font-weight:550;white-space:nowrap}.rh-btn:hover:not(:disabled){background:var(--rh-soft);border-color:var(--rh-muted)}.rh-btn-primary{background:var(--rh-brand);color:#fff;border-color:var(--rh-brand);padding:12px 26px;font-size:12px;box-shadow:0 3px 7px #175cd322}.rh-studio[data-theme="dark"] .rh-btn-primary{color:#14243e}.rh-btn-primary:hover:not(:disabled){filter:brightness(.95);background:var(--rh-brand);border-color:var(--rh-brand)}.rh-btn-quiet{border-color:transparent;background:transparent;padding:5px 8px;color:var(--rh-muted)}.rh-btn-link{border:0;background:transparent;color:var(--rh-brand);padding:0;font-size:11px;cursor:pointer}.rh-submitbar{position:sticky;bottom:0;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 24px;background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:12px;box-shadow:0 -3px 18px #10182807;margin-top:16px}.rh-submit-summary{font-size:11px;font-weight:600}.rh-submit-sub{color:var(--rh-muted);font-size:10px;margin-top:2px}.rh-notice{margin-top:12px;padding:12px 14px;border-radius:9px;background:var(--rh-brand-soft);font-size:11px;color:var(--rh-brand)}.rh-error{white-space:pre-wrap;color:var(--rh-danger);background:color-mix(in srgb,var(--rh-danger) 7%,var(--rh-surface));border:1px solid color-mix(in srgb,var(--rh-danger) 22%,var(--rh-line));border-radius:8px;padding:10px 12px;font-size:11px;margin:10px 0}.rh-warning{padding:16px;border:1px solid color-mix(in srgb,var(--rh-warning) 35%,var(--rh-line));background:var(--rh-soft);border-radius:10px;margin-top:14px;display:flex;flex-direction:column;gap:10px}
.rh-results{margin-top:24px}.rh-results-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.rh-results-title{display:flex;align-items:center;gap:8px}.rh-filters{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:15px}.rh-filter{border:1px solid transparent;background:transparent;color:var(--rh-muted);padding:5px 10px;border-radius:6px;font-size:11px}.rh-filter[aria-pressed="true"]{background:var(--rh-surface);border-color:var(--rh-line);color:var(--rh-ink);box-shadow:0 1px 2px #10182806}.rh-jobs{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:15px}.rh-job{overflow:hidden}.rh-job-preview{position:relative;background:var(--rh-soft);border-bottom:1px solid var(--rh-line);min-height:150px;display:flex;align-items:center;justify-content:center;padding:0}.rh-job-media{display:block;width:100%;max-height:280px;object-fit:contain;background:var(--rh-soft)}.rh-job-audio{padding:24px;width:100%}.rh-job-wait{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:9px;color:var(--rh-muted);font-size:11px}.rh-job-wait svg{color:var(--rh-brand)}.rh-job-info{padding:14px 15px}.rh-job-title{font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rh-job-meta{display:flex;justify-content:space-between;gap:10px;color:var(--rh-muted);font-size:10px;margin-top:8px}.rh-status{display:inline-flex;align-items:center;gap:5px;color:var(--rh-muted);font-size:10px}.rh-status[data-state="ready"]{color:var(--rh-success)}.rh-status[data-state="running"],.rh-status[data-state="queued"],.rh-status[data-state="downloading"]{color:var(--rh-brand)}.rh-status[data-state="failed"],.rh-status[data-state="download_failed"],.rh-status[data-state="submit_unknown"]{color:var(--rh-danger)}.rh-job-details{margin-top:10px;border-top:1px solid var(--rh-line);padding-top:9px}.rh-job-details summary{font-size:10px;color:var(--rh-muted);cursor:pointer}.rh-job-details code{font-size:9px;display:block;overflow-wrap:anywhere;margin:7px 0;color:var(--rh-muted)}.rh-progress{height:3px;background:var(--rh-line);width:100%;border-radius:4px;overflow:hidden;margin-top:3px}.rh-progress span{display:block;height:100%;background:var(--rh-brand);min-width:6px}.rh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:45px 20px;border:1px dashed var(--rh-line);border-radius:12px;color:var(--rh-muted);text-align:center;background:var(--rh-surface)}.rh-empty strong{color:var(--rh-ink);font-size:12px}.rh-empty svg{opacity:.6}.rh-empty small{font-size:11px;max-width:280px}
.rh-drawer-layer{position:absolute;inset:0;z-index:20;display:flex;justify-content:flex-end;min-height:700px}.rh-backdrop{position:absolute;inset:0;border:0;background:#10182844;cursor:default!important}.rh-drawer{position:sticky;top:0;z-index:1;width:min(410px,100%);background:var(--rh-surface);border-left:1px solid var(--rh-line);box-shadow:-12px 0 40px #10182814;align-self:flex-start;min-width:0;height:100svh;max-height:100svh;overflow-y:auto}.rh-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:20px;border-bottom:1px solid var(--rh-line)}.rh-drawer-content{padding:22px;display:flex;flex-direction:column;gap:24px}.rh-setting-group{display:flex;flex-direction:column;gap:14px}.rh-setting-heading{font-size:12px;font-weight:700;display:flex;align-items:center;gap:8px}.rh-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;cursor:pointer}.rh-switch{position:relative;display:inline-flex;flex-shrink:0;width:34px;height:20px}.rh-switch input{position:absolute;inset:0;opacity:0;margin:0;width:100%;height:100%;z-index:1;cursor:pointer}.rh-switch-track{width:100%;height:100%;border-radius:20px;background:var(--rh-line);transition:background .15s}.rh-switch-track:after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;top:3px;left:3px;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .15s}.rh-switch input:checked+.rh-switch-track{background:var(--rh-brand)}.rh-switch input:checked+.rh-switch-track:after{transform:translateX(14px)}.rh-switch input:focus-visible+.rh-switch-track{outline:3px solid var(--rh-brand-soft);outline-offset:3px}.rh-switch input:disabled+.rh-switch-track{opacity:.5}.rh-skeleton{height:13px;border-radius:5px;background:var(--rh-line);opacity:.5;margin:12px 0}
@container (max-width:780px){.rh-composer{grid-template-columns:1fr}.rh-side{border-left:0;border-top:1px solid var(--rh-line)}.rh-side>.rh-stack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.rh-side .rh-fold,.rh-side .rh-rule,.rh-side .rh-section-label{grid-column:1/-1}.rh-prompt{min-height:220px}.rh-workflow-hint{display:none}.rh-jobs{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}}
@container (max-width:480px){.rh-topbar{padding:14px}.rh-body{padding:16px 12px}.rh-hero,.rh-prompt-pane{padding:18px 16px}.rh-references{padding:16px}.rh-side{padding:18px 16px}.rh-brand-name{font-size:13px}.rh-brand-sub,.rh-context,.rh-top-actions .rh-pill,.rh-prompt-meta .rh-note:last-child{display:none}.rh-nav{margin-bottom:15px}.rh-workflow{gap:8px;padding:10px;margin-top:16px}.rh-workflow select{padding:8px}.rh-studio h2{font-size:20px}.rh-side>.rh-stack{display:flex}.rh-slots{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.rh-slot{padding:9px}.rh-upload{height:105px}.rh-slot .rh-note{font-size:10px}.rh-submitbar{padding:12px;gap:10px}.rh-submit-sub{display:none}.rh-btn-primary{padding:11px 17px}.rh-submit-summary{font-size:10px}.rh-jobs{grid-template-columns:1fr}.rh-results-head{gap:6px}.rh-drawer-content{padding:18px}.rh-top-actions{gap:4px}.rh-topbar .rh-btn{padding:7px 9px}}
@media(prefers-reduced-motion:reduce){.rh-studio *{transition:none!important;animation:none!important}}
`
    const paths = {
      settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'm19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-2.2 1.3l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-2.2-1.3l-1.7.7L6.9 16l1.4-1.1a8 8 0 0 1 0-2.6L6.9 11l1.4-2.4 1.7.7a8 8 0 0 1 2.2-1.3l.3-1.8h2.8l.3 1.8a8 8 0 0 1 2.2 1.3l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2.9'],
      create: ['m15 4 5 5M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4'],
      grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
      refresh: ['M20 7v5h-5M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17'],
      upload: ['M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5'],
      image: ['M3 3h18v18H3zM3 16l5-5 6 6 3-3 4 4', 'M16 7h.01'],
      video: ['M3 5h13v14H3zM16 10l5-3v10l-5-3'],
      audio: ['M9 18V5l11-2v13M9 5l11-2', 'M9 17c0 3-6 4-6 1s6-4 6-1M20 15c0 3-6 4-6 1s6-4 6-1'],
      arrow: ['M5 12h14m-5-5 5 5-5 5'],
      close: ['m6 6 12 12M6 18 18 6'],
      clock: ['M12 8v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
      check: ['m5 12 4 4L19 6'],
      link: ['m9 15 6-6M8 17l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 7l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0'],
    }
    function icon(name, size = 16) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        (paths[name] || paths.image).map((d, index) => h('path', { key: index, d })))
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

    function button(label, onClick, disabled, key, variant = '', symbol) {
      return h('button', { key: key ?? undefined, type: 'button', className: 'rh-btn' + (variant ? ' rh-btn-' + variant : ''), onClick, disabled },
        symbol ? icon(symbol) : null, label)
    }
    function field(label, control, key) {
      return h('label', { key, className: 'rh-field' }, h('span', { className: 'rh-field-label' }, label), control)
    }
    function note(text, key) { return h('p', { key, className: 'rh-note' }, text) }
    function alert(text, key) {
      return text ? h('div', { key, role: 'alert', className: 'rh-error' }, text) : null
    }
    function checkbox(label, checked, onChange, disabled, key) {
      return h('label', { key, className: 'rh-check' }, h('input', {
        type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked),
      }), label)
    }
    function ReferencePreview({ file }) {
      const [url, setUrl] = useState('')
      useEffect(() => {
        if (!file || !file.type.startsWith('image/')) { setUrl(''); return }
        const value = URL.createObjectURL(file)
        setUrl(value)
        return () => URL.revokeObjectURL(value)
      }, [file])
      return url ? h('img', { src: url, alt: '已选参考图片', className: 'rh-reference-image' }) : null
    }

    function SavedReference({ model, asset, revision }) {
      const [failed, setFailed] = useState(false)
      useEffect(() => setFailed(false), [model, asset.nodeId, revision])
      const src = API + '/reference?model=' + encodeURIComponent(model) + '&nodeId=' + encodeURIComponent(asset.nodeId) + '&v=' + encodeURIComponent(revision || '')
      if (failed) return note('默认素材预览读取失败；生成仍由客户端读取原素材。')
      if (asset.kind === 'audio' || asset.mimeType?.startsWith('audio/')) return h('audio', {
        src, controls: true, preload: 'none', style: { width: '100%' }, 'aria-label': '客户端默认音频', onError: () => setFailed(true),
      })
      return h('img', { src, alt: '客户端默认参考图片', loading: 'lazy', style: { width: '100%', height: 112, objectFit: 'contain', borderRadius: 8 }, onError: () => setFailed(true) })
    }

    function Panel({ gameId, visible }) {
      const contextKey = gameId == null ? '__unbound__' : String(gameId)
      const [view, setView] = useState('create')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [jobFilter, setJobFilter] = useState('all')
      const [theme, setTheme] = useState('light')
      const rootRef = useRef(null)
      const settingsButtonRef = useRef(null)
      const drawerRef = useRef(null)
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
      const [model, setModel] = useState('')
      const manualModel = useRef(false)
      const [draftContext, setDraftContext] = useState('')
      const [workflow, setWorkflow] = useState(null)
      const [workflowBusy, setWorkflowBusy] = useState(false)
      const [workflowError, setWorkflowError] = useState('')
      const [prompt, setPrompt] = useState('')
      const [applyDefaults, setApplyDefaults] = useState(true)
      const [duration, setDuration] = useState('')
      const [ratio, setRatio] = useState('')
      const [megapixels, setMegapixels] = useState('')
      const [width, setWidth] = useState('')
      const [height, setHeight] = useState('')
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

      useEffect(() => {
        function updateTheme() {
          const host = rootRef.current?.parentElement
          const declared = host?.closest('[data-theme]')?.getAttribute('data-theme') || document.documentElement.getAttribute('data-color-mode')
          const dark = declared === 'dark' || document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.classList.contains('dark') || document.body.classList.contains('dark')
          setTheme(dark ? 'dark' : 'light')
        }
        updateTheme()
        const observer = new MutationObserver(updateTheme)
        for (const node of [document.documentElement, document.body]) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])
      useEffect(() => {
        if (!settingsOpen) return
        const previous = document.activeElement
        const frame = requestAnimationFrame(() => drawerRef.current?.querySelector('button, input')?.focus())
        function keyboard(event) {
          if (event.key === 'Escape') { setSettingsOpen(false); return }
          if (event.key !== 'Tab') return
          const nodes = [...(drawerRef.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],summary') || [])]
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
        document.addEventListener('keydown', keyboard)
        return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keyboard); (previous || settingsButtonRef.current)?.focus?.() }
      }, [settingsOpen])

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
              gatewayError: data.gatewayError || '', settingsError: data.settingsError || '' })
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

      const workflowListVersion = JSON.stringify((summary?.workflows || []).map(item => [item.alias, item.revision || item]))
      const syncContext = model + ':' + configVersion
      useEffect(() => {
        if (!summary?.configured || lockedForSync()) return
        const available = (summary.workflows || []).filter(item => !item.broken)
        const preferred = available.some(item => item.alias === summary.model) ? summary.model : available[0]?.alias || ''
        if (!available.some(item => item.alias === model) || !manualModel.current && model !== preferred) {
          manualModel.current = false
          setModel(preferred)
        }
      }, [workflowListVersion, summary?.model, summary?.configured, configBusy, submitBusy, pending])
      function lockedForSync() { return configBusy || submitBusy || Boolean(pendingRef.current) }
      useEffect(() => {
        if (draftContext === syncContext) return
        setDraftContext(syncContext)
        setCustom({}); setReferences({}); setReferenceErrors({})
        setDuration(''); setRatio(''); setMegapixels(''); setWidth(''); setHeight('')
        setSubmitError(''); setSubmitNotice('')
      }, [syncContext])
      useEffect(() => {
        if (!summary?.configured || !model || visible === false) return
        let active = true
        const current = controller()
        // Background synchronization must not interrupt typing or disable uploads.
        if (workflow?.syncContext !== syncContext) setWorkflowBusy(true)
        setWorkflowError('')
        request({ action: 'describe', model }, current.signal).then(data => {
          if (!active || !alive.current) return
          if (!data || data.alias !== model || !Array.isArray(data.customFields) || !Array.isArray(data.referenceSlots)) {
            throw new Error('工作流描述格式无效：缺少 customFields 或 referenceSlots')
          }
          if (data.broken) throw new Error(data.brokenReason || '客户端工作流已损坏')
          setWorkflow({ ...data, syncContext })
        }).catch(error => {
          if (active && alive.current && error.name !== 'AbortError') setWorkflowError(message(error))
        }).finally(() => {
          controllers.current.delete(current)
          if (active && alive.current) setWorkflowBusy(false)
        })
        return () => { active = false; current.abort(); controllers.current.delete(current) }
      }, [model, summary?.workflows, summary?.configured, configVersion, visible, refreshVersion])

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
        manualModel.current = true
        setModel(value)
        setWorkflow(null)
        setCustom({})
        setReferences({})
        setReferenceErrors({})
        setDuration('')
        setRatio('')
        setMegapixels('')
        setWidth(''); setHeight('')
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
        if (!workflow || workflow.syncContext !== syncContext || draftContext !== syncContext || workflowError || workflowBusy) throw new Error('请先同步当前工作流描述。')
        if (workflow.pipeline && Object.values(references).some(entry => entry.file || entry.note)) throw new Error('管线素材请在本地客户端修改，插件同步沿用。')
        if (!prompt.trim()) throw new Error('请先写下提示词。')
        const input = { model, prompt, apply_defaults: applyDefaults }
        function positive(value, label) {
          const number = Number(value)
          if (!Number.isFinite(number) || number <= 0) throw new Error(label + '必须是大于 0 的数字。')
          return number
        }
        if (durationSupported && duration.trim()) input.duration_seconds = positive(duration, '时长')
        const resolution = {}
        if (resolutionFields.has('aspect_ratio') && ratio.trim()) resolution.aspect_ratio = ratio.trim()
        if (resolutionFields.has('megapixels') && megapixels.trim()) resolution.megapixels = positive(megapixels, '百万像素')
        if (dimensionsSupported && !resolutionFields.has('aspect_ratio') && (width.trim() || height.trim())) {
          resolution.width = positive(width, '宽度')
          resolution.height = positive(height, '高度')
          if (!Number.isInteger(resolution.width) || !Number.isInteger(resolution.height)) throw new Error('宽高必须是整数。')
        }
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
        const notes = workflow.referenceSlots.filter(slot => !references[slot.nodeId]?.file && own(references[slot.nodeId], 'note'))
        for (const slot of selected) {
          if (slot.bypassed && !references[slot.nodeId].enable) {
            throw new Error((slot.label || slot.nodeId) + '处于旁路状态，请显式勾选启用后再提交。')
          }
        }
        if (workflow.referenceSlots.some(slot => referenceErrors[slot.nodeId])) throw new Error('请先修正参考素材错误。')
        const total = selected.reduce((sum, slot) => sum + references[slot.nodeId].file.size, 0)
        if (total > 25 * MB) throw new Error('参考文件总大小不能超过 25MB。')
        const files = []
        for (const slot of selected) {
          const entry = references[slot.nodeId]
          if (entry.file.size > 10 * MB) throw new Error('单个文件不能超过 10MB。')
          files.push({ nodeId: slot.nodeId, name: entry.file.name,
            mimeType: entry.file.type, data: await readBase64(entry.file, signal),
            ...(own(entry, 'note') ? { note: entry.note.trim() } : {}),
            ...(slot.bypassed ? { enable: true } : {}) })
        }
        for (const slot of notes) {
          if (!applyDefaults || slot.bypassed) continue
          files.push({ nodeId: slot.nodeId, note: references[slot.nodeId].note.trim() })
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
      const formDisabled = locked || workflowBusy || !workflow || workflow.syncContext !== syncContext || draftContext !== syncContext || Boolean(workflowError)
      const aliases = Array.from(new Set((summary?.workflows || []).filter(item => !item.broken).map(item => item.alias))).filter(Boolean)
      const resolutionFields = new Set(workflow?.capabilities?.resolutionFields || Object.keys(workflow?.capabilities?.resolutionSchema?.properties || {}))
      const dimensionsSupported = resolutionFields.has('width') && resolutionFields.has('height')
      const durationSupported = Boolean(workflow?.videoDuration || workflow?.capabilities?.durationSchema)
      const effectiveResolution = {
        ...(workflow?.pipeline?.kind === 'first-frame' ? workflow.pipeline.imageResolution : workflow?.pipeline?.gridResolution),
        ...(applyDefaults ? workflow?.defaults?.resolution : {}),
      }
      const referenceGroups = workflow?.pipeline ? workflow.referenceGroups || [] : []
      function renderCustom(definition) {
        const changed = own(custom, definition.key)
        const defaultValue = applyDefaults && own(workflow.defaults?.custom, definition.key)
          ? workflow.defaults.custom[definition.key] : definition.randomize ? '' : definition.defaultValue
        const value = changed ? custom[definition.key] : defaultValue ?? ''
        const change = next => setCustom(previous => {
          const values = { ...previous }
          if (next === '') {
            delete values[definition.key]
            if (definition.aiLora && definition.strengthKey) delete values[definition.strengthKey]
          } else values[definition.key] = next
          const option = definition.aiLoraOptions?.find(item => String(item.value) === String(next))
          if (option?.strength != null && definition.strengthKey) values[definition.strengthKey] = option.strength
          return values
        })
        const props = { className: 'rh-input', disabled: formDisabled }
        let control
        if (definition.type === 'boolean') {
          control = h('input', { type: 'checkbox', checked: value === true || value === 'true',
            disabled: formDisabled, onChange: event => change(event.target.checked) })
        } else if (definition.aiLora || definition.type === 'select') {
          const options = (definition.aiLora ? definition.aiLoraOptions || [] : definition.options || []).map(option =>
            typeof option === 'object' && option !== null ? option : { value: option, label: String(option) })
          control = h('select', { ...props, value: String(value), onChange: event => {
            const option = options.find(item => String(item.value) === event.target.value)
            change(option ? option.value : event.target.value)
          } }, !options.some(option => String(option.value) === String(value))
            ? h('option', { key: 'current', value: String(value) }, value === '' ? '使用默认值' : String(value)) : null,
          value !== '' ? h('option', { key: 'default', value: '' }, '使用客户端默认') : null,
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
        return h('div', { key: definition.key, className: 'rh-stack', style: { gap: 5 } },
          field(definition.label || definition.key, control),
          definition.randomize ? note('留空使用随机种子') : null,
          changed ? button('恢复默认', () => change(''), formDisabled, null, 'link') : null)
      }
      function renderReference(slot, group) {
        const readonly = Boolean(group)
        const source = group || workflow
        const entry = readonly ? {} : references[slot.nodeId] || {}
        const supported = !readonly && (slot.kind === 'image' || slot.kind === 'audio')
        const label = slot.label || slot.nodeId
        const defaults = (source?.defaults?.references || []).find(item => String(item.nodeId) === String(slot.nodeId))
        const pool = (source?.defaults?.referencePools || []).find(item => String(item.nodeId) === String(slot.nodeId))
        const usesDefaults = applyDefaults || readonly
        const automatic = readonly && workflow.pipeline?.kind === 'first-frame' && group.title === '视频' && /first_frame/i.test(slot.role || '')
        return h('div', { key: slot.nodeId, className: 'rh-slot' },
          h('div', { className: 'rh-slot-head' }, h('span', { className: 'rh-slot-title' }, label),
            h('span', { className: 'rh-slot-tag' }, slot.tag || (slot.kind === 'audio' ? 'AUDIO' : 'IMAGE'))),
          !entry.file && defaults && usesDefaults && !automatic ? h(SavedReference, { model: source.alias, asset: defaults, revision: source.revision || defaults.updatedAt }) : null,
          automatic ? note('由生图阶段自动填充') : null,
          !entry.file && pool && usesDefaults && !automatic ? note('客户端随机图库池 · ' + pool.galleryIds.length + ' 张，生成时随机抽取') : null,
          supported ? h('label', { className: 'rh-upload', 'data-selected': Boolean(entry.file) },
            entry.file?.type.startsWith('image/') ? h(ReferencePreview, { file: entry.file }) : icon(entry.file ? 'audio' : 'upload', 22),
            !entry.file?.type.startsWith('image/') ? h('strong', null, entry.file ? entry.file.name : '点击上传' + (slot.kind === 'audio' ? '音频' : '图片')) : null,
            !entry.file ? h('small', null, '单个文件不超过 10MB') : null,
            h('input', { key: model + ':' + slot.nodeId + ':' + (entry.file?.name || ''), type: 'file', accept: slot.kind + '/*',
              'aria-label': '上传' + label, disabled: formDisabled, onChange: event => chooseFile(slot, event) })) : readonly ? note('与客户端共用素材 · 在客户端修改') : note('暂不支持此素材类型'),
          entry.file ? h('div', { className: 'rh-filename' }, h('span', null, (entry.file.size / MB).toFixed(2) + ' MB'),
            h('button', { type: 'button', className: 'rh-remove', disabled: formDisabled,
              onClick: () => { updateReference(slot.nodeId, { file: null }); setReferenceErrors(previous => ({ ...previous, [slot.nodeId]: '' })) } }, '移除素材')) :
            note(defaults && usesDefaults ? '默认 · ' + (defaults.name || '工作流素材') : !usesDefaults ? '已停用客户端保存的默认素材' : '未上传时保留工作流素材'),
          field('素材备注', h('input', { type: 'text', className: 'rh-input', maxLength: 200,
            value: own(entry, 'note') ? entry.note : usesDefaults ? pool?.note || defaults?.note || '' : '', placeholder: '可选：人物身份、声音或用途',
            disabled: formDisabled || readonly, onChange: event => updateReference(slot.nodeId, { note: event.target.value }) })),
          !readonly && slot.bypassed ? checkbox('启用此旁路节点', Boolean(entry.enable), enable => updateReference(slot.nodeId, { enable }), formDisabled) : null,
          alert(referenceErrors[slot.nodeId]))
      }
      function renderAttachment(item, index) {
        const valid = typeof item.url === 'string' && /^\/api\/dsh-runninghub\/media\?/.test(item.url)
        let media = null
        if (valid && item.kind === 'video') {
          media = h('video', { src: item.url, controls: true, preload: 'metadata', playsInline: true,
            className: 'rh-job-media' })
        } else if (valid && item.kind === 'image') {
          media = h('img', { src: item.url, alt: item.name || '生成图片', loading: 'lazy', className: 'rh-job-media' })
        } else if (valid && item.kind === 'audio') {
          media = h('audio', { src: item.url, controls: true, preload: 'metadata', className: 'rh-job-audio' })
        }
        return h('div', { key: index, style: { width: '100%' } }, media || note('此附件暂无可预览媒体。'))
      }
      const jobs = summary?.jobs || []
      const activeStatuses = ['preparing', 'submitting', 'queued', 'running', 'downloading']
      const activeCount = jobs.filter(job => activeStatuses.includes(job.status)).length
      const shownJobs = jobs.filter(job => jobFilter === 'all' || (jobFilter === 'active' ? activeStatuses.includes(job.status)
        : jobFilter === 'ready' ? job.status === 'ready' : ['failed', 'download_failed', 'submit_unknown'].includes(job.status)))
      const durationDefault = workflow?.videoDuration?.seconds
      const selectedReferences = Object.values(references).filter(entry => entry.file).length
      function renderJob(job) {
        const inProgress = activeStatuses.includes(job.status)
        const progress = Number(job.progress)
        const time = new Date(job.createdAt)
        return h('article', { key: job.id, className: 'rh-card rh-job' },
          h('div', { className: 'rh-job-preview' }, (job.attachments || []).length ?
            h('div', { style: { width: '100%' } }, job.attachments.map(renderAttachment)) :
            h('div', { className: 'rh-job-wait' }, icon(inProgress ? 'video' : 'image', 30),
              h('span', null, job.status === 'running' ? '镜头正在生成中' : statuses[job.status] || job.status),
              inProgress ? h('div', { className: 'rh-progress' }, h('span', { style: { width: (Number.isFinite(progress) && progress > 0 ? Math.min(100, progress <= 1 ? progress * 100 : progress) : 24) + '%' } })) : null)),
          h('div', { className: 'rh-job-info' },
            h('div', { className: 'rh-job-title', title: job.model }, job.model || '生成任务'),
            h('div', { className: 'rh-job-meta' }, h('span', { className: 'rh-status', 'data-state': job.status },
              h('span', { className: 'rh-dot' }), statuses[job.status] || job.status),
              h('span', null, Number.isNaN(time.getTime()) ? '' : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))),
            job.binding?.generationId ? h('div', { className: 'rh-job-meta' }, h('span', null, '已绑定正文版本'), icon('link', 12)) : null,
            job.costCoins != null ? h('div', { className: 'rh-job-meta' }, h('span', null, '生成费用'), h('span', null, job.costCoins + ' 币')) : null,
            alert(job.queryError ? '查询暂时失败，将自动重试。' : ''), alert(job.error),
            alert(job.insertionError ? '正文插入失败，媒体已保留：' + message(job.insertionError) : ''),
            job.status === 'submit_unknown' ? note('先核对任务，请勿重复生成。') : null,
            job.status === 'download_failed' ? button(retrying[job.id] ? '下载重试中…' : '仅重试下载', () => retryDownload(job.id), Boolean(retrying[job.id]), null, '', 'refresh') : null,
            alert(downloadErrors[job.id]),
            h('details', { className: 'rh-job-details' }, h('summary', null, '任务详情'),
              h('code', null, '本地 · ' + job.id), job.remoteTaskId ? h('code', null, '远端 · ' + job.remoteTaskId) : null,
              note('刷新与下载重试不会重新生成。'))))
      }

      return h('div', { className: 'rh-studio', ref: rootRef, 'data-theme': theme },
        h('style', null, css),
        h('header', { className: 'rh-topbar' },
          h('div', { className: 'rh-brand' }, h('div', { className: 'rh-mark', 'aria-hidden': true }, 'RH'),
            h('div', null, h('div', { className: 'rh-brand-name' }, 'RunningHub'),
              h('div', { className: 'rh-kicker rh-brand-sub' }, 'LOCAL CREATIVE STUDIO'))),
          h('div', { className: 'rh-top-actions' },
            h('span', { className: 'rh-pill', 'data-state': summary?.configured && !summary.gatewayError && !refreshError ? 'online' : 'offline' },
              h('span', { className: 'rh-dot' }), summary == null ? '读取连接中' : summary.configured ? summary.gatewayError || refreshError ? '连接异常' : '网关已连接' : '待配置'),
            h('button', { type: 'button', className: 'rh-btn', ref: settingsButtonRef, 'aria-haspopup': 'dialog',
              onClick: () => setSettingsOpen(true) }, icon('settings'), '设置'))),
        h('div', { className: 'rh-body', inert: settingsOpen ? '' : undefined },
          h('nav', { className: 'rh-nav', 'aria-label': '工作台导航' },
            h('div', { className: 'rh-tabs', role: 'tablist', 'aria-label': '工作台页面' },
              h('button', { type: 'button', role: 'tab', id: 'rh-create-tab', 'aria-controls': 'rh-create-view',
                'aria-selected': view === 'create', className: 'rh-tab', onClick: () => setView('create') }, icon('create', 14), '单镜生成'),
              h('button', { type: 'button', role: 'tab', id: 'rh-history-tab', 'aria-controls': 'rh-history-view',
                'aria-selected': view === 'history', className: 'rh-tab', onClick: () => setView('history') }, icon('grid', 14), '任务历史', h('span', { className: 'rh-count' }, jobs.length))),
            h('div', { className: 'rh-context' }, icon('link', 12), gameId ? '已关联当前对话' : '独立创作')),
          alert(refreshError), alert(summary?.gatewayError), alert(summary?.settingsError ? '客户端默认模型读取失败：' + summary.settingsError : ''),
          summary && !summary.configured ? h('div', { className: 'rh-notice' }, '连接本地网关后，即可读取工作流并开始创作。 ',
            button('配置连接', () => setSettingsOpen(true), false, null, 'link')) : null,
          h('div', { id: 'rh-create-view', role: 'tabpanel', 'aria-labelledby': 'rh-create-tab', hidden: view !== 'create' },
            h('section', { className: 'rh-card' },
              h('div', { className: 'rh-hero' }, h('div', { className: 'rh-eyebrow' }, 'PROMPT PASSTHROUGH'),
                h('h2', null, '把故事，变成镜头'),
                h('p', { className: 'rh-lead' }, '选择工作流、写下画面。生成在后台继续，你可以留在故事里。'),
                h('label', { className: 'rh-workflow' }, h('span', { className: 'rh-workflow-label' }, '工作流'),
                  h('select', { className: 'rh-input', 'aria-label': '工作流', value: model, disabled: locked || !aliases.length,
                    onChange: event => selectModel(event.target.value) }, !aliases.length ? h('option', { value: '' }, '等待客户端工作流') : null,
                    aliases.map(alias => h('option', { key: alias, value: alias }, alias))),
                  h('span', { className: 'rh-workflow-hint' }, workflowBusy ? '读取参数中…' : workflow ? '已与客户端同步' : '等待连接')),
                h('div', { className: 'rh-row', style: { marginTop: 10 } },
                  button('同步客户端', () => setRefreshVersion(value => value + 1), locked || refreshBusy || workflowBusy, null, 'link', 'refresh'),
                  manualModel.current ? button('跟随客户端工作流', () => { manualModel.current = false; selectModel(summary?.model || aliases[0] || ''); manualModel.current = false }, locked, null, 'link') : note('默认工作流跟随客户端')),
                alert(workflowError), workflowError ? button('重新读取工作流', () => setRefreshVersion(value => value + 1), locked, null, 'link') : null,
                ...(workflow?.syncErrors || []).map((error, index) => alert(error, index))),
              h('div', { className: 'rh-composer' },
                h('div', { className: 'rh-prompt-pane' },
                  h('div', { className: 'rh-section-label' }, h('label', { htmlFor: 'rh-prompt' }, '提示词'),
                    button('清空', () => setPrompt(''), locked || !prompt, null, 'quiet')),
                  h('textarea', { id: 'rh-prompt', className: 'rh-prompt', rows: 9, value: prompt, disabled: locked,
                    placeholder: '描述你想看见的画面…\n\n主体、动作、场景、光线，以及镜头如何移动。\n提示词原样发送，不会自动改写。', onChange: event => setPrompt(event.target.value) }),
                  h('div', { className: 'rh-prompt-meta' }, note(prompt.length + ' 字'), note('原文直传 · 不自动改写')),
                  h('div', { className: 'rh-notice' }, h('div', { className: 'rh-row' }, icon('link', 14),
                    h('span', null, summary?.autoInsert ? '正文视频自动插入已开启' : '创作与正文可以同步进行'),
                    button('联动设置', () => setSettingsOpen(true), false, null, 'link')),
                    note(summary?.autoInsert ? 'AI 生成的镜头会绑定提交时的正文版本，完成后自动补入。' : '在设置里开启自动插入，AI 可先写正文，视频完成后再补入。'))),
                h('aside', { className: 'rh-side', 'aria-label': '生成参数' },
                  h('div', { className: 'rh-stack' },
                    h('div', { className: 'rh-section-label', style: { marginBottom: 0 } }, '生成参数',
                      button('重置', () => { setDuration(''); setRatio(''); setMegapixels(''); setWidth(''); setHeight(''); setCustom({}); setApplyDefaults(true) }, formDisabled, null, 'link')),
                    resolutionFields.has('aspect_ratio') ? field('画面比例', h('input', { className: 'rh-input', value: ratio,
                      placeholder: String(effectiveResolution.aspect_ratio || workflow?.videoAspect?.ratio || '客户端默认'), disabled: formDisabled, onChange: event => setRatio(event.target.value) })) : null,
                    durationSupported ? field('片长 / 秒', h('input', { className: 'rh-input', type: 'number', min: 0.5, max: 120, step: 'any', value: duration,
                      placeholder: durationDefault != null ? String(durationDefault) : '默认', disabled: formDisabled, onChange: event => setDuration(event.target.value) })) : null,
                    resolutionFields.has('megapixels') ? field('像素量 / MP', h('input', { className: 'rh-input', type: 'number', min: 0.1, max: 16, step: 'any', value: megapixels,
                      placeholder: String(effectiveResolution.megapixels ?? '默认'), disabled: formDisabled, onChange: event => setMegapixels(event.target.value) })) : null,
                    dimensionsSupported && !resolutionFields.has('aspect_ratio') ? h('div', { className: 'rh-grid2' },
                      field('宽度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: width,
                        placeholder: String(effectiveResolution.width ?? '默认'), disabled: formDisabled, onChange: event => setWidth(event.target.value) })),
                      field('高度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: height,
                        placeholder: String(effectiveResolution.height ?? '默认'), disabled: formDisabled, onChange: event => setHeight(event.target.value) }))) : null,
                    !resolutionFields.size ? note('分辨率沿用客户端工作流；未声明可覆盖字段。') : null,
                    checkbox('应用工作流默认值', applyDefaults, setApplyDefaults, locked),
                    checkbox('绑定当前对话轮次', bindToTurn, setBindToTurn, locked),
                    h('details', { className: 'rh-fold' }, h('summary', null, '自定义参数', h('span', { className: 'rh-count' }, workflow?.customFields.length || 0)),
                      h('div', { className: 'rh-fold-content' }, workflow?.customFields.length ? workflow.customFields.map(renderCustom) : note('此工作流暂无自定义参数。'))),
                    h('details', { className: 'rh-fold' }, h('summary', null, '工作流默认设置'),
                      h('div', { className: 'rh-fold-content rh-meta-list' },
                        note('片长 ' + (durationDefault ?? '—') + ' 秒 · ' + (workflow?.videoDuration?.fps ?? '—') + ' fps'),
                        note('分辨率 ' + (workflow?.defaults?.resolution ? JSON.stringify(workflow.defaults.resolution) : '使用画布原值')),
                        ...(workflow?.defaults?.references || []).map((item, index) => note('素材 · ' + (item.name || '未命名'), index)),
                        note('关闭默认值只停用已保存的覆盖，不清空画布素材。替换素材需覆盖所有启用槽位。')))))),
              h('section', { className: 'rh-references', 'aria-label': '参考素材' },
                h('div', { className: 'rh-section-label', style: { marginBottom: 0 } }, h('span', null, '参考素材'),
                  h('span', { className: 'rh-note' }, selectedReferences ? '已选择 ' + selectedReferences + ' 份' : '图片 / 音频')),
                workflowBusy ? h('div', { className: 'rh-skeleton' }) : null,
                workflow?.pipeline ? referenceGroups.map(group => h('section', { key: group.alias + group.title, style: { marginTop: 14 } },
                  h('h3', null, group.title + ' · ' + group.alias), h('div', { className: 'rh-slots' }, group.referenceSlots.map(slot => renderReference(slot, group))))) :
                workflow?.referenceSlots.length ? h('div', { className: 'rh-slots' }, workflow.referenceSlots.map(slot => renderReference(slot))) :
                  h('div', { style: { paddingTop: 13 } }, note(workflow ? '此工作流无需上传参考素材。' : '连接工作流后显示参考素材槽位。')),
                h('div', { style: { marginTop: 12 } }, note('槽位、默认素材、备注和随机池均读取客户端；每 5 秒同步。本次上传仅覆盖本次生成，不改客户端默认。单文件 ≤ 10MB，请求 ≤ 25MB。')))),
            h('div', { className: 'rh-submitbar' },
              h('div', null, h('div', { className: 'rh-submit-summary' }, model + ' · ' + (ratio || '默认画幅') + (duration || durationDefault ? ' · ' + (duration || durationDefault) + 's' : '')),
                h('div', { className: 'rh-submit-sub' }, activeCount ? activeCount + ' 个任务在后台运行' : '参数确认后提交，按实际工作流计费')),
              button(submitBusy ? '正在提交…' : '开始生成', () => submit(false), formDisabled || !summary?.configured || !prompt.trim(), null, 'primary', 'arrow')),
            alert(submitError), submitNotice ? h('div', { className: 'rh-notice', role: 'status' }, '任务已提交，结果会出现在最近生成中。') : null,
            pending ? h('div', { className: 'rh-warning' },
              h('strong', null, pending.uncertain ? '提交结果待核对' : '请求失败'),
              note('参数和素材已锁定。先刷新状态，手动重试沿用相同 ID，不另建任务。'),
              h('code', { className: 'rh-note' }, pending.body.requestId), alert(pending.error),
              h('div', { className: 'rh-row' }, button('手动重试原请求', () => submit(true), submitBusy || configBusy),
                !pending.uncertain ? button('返回编辑', () => { rememberPending(null); setSubmitError('') }, submitBusy, null, 'quiet') : null)) : null),
          h('section', { className: 'rh-results', id: 'rh-history-view', role: view === 'history' ? 'tabpanel' : undefined,
            'aria-labelledby': view === 'history' ? 'rh-history-tab' : undefined },
            h('div', { className: 'rh-results-head' }, h('div', { className: 'rh-results-title' }, h('h3', null, view === 'history' ? '任务历史' : '最近生成'),
              h('span', { className: 'rh-count' }, jobs.length)),
              button(refreshBusy ? '正在刷新…' : '刷新', () => setRefreshVersion(value => value + 1), refreshBusy || visible === false, null, 'quiet', 'refresh')),
            h('div', { className: 'rh-filters', role: 'group', 'aria-label': '任务筛选' },
              [['all', '全部'], ['active', '进行中'], ['ready', '已完成'], ['failed', '异常']].map(([value, label]) =>
                h('button', { key: value, type: 'button', className: 'rh-filter', 'aria-pressed': jobFilter === value,
                  onClick: () => setJobFilter(value) }, label))),
            shownJobs.length ? h('div', { className: 'rh-jobs' }, (view === 'create' ? shownJobs.slice(0, 6) : shownJobs).map(renderJob)) :
              h('div', { className: 'rh-empty' }, icon('image', 30), h('strong', null, jobs.length ? '暂无符合筛选的任务' : '你的第一个镜头，从这里开始'),
                h('small', null, jobs.length ? '试试切换筛选条件。' : '生成结果会保存在本地。切换页面，不会打断后台任务。')),
            h('div', { style: { marginTop: 12 } }, note(visible === false ? '面板隐藏时暂停轮询' : '每 5 秒自动更新 · 刷新不会重新生成')))),
        settingsOpen ? h('div', { className: 'rh-drawer-layer' },
          h('button', { type: 'button', className: 'rh-backdrop', 'aria-label': '关闭设置遮罩', tabIndex: -1, onClick: () => setSettingsOpen(false) }),
          h('section', { className: 'rh-drawer', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'rh-settings-title', ref: drawerRef },
            h('div', { className: 'rh-drawer-head' }, h('div', null, h('h3', { id: 'rh-settings-title' }, '工作台设置'), note('连接网关与正文联动')),
              h('button', { type: 'button', className: 'rh-btn rh-btn-quiet', 'aria-label': '关闭设置', onClick: () => setSettingsOpen(false) }, icon('close'))),
            h('div', { className: 'rh-drawer-content' },
              h('section', { className: 'rh-setting-group' }, h('div', { className: 'rh-setting-heading' }, icon('link'), '网关连接'),
                field('网关地址', h('input', { type: 'url', className: 'rh-input', value: baseURL, disabled: locked,
                  onChange: event => { baseDirty.current = true; setBaseURL(event.target.value) } })),
                field('网关 Key', h('input', { type: 'password', className: 'rh-input', autoComplete: 'new-password', value: apiKey,
                  placeholder: summary?.configured ? '已配置，留空保留原 Key' : '输入网关 Key', disabled: locked, onChange: event => setApiKey(event.target.value) })),
                note('经 Tavern 同源接口访问本地网关。Key 存入宿主凭据服务，不显示已保存的值。'),
                button(configBusy ? '保存中…' : '保存连接设置', saveConfig, locked), alert(configError),
                configNotice ? h('div', { className: 'rh-notice', role: 'status' }, configNotice) : null),
              h('div', { className: 'rh-rule' }),
              h('section', { className: 'rh-setting-group' }, h('div', { className: 'rh-setting-heading' }, icon('video'), '正文视频'),
                h('label', { className: 'rh-toggle-row' }, h('span', null, '视频完成后自动插入对应正文'),
                  h('span', { className: 'rh-switch' }, h('input', { type: 'checkbox', checked: summary?.autoInsert === true,
                    disabled: autoInsertBusy || !summary, onChange: event => saveAutoInsert(event.target.checked) }), h('span', { className: 'rh-switch-track', 'aria-hidden': true }))),
                note('先输出正文，视频在后台生成，完成后补到原句或正文末尾。绑定提交时的版本，不随重生成串位。'),
                h('details', { className: 'rh-fold' }, h('summary', null, '联动说明'), h('div', { className: 'rh-fold-content' },
                  note('开启后，模型可按正文提交三个分镜任务；仅切换开关不会生成或收费。'),
                  note('关闭只影响新任务，已提交的任务仍按原约定插入。'))), alert(autoInsertError))))) : null)
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
