window.__ModuleLoader__.load({
  id: 'dsh-runninghub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    const API = '/api/dsh-runninghub'
    const LIBRARY = API + '/library'
    const DEFAULT_BASE = 'http://127.0.0.1:6888'
    const MB = 1024 * 1024
    // 仅在内存中保留未确认请求；面板重新挂载时也不生成新的请求 ID。
    const pendingRequests = new Map()
    // 重新生成的未确认请求按「对话 + 任务」保留，网络不明时重试仍沿用同一 requestId。
    const pendingRegenerations = new Map()
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
    const message = error => typeof error === 'string' ? error : error?.message || '未知错误'
    const statuses = {
      preparing: '准备中', submitting: '提交中', submit_unknown: '提交结果未知',
      queued: '排队中', running: '生成中', downloading: '下载中', ready: '已就绪',
      failed: '失败', download_failed: '下载失败',
    }
    const pregenStatuses = {
      generating: '生成中', ready: '就绪', failed: '失败',
      used: '已用', discarded: '已删', stale: '已退',
    }
    // Visual system follows the local RunningHub client, scoped to this panel.
    const css = `
.rh-studio{--rh-bg:#f4f6f8;--rh-surface:#fff;--rh-soft:#f8fafb;--rh-ink:#18212f;--rh-muted:#667085;--rh-line:#dde3ea;--rh-brand:#175cd3;--rh-brand-soft:#eff5ff;--rh-success:#087a55;--rh-success-soft:#ecfdf3;--rh-danger:#b42318;--rh-warning:#a15c07;--rh-shadow:0 1px 2px #10182806,0 8px 24px #10182806;container-type:inline-size;position:relative;isolation:isolate;min-width:0;min-height:0;max-height:100%;height:100%;flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;background:var(--rh-bg);color:var(--rh-ink);font:13px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;color-scheme:light}
.rh-studio[data-theme="dark"]{--rh-bg:#141a23;--rh-surface:#1b2430;--rh-soft:#202c3a;--rh-ink:#e9eef5;--rh-muted:#a4b2c4;--rh-line:#344153;--rh-brand:#8db6ff;--rh-brand-soft:#233b60;--rh-success:#74ddb5;--rh-success-soft:#1d3b35;--rh-danger:#ffaaa2;--rh-warning:#f6d08b;color-scheme:dark}
.rh-studio *{box-sizing:border-box}.rh-studio button,.rh-studio input,.rh-studio textarea,.rh-studio select{font:inherit}.rh-studio button{cursor:pointer}.rh-studio button:disabled{cursor:not-allowed;opacity:.48}.rh-studio button:focus-visible,.rh-studio input:focus-visible,.rh-studio select:focus-visible,.rh-studio textarea:focus-visible,.rh-studio summary:focus-visible{outline:3px solid color-mix(in srgb,var(--rh-brand) 35%,transparent);outline-offset:3px}.rh-studio h2,.rh-studio h3,.rh-studio p{margin:0}.rh-studio h2{font-size:22px;line-height:1.35;letter-spacing:-.04em}.rh-studio h3{font-size:14px;font-weight:700}.rh-studio svg{flex-shrink:0;display:block}
.rh-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 24px;background:var(--rh-surface);border-bottom:1px solid var(--rh-line)}.rh-brand{display:flex;align-items:center;gap:10px;min-width:0}.rh-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#172b4d;color:#fff;font-size:15px;font-weight:800;letter-spacing:-1px}.rh-brand-name{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:750;letter-spacing:-.3px}.rh-ui-badge{padding:1px 4px;border:1px solid color-mix(in srgb,var(--rh-brand) 28%,var(--rh-line));border-radius:4px;background:var(--rh-brand-soft);color:var(--rh-brand);font-size:8px;font-weight:700;letter-spacing:.3px;line-height:1.5}.rh-kicker{font-size:10px;letter-spacing:1.6px;color:var(--rh-muted);font-weight:600}.rh-top-actions,.rh-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.rh-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--rh-line);border-radius:30px;padding:5px 10px;font-size:11px;white-space:nowrap;color:var(--rh-muted)}.rh-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.rh-pill[data-state="online"]{color:var(--rh-success);background:var(--rh-success-soft);border-color:transparent}
.rh-body{padding:22px 24px 24px;max-width:1440px;margin:auto}.rh-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:20px}.rh-tabs{display:flex;align-items:center;padding:4px;background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:10px;gap:4px}.rh-tab{display:flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--rh-muted);padding:7px 13px;border-radius:7px;font-size:12px;font-weight:600}.rh-tab[aria-selected="true"]{background:var(--rh-brand-soft);color:var(--rh-brand)}.rh-count{font-size:10px;min-width:18px;text-align:center;background:var(--rh-bg);border-radius:5px;padding:0 4px}.rh-context{color:var(--rh-muted);font-size:11px;display:flex;align-items:center;gap:6px}
.rh-card{background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:14px;box-shadow:var(--rh-shadow);min-width:0}.rh-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 20px;border-bottom:1px solid var(--rh-line)}.rh-card-body{padding:20px}.rh-note{color:var(--rh-muted);font-size:11px;line-height:1.7;margin:0}.rh-eyebrow{color:var(--rh-brand);font-size:10px;font-weight:700;letter-spacing:1.7px;margin-bottom:9px}.rh-lead{font-size:12px;color:var(--rh-muted);margin-top:9px!important}.rh-hero{padding:24px 24px 20px}.rh-workflow{display:flex;align-items:center;gap:12px;margin-top:20px;padding:12px 14px;border-radius:10px;background:var(--rh-soft);border:1px solid var(--rh-line)}.rh-workflow-label{color:var(--rh-muted);font-size:11px;flex-shrink:0}.rh-workflow select{flex:1;min-width:0;max-width:420px;background:var(--rh-surface)}.rh-workflow-hint{margin-left:auto;font-size:10px;color:var(--rh-muted);white-space:nowrap}
.rh-composer{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:0;border-top:1px solid var(--rh-line)}.rh-prompt-pane{min-width:0;padding:22px 24px}.rh-section-label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;font-size:12px;font-weight:650}.rh-prompt{width:100%;resize:vertical;min-height:270px;padding:16px;border:1px solid var(--rh-line);border-radius:10px;background:var(--rh-surface);color:var(--rh-ink);line-height:1.9;outline:none}.rh-prompt:focus{border-color:var(--rh-brand);box-shadow:0 0 0 3px var(--rh-brand-soft)}.rh-prompt::placeholder{color:var(--rh-muted);opacity:.7}.rh-prompt-meta{display:flex;justify-content:space-between;gap:12px;margin-top:10px}.rh-side{padding:22px 20px;background:var(--rh-soft);border-left:1px solid var(--rh-line);min-width:0}.rh-stack{display:flex;flex-direction:column;gap:15px}.rh-field{display:flex;flex-direction:column;gap:7px;min-width:0}.rh-field-label{font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}.rh-input{box-sizing:border-box;width:100%;min-width:0;padding:9px 11px;color:var(--rh-ink);background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:8px;transition:border-color .15s}.rh-input:focus{outline:none;border-color:var(--rh-brand)}.rh-input::placeholder{color:var(--rh-muted)}.rh-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.rh-rule{height:1px;background:var(--rh-line);margin:2px 0}.rh-check{display:flex;align-items:center;gap:9px;font-size:11px;cursor:pointer}.rh-check input{width:15px;height:15px;accent-color:var(--rh-brand);margin:0;flex-shrink:0}.rh-fold{border-top:1px solid var(--rh-line);padding-top:14px}.rh-fold summary{cursor:pointer;color:var(--rh-ink);font-weight:600;font-size:12px;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px}.rh-fold summary:after{content:'+';font-size:16px;color:var(--rh-muted)}.rh-fold[open] summary:after{content:'−'}.rh-fold-content{padding-top:14px;display:flex;flex-direction:column;gap:14px}.rh-meta-list{display:flex;flex-direction:column;gap:6px;color:var(--rh-muted);font-size:11px}
.rh-references{border-top:1px solid var(--rh-line);padding:19px 24px 22px}.rh-slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:14px}.rh-slot{display:flex;flex-direction:column;gap:10px;min-width:0;padding:13px;border:1px solid var(--rh-line);border-radius:11px;background:var(--rh-soft)}.rh-slot-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.rh-slot-title{font-size:12px;font-weight:650}.rh-slot-tag{font-size:9px;color:var(--rh-muted);border:1px solid var(--rh-line);border-radius:4px;padding:1px 5px}.rh-upload{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;height:112px;border:1px dashed var(--rh-line);border-radius:8px;background:var(--rh-surface);color:var(--rh-muted);text-align:center;padding:10px;cursor:pointer;overflow:hidden}.rh-upload:hover{border-color:var(--rh-brand);color:var(--rh-brand);background:var(--rh-brand-soft)}.rh-upload:focus-within{outline:3px solid var(--rh-brand-soft);border-color:var(--rh-brand)}.rh-upload input[type="file"]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.rh-upload strong{font-size:11px;color:var(--rh-ink);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rh-upload small{font-size:10px}.rh-reference-image{width:100%;height:100%;object-fit:contain;position:absolute;inset:0}.rh-upload[data-selected="true"]{border-style:solid;border-color:var(--rh-brand)}.rh-remove{border:0;background:none;color:var(--rh-muted);font-size:10px;padding:0;cursor:pointer}.rh-filename{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:var(--rh-muted)}.rh-filename-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rh-ink)}
.rh-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 12px;border:1px solid var(--rh-line);border-radius:8px;background:var(--rh-surface);color:var(--rh-ink);font-size:11px;line-height:1.5;font-weight:550;white-space:nowrap}.rh-btn:hover:not(:disabled){background:var(--rh-soft);border-color:var(--rh-muted)}.rh-btn-primary{background:var(--rh-brand);color:#fff;border-color:var(--rh-brand);padding:12px 26px;font-size:12px;box-shadow:0 3px 7px #175cd322}.rh-studio[data-theme="dark"] .rh-btn-primary{color:#14243e}.rh-btn-primary:hover:not(:disabled){filter:brightness(.95);background:var(--rh-brand);border-color:var(--rh-brand)}.rh-btn-quiet{border-color:transparent;background:transparent;padding:5px 8px;color:var(--rh-muted)}.rh-btn-link{border:0;background:transparent;color:var(--rh-brand);padding:0;font-size:11px;cursor:pointer}.rh-submitbar{position:sticky;bottom:0;z-index:4;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 24px;background:var(--rh-surface);border:1px solid var(--rh-line);border-radius:12px;box-shadow:0 -3px 18px #10182807;margin-top:16px}.rh-submit-summary{font-size:11px;font-weight:600}.rh-submit-sub{color:var(--rh-muted);font-size:10px;margin-top:2px}.rh-notice{margin-top:12px;padding:12px 14px;border-radius:9px;background:var(--rh-brand-soft);font-size:11px;color:var(--rh-brand)}.rh-error{white-space:pre-wrap;color:var(--rh-danger);background:color-mix(in srgb,var(--rh-danger) 7%,var(--rh-surface));border:1px solid color-mix(in srgb,var(--rh-danger) 22%,var(--rh-line));border-radius:8px;padding:10px 12px;font-size:11px;margin:10px 0}.rh-warning{padding:16px;border:1px solid color-mix(in srgb,var(--rh-warning) 35%,var(--rh-line));background:var(--rh-soft);border-radius:10px;margin-top:14px;display:flex;flex-direction:column;gap:10px}
.rh-studio .rh-btn{flex:0 0 auto;width:auto;max-width:100%}.rh-studio .rh-job-info-compact>.rh-row{justify-content:flex-start}.rh-studio .rh-job-info-compact>.rh-row>.rh-btn{flex:0 0 auto!important;width:auto!important}.rh-results{margin-top:24px}.rh-results-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.rh-results-title{display:flex;align-items:center;gap:8px}.rh-filters{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:15px}.rh-filter{border:1px solid transparent;background:transparent;color:var(--rh-muted);padding:5px 10px;border-radius:6px;font-size:11px}.rh-filter[aria-pressed="true"]{background:var(--rh-surface);border-color:var(--rh-line);color:var(--rh-ink);box-shadow:0 1px 2px #10182806}.rh-jobs{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:15px}.rh-job{overflow:hidden}.rh-job-preview{position:relative;background:var(--rh-soft);border-bottom:1px solid var(--rh-line);min-height:150px;display:flex;align-items:center;justify-content:center;padding:0}.rh-job-media{display:block;width:100%;max-height:280px;object-fit:contain;background:var(--rh-soft)}.rh-job-audio{padding:24px;width:100%}.rh-job-wait{padding:28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:9px;color:var(--rh-muted);font-size:11px}.rh-job-wait svg{color:var(--rh-brand)}.rh-job-info{padding:14px 15px}.rh-job-title{font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rh-job-meta{display:flex;justify-content:space-between;gap:10px;color:var(--rh-muted);font-size:10px;margin-top:8px}.rh-status{display:inline-flex;align-items:center;gap:5px;color:var(--rh-muted);font-size:10px}.rh-status[data-state="ready"]{color:var(--rh-success)}.rh-status[data-state="running"],.rh-status[data-state="queued"],.rh-status[data-state="downloading"]{color:var(--rh-brand)}.rh-status[data-state="failed"],.rh-status[data-state="download_failed"],.rh-status[data-state="submit_unknown"]{color:var(--rh-danger)}.rh-job-details{margin-top:10px;border-top:1px solid var(--rh-line);padding-top:9px}.rh-job-details summary{font-size:10px;color:var(--rh-muted);cursor:pointer}.rh-job-details code{font-size:9px;display:block;overflow-wrap:anywhere;margin:7px 0;color:var(--rh-muted)}.rh-progress{height:3px;background:var(--rh-line);width:100%;border-radius:4px;overflow:hidden;margin-top:3px}.rh-progress span{display:block;height:100%;background:var(--rh-brand);min-width:6px}.rh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:45px 20px;border:1px dashed var(--rh-line);border-radius:12px;color:var(--rh-muted);text-align:center;background:var(--rh-surface)}.rh-empty strong{color:var(--rh-ink);font-size:12px}.rh-empty svg{opacity:.6}.rh-empty small{font-size:11px;max-width:280px}

.rh-video-summary{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 12px 9px}
.rh-video-summary-copy{flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:2px}
.rh-video-summary-status{display:flex;align-items:center;justify-content:space-between;gap:6px}
.rh-video-summary .rh-status{font-size:9px}
.rh-video-summary-time{font-size:9px;color:var(--rh-muted);font-variant-numeric:tabular-nums}
.rh-video-summary .rh-job-title{font-size:12px;margin-top:1px}
.rh-video-meta{font-size:9.5px;color:var(--rh-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-video-binding{display:flex;align-items:center;gap:4px;margin-top:auto;color:var(--rh-success);font-size:9px;line-height:1.5}
.rh-video-binding[data-state="error"]{color:var(--rh-danger)}
.rh-video-binding .icon{width:10px;height:10px}
.rh-video-thumb{position:relative;display:block;flex:none;padding:0;border:0;border-radius:8px;overflow:hidden;background:#0e1721;box-shadow:0 1px 3px #10182824;cursor:pointer}
.rh-video-thumb-hit{position:absolute;inset:0;z-index:2;width:100%;height:100%;padding:0;border:0;border-radius:inherit;background:transparent;cursor:pointer}
.rh-video-thumb-hit:focus-visible{outline:none;box-shadow:inset 0 0 0 3px var(--rh-brand)}
.rh-video-thumb video{display:block;width:100%;height:100%;object-fit:cover;background:#0e1721;pointer-events:none}
.rh-video-thumb-card{width:122px;height:69px}
.rh-video-thumb-toast{width:112px;height:63px}
.rh-video-play{position:absolute;left:50%;top:50%;pointer-events:none;transform:translate(-50%,-50%);display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:#070d1699;border:1px solid #ffffff8c;color:#fff;backdrop-filter:blur(3px);box-shadow:0 4px 14px #00000047;transition:background .18s,transform .18s,border-color .18s}
.rh-video-thumb-toast .rh-video-play{width:27px;height:27px}
.rh-video-thumb:hover .rh-video-play,.rh-video-thumb:focus-visible .rh-video-play{background:var(--rh-brand);border-color:transparent;transform:translate(-50%,-50%) scale(1.06)}
.rh-video-play .icon{width:12px;height:12px;margin-left:1px}
.rh-video-duration{position:absolute;right:5px;bottom:4px;pointer-events:none;padding:1px 4px;border-radius:4px;background:#060b12b8;color:#fff;font-size:8px;line-height:1.5;letter-spacing:.2px;font-variant-numeric:tabular-nums}
.rh-job-info-compact{padding:0 12px 12px}
.rh-job-info-compact>.rh-row{padding-top:10px;border-top:1px solid var(--rh-line)}
.rh-job-info-compact .rh-job-details{margin-top:9px}
.rh-video-toasts{position:fixed;z-index:15;left:12px;right:12px;bottom:12px;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:8px;pointer-events:none}
.rh-video-toasts-raised{bottom:90px}
.rh-video-toast{position:relative;display:flex;align-items:center;gap:11px;width:100%;max-width:396px;padding:9px;border:1px solid var(--rh-line);border-radius:13px;background:var(--rh-surface);box-shadow:0 16px 40px #1018282e,0 2px 8px #10182814;pointer-events:auto;cursor:pointer;overflow:hidden;animation:rh-toast-in .3s cubic-bezier(.22,1,.36,1)}
.rh-video-toast::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--rh-success)}
.rh-video-toast:hover{border-color:color-mix(in srgb,var(--rh-brand) 38%,var(--rh-line));box-shadow:0 20px 48px #1018283d,0 2px 8px #1018281a}
.rh-video-toast-copy{flex:1;min-width:0;padding-right:24px}
.rh-video-toast-kicker{display:flex;align-items:center;gap:5px;color:var(--rh-success);font-size:9px;font-weight:650;line-height:1.5}
.rh-video-check{display:grid;place-items:center;width:13px;height:13px;flex:none;border-radius:50%;background:var(--rh-success);color:var(--rh-surface)}
.rh-video-check .icon{width:8px;height:8px;stroke-width:2.6}
.rh-video-toast-title{margin-top:1px;font-size:11.5px;font-weight:650;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-video-toast-meta{margin-top:1px;color:var(--rh-muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-video-toast-close{position:absolute;top:5px;right:5px;display:grid;place-items:center;width:21px;height:21px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--rh-muted);opacity:.72}
.rh-video-toast-close:hover{background:var(--rh-soft);color:var(--rh-ink);opacity:1}
.rh-video-toast-close .icon{width:12px;height:12px}
@keyframes rh-toast-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
.rh-player-dialog{position:fixed;inset:0;display:grid;place-items:center;width:100%;max-width:none;height:100%;max-height:none;margin:0;padding:28px;border:0;background:transparent;color:#e9f0f9;overflow:auto;box-sizing:border-box}
.rh-player-dialog:not([open]){display:none}
.rh-player-dialog::backdrop{background:#03070ccc;backdrop-filter:blur(9px)}
.rh-player{display:flex;flex-direction:column;width:min(880px,100%);max-height:calc(100vh - 56px);overflow:hidden;border:1px solid #ffffff21;border-radius:16px;background:#0e1520;color:#e9f0f9;box-shadow:0 40px 120px #000000a6,0 1px 0 #ffffff0f inset;animation:rh-player-in .28s cubic-bezier(.22,1,.36,1)}
@keyframes rh-player-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.rh-player-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:15px 18px 13px;border-bottom:1px solid #ffffff14;background:#111a26}
.rh-player-kicker{color:#7fa7dd;font-size:8px;font-weight:700;letter-spacing:1.6px}
.rh-player-dialog .rh-player-title{margin:3px 0 0;font-size:15px;line-height:1.4;letter-spacing:-.2px;font-weight:650;color:#e9f0f9}
.rh-player-sub{margin-top:3px;color:#8b9bb0;font-size:9.5px}
.rh-player-close{flex:none;display:grid;place-items:center;width:31px;height:31px;padding:0;border:1px solid #ffffff1f;border-radius:8px;background:#ffffff0a;color:#d9e5f4}
.rh-player-close:hover{background:#ffffff1a;border-color:#ffffff33}
.rh-player-close .icon{width:14px;height:14px}
.rh-player-stage{position:relative;background:#000;aspect-ratio:16/9;max-height:calc(100vh - 270px)}
.rh-player-stage video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.rh-player-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 18px;border-top:1px solid #ffffff14;background:#111a26}
.rh-player-chips{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.rh-player-chip{padding:2px 7px;border:1px solid #ffffff17;border-radius:999px;background:#ffffff0b;color:#9fadc0;font-size:9px;line-height:1.6;white-space:nowrap}
.rh-player-actions{display:flex;align-items:center;gap:6px;flex:none}
.rh-player-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 10px;border:1px solid #ffffff21;border-radius:7px;background:#ffffff0b;color:#d8e4f4;font-size:10px;line-height:1.45;font-weight:550;white-space:nowrap}
.rh-player-btn:hover{background:#ffffff1a}
.rh-player-btn.primary{background:#2f6fdd;border-color:#2f6fdd;color:#fff}
.rh-player-btn.primary:hover{background:#3b7ceb}
.rh-player-btn .icon{width:12px;height:12px}
@media (max-width:560px){.rh-studio .rh-player-dialog{padding:12px}.rh-studio .rh-player{width:100%;border-radius:12px}.rh-studio .rh-player-foot{align-items:flex-start;flex-direction:column}.rh-studio .rh-player-stage{max-height:none}.rh-studio .rh-video-toasts{left:8px;right:8px;bottom:8px}.rh-studio .rh-video-toasts-raised{bottom:84px}.rh-studio .rh-video-thumb-toast{width:96px;height:54px}}

.rh-job-row{padding:0}
.rh-job-row-main{display:flex;align-items:center;gap:10px;padding:8px 10px}
.rh-job-row-media{position:relative;flex:none;width:72px;height:40px}
.rh-video-thumb-dense{width:72px;height:40px}
.rh-video-thumb-dense .rh-video-play{width:22px;height:22px;border-width:1px}
.rh-video-thumb-dense .rh-video-play .icon{width:9px;height:9px}
.rh-video-thumb-dense .rh-video-duration{right:3px;bottom:2px;padding:0 3px;font-size:7px;border-radius:3px}
.rh-job-row-thumb{display:block;width:72px;height:40px;overflow:hidden;border:1px solid var(--rh-line);border-radius:6px;background:#0e1721}
.rh-job-row-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.rh-job-row-count{position:absolute;right:-3px;bottom:-3px;z-index:3;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--rh-ink);color:var(--rh-surface);font-size:7px;line-height:14px;text-align:center}
.rh-job-row-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.rh-job-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.rh-job-row-top .rh-status{flex:none;font-size:9px}
.rh-job-row-top .rh-job-title{flex:1;min-width:0;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-job-row-time{flex:none;color:var(--rh-muted);font-size:8.5px;font-variant-numeric:tabular-nums}
.rh-job-row-sub{min-width:0;color:var(--rh-muted);font-size:9px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-job-row-error{color:var(--rh-danger)}
.rh-job-row-progress{height:2px;margin-top:2px;background:var(--rh-bg);border-radius:3px;overflow:hidden}
.rh-job-row-progress span{display:block;height:100%;background:var(--rh-brand);border-radius:inherit}
.rh-job-row-actions{display:flex;align-items:center;gap:4px;flex:none}
.rh-studio .rh-job-row-actions .rh-btn{flex:0 0 auto;width:auto!important;height:24px;padding:3px 6px;font-size:9px;line-height:1.35;border-radius:6px;gap:3px}
.rh-studio .rh-job-row-actions .rh-btn .icon{width:10px;height:10px}
.rh-studio .rh-job-row-actions .rh-btn-primary{padding:3px 7px}
.rh-job-row-details{margin:0;padding:0 10px 6px;border-top:1px solid var(--rh-line)}
.rh-job-row-details summary{display:flex;align-items:center;gap:4px;padding:4px 0 2px;color:var(--rh-muted);font-size:8px;line-height:1.4;list-style:none;cursor:pointer}
.rh-job-row-details summary:before{content:'▸';font-size:8px}
.rh-job-row-details[open] summary:before{content:'▾'}
.rh-job-row-details code{display:block;margin:3px 0;color:var(--rh-muted);font-size:8px;line-height:1.5;overflow-wrap:anywhere}
.rh-job-row-details .rh-note{font-size:8.5px;line-height:1.5}
.rh-job-row-details .rh-error{margin:4px 0;padding:5px 7px;font-size:9px;line-height:1.5}
.rh-job-wait-dense{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:72px;height:40px;min-height:0;padding:0;border:1px solid var(--rh-line);border-radius:6px;background:var(--rh-soft);color:var(--rh-muted);font-size:7px;line-height:1.2;text-align:center;overflow:hidden}
.rh-job-wait-dense .icon{width:14px;height:14px;color:var(--rh-brand)}
.rh-job-wait-dense span{font-size:7px}
.rh-job-wait-dense[data-state="failed"],.rh-job-wait-dense[data-state="download_failed"]{color:var(--rh-danger)}
.rh-job-wait-dense[data-state="failed"] .icon,.rh-job-wait-dense[data-state="download_failed"] .icon{color:var(--rh-danger)}

.rh-task-table{overflow:hidden;border:1px solid var(--rh-line);border-radius:12px;background:var(--rh-surface);box-shadow:var(--rh-shadow)}
.rh-task-head{display:grid;grid-template-columns:64px minmax(0,1.1fr) 92px 62px minmax(120px,1fr) auto;gap:10px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--rh-line);background:var(--rh-soft);color:var(--rh-muted);font-size:9px;font-weight:650;letter-spacing:.2px}
.rh-task-row{display:grid;grid-template-columns:64px minmax(0,1.1fr) 92px 62px minmax(120px,1fr) auto;gap:10px;align-items:center;min-width:0;padding:6px 12px;border-bottom:1px solid var(--rh-line);background:var(--rh-surface)}
.rh-task-row:last-child{border-bottom:0}
.rh-task-media{position:relative;flex:none;width:64px;height:36px}
.rh-task-row .rh-video-thumb-dense{width:64px;height:36px}
.rh-task-row .rh-video-thumb-dense .rh-video-play{width:20px;height:20px}
.rh-task-row .rh-video-thumb-dense .rh-video-play .icon{width:8px;height:8px}
.rh-task-row .rh-video-thumb-dense .rh-video-duration{right:3px;bottom:2px;padding:0 3px;font-size:6.5px;border-radius:3px}
.rh-task-row .rh-job-row-thumb{width:64px;height:36px}
.rh-task-row .rh-job-wait-dense{width:64px;height:36px}
.rh-task-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.rh-task-title{display:flex;align-items:center;gap:6px;min-width:0}
.rh-task-title .rh-status{flex:none;font-size:9px}
.rh-task-title .rh-job-title{min-width:0;font-size:11px;font-weight:650;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-task-kind{min-width:0;color:var(--rh-muted);font-size:8.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-task-progress{height:2px;margin-top:1px;background:var(--rh-bg);border-radius:3px;overflow:hidden}
.rh-task-progress span{display:block;height:100%;background:var(--rh-brand);border-radius:inherit}
.rh-task-time,.rh-task-cost{color:var(--rh-muted);font-size:8.5px;line-height:1.45;white-space:nowrap;font-variant-numeric:tabular-nums}
.rh-task-note{min-width:0;color:var(--rh-muted);font-size:9px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-task-error{color:var(--rh-danger)}
.rh-task-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:none}
.rh-studio .rh-task-actions .rh-btn{flex:0 0 auto;width:auto!important;height:24px;padding:3px 6px;font-size:9px;line-height:1.35;border-radius:6px;gap:3px}
.rh-studio .rh-task-actions .rh-btn .icon{width:10px;height:10px}
.rh-studio .rh-task-actions .rh-btn-primary{padding:3px 7px}
.rh-task-details{grid-column:1/-1;min-width:0;margin:0;padding:0;border-top:1px solid var(--rh-line)}
.rh-task-details summary{display:flex;align-items:center;gap:4px;padding:3px 0 0;color:var(--rh-muted);font-size:8px;line-height:1.4;list-style:none;cursor:pointer}
.rh-task-details summary:before{content:'▸';font-size:8px}
.rh-task-details[open] summary:before{content:'▾'}
.rh-task-details code{display:block;margin:3px 0;color:var(--rh-muted);font-size:8px;line-height:1.5;overflow-wrap:anywhere}
.rh-task-details .rh-note{font-size:8.5px;line-height:1.5}
.rh-task-details .rh-error{margin:4px 0;padding:5px 7px;font-size:9px;line-height:1.5}
@container (max-width:680px){
  .rh-task-head{display:none}
  .rh-task-row{grid-template-columns:64px minmax(0,1fr) auto;gap:8px;padding:8px 10px}
  .rh-task-time,.rh-task-cost{display:none}
  .rh-task-note{grid-column:2/4;font-size:9px}
  .rh-task-details{grid-column:1/-1}
}

.rh-task-groups{display:flex;flex-direction:column;gap:12px}
.rh-media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.rh-media-card{min-width:0;overflow:hidden;border:1px solid var(--rh-line);border-radius:10px;background:var(--rh-surface);box-shadow:var(--rh-shadow)}
.rh-media-thumb{position:relative;aspect-ratio:16/9;overflow:hidden;background:#0e1721}
.rh-video-thumb-cover{width:100%;height:100%;border-radius:0;box-shadow:none}
.rh-video-thumb-cover .rh-video-play{width:36px;height:36px}
.rh-video-thumb-cover .rh-video-play .icon{width:14px;height:14px}
.rh-video-thumb-cover .rh-video-duration{right:6px;bottom:5px;padding:1px 4px;font-size:8px}
.rh-media-thumb-link{display:block;width:100%;height:100%}
.rh-media-thumb-link img{display:block;width:100%;height:100%;object-fit:cover}
.rh-media-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;padding:0;border:0;border-radius:0;background:linear-gradient(145deg,var(--rh-soft),var(--rh-bg));color:var(--rh-muted);font-size:9px;text-align:center}
.rh-media-placeholder .icon{color:var(--rh-brand)}
.rh-media-progress{width:60%;height:3px;border-radius:3px;background:var(--rh-line);overflow:hidden}
.rh-media-progress span{display:block;height:100%;background:var(--rh-brand)}
.rh-media-status{position:absolute;left:6px;top:6px;z-index:3;pointer-events:none;display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;background:#0b1220c2;color:#e9f0f9;font-size:8px;line-height:1.6;backdrop-filter:blur(4px)}
.rh-media-status .rh-dot{width:5px;height:5px}
.rh-media-status[data-state="ready"]{color:#8ff0c2}
.rh-media-status[data-state="running"],.rh-media-status[data-state="queued"],.rh-media-status[data-state="downloading"]{color:#a9ccff}
.rh-media-status[data-state="failed"],.rh-media-status[data-state="download_failed"],.rh-media-status[data-state="submit_unknown"]{color:#ffb4ad}
.rh-media-count{position:absolute;right:6px;bottom:6px;z-index:3;pointer-events:none;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#0b1220c2;color:#fff;font-size:8px;line-height:16px;text-align:center;backdrop-filter:blur(4px)}
.rh-media-foot{display:flex;align-items:center;gap:8px;padding:7px 8px;border-top:1px solid var(--rh-line)}
.rh-media-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.rh-media-info .rh-job-title{font-size:11px;font-weight:650;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-media-meta{color:var(--rh-muted);font-size:8.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-media-actions{flex:none;display:flex;align-items:center;gap:4px}
.rh-studio .rh-media-actions .rh-btn{flex:0 0 auto;width:auto!important;height:23px;padding:2px 6px;font-size:8.5px;line-height:1.35;border-radius:6px;gap:3px}
.rh-studio .rh-media-actions .rh-btn .icon{width:10px;height:10px}
.rh-media-details{margin:0;padding:0 8px 5px;border-top:1px solid var(--rh-line)}
.rh-media-details summary,.rh-fail-details summary{display:flex;align-items:center;gap:4px;padding:2px 0 0;color:var(--rh-muted);font-size:8px;line-height:1.4;list-style:none;cursor:pointer}
.rh-media-details summary:before,.rh-fail-details summary:before{content:'▸';font-size:8px}
.rh-media-details[open] summary:before,.rh-fail-details[open] summary:before{content:'▾'}
.rh-media-details code,.rh-fail-details code{display:block;margin:3px 0;color:var(--rh-muted);font-size:8px;line-height:1.5;overflow-wrap:anywhere}
.rh-media-details .rh-note,.rh-fail-details .rh-note{font-size:8.5px;line-height:1.5}
.rh-media-details .rh-error,.rh-fail-details .rh-error{margin:4px 0;padding:5px 7px;font-size:9px;line-height:1.5}
.rh-fail-section{overflow:hidden;border:1px solid var(--rh-line);border-radius:10px;background:var(--rh-surface)}
.rh-fail-head{display:flex;align-items:center;gap:5px;padding:6px 10px;border-bottom:1px solid var(--rh-line);background:var(--rh-soft);color:var(--rh-muted);font-size:9px;font-weight:600}
.rh-fail-row{display:grid;grid-template-columns:26px minmax(0,1fr) 84px 56px auto;gap:8px;align-items:center;padding:4px 10px;border-bottom:1px solid var(--rh-line)}
.rh-fail-row:last-child{border-bottom:0}
.rh-fail-icon{display:grid;place-items:center;width:24px;height:24px;border:1px solid color-mix(in srgb,var(--rh-danger) 20%,var(--rh-line));border-radius:6px;background:color-mix(in srgb,var(--rh-danger) 7%,var(--rh-surface));color:var(--rh-danger)}
.rh-fail-copy{min-width:0}
.rh-fail-title{display:flex;align-items:center;gap:5px;min-width:0}
.rh-fail-title .rh-status{flex:none;font-size:8.5px}
.rh-fail-title .rh-job-title{min-width:0;font-size:10.5px;font-weight:600;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-fail-error{color:var(--rh-danger);font-size:8.5px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-fail-time,.rh-fail-cost{color:var(--rh-muted);font-size:8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.rh-fail-actions{display:flex;align-items:center;gap:4px;flex:none}
.rh-studio .rh-fail-actions .rh-btn{flex:0 0 auto;width:auto!important;height:22px;padding:2px 6px;font-size:8.5px;line-height:1.35;border-radius:6px;gap:3px}
.rh-fail-details{grid-column:1/-1;min-width:0;margin:0;padding:0;border-top:1px solid var(--rh-line)}
@container (max-width:600px){
  .rh-media-grid{grid-template-columns:1fr}
  .rh-fail-row{grid-template-columns:26px minmax(0,1fr) auto;gap:6px}
  .rh-fail-time,.rh-fail-cost{display:none}
  .rh-fail-details{grid-column:1/-1}
}
.rh-pregen{margin-top:24px}.rh-pregen-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.rh-pregen-entry{overflow:hidden;border:1px solid var(--rh-line);border-radius:11px;background:var(--rh-surface);display:flex;flex-direction:column;min-width:0}.rh-pregen-preview{background:var(--rh-soft);border-bottom:1px solid var(--rh-line);min-height:130px;display:flex;align-items:center;justify-content:center;position:relative}.rh-pregen-video{display:block;width:100%;max-height:240px;object-fit:contain;background:#000}.rh-pregen-info{padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}.rh-pregen-meta{display:flex;justify-content:space-between;gap:8px;color:var(--rh-muted);font-size:10px}.rh-pregen-desc{margin:0;font-size:12px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.rh-pregen-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}.rh-pregen-settings{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr)) auto auto;gap:10px;align-items:end;padding-bottom:14px;border-bottom:1px solid var(--rh-line)}.rh-pregen-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:26px 18px;margin-top:12px;border:1px dashed var(--rh-line);border-radius:10px;color:var(--rh-muted);text-align:center}.rh-pregen-empty strong{color:var(--rh-ink);font-size:12px}.rh-pregen-empty small{font-size:11px;max-width:340px}
.rh-drawer-layer{position:absolute;inset:0;z-index:20;display:flex;justify-content:flex-end;min-height:0}.rh-backdrop{position:absolute;inset:0;border:0;background:#10182844;cursor:default!important}.rh-drawer{position:sticky;top:0;z-index:1;width:min(410px,100%);background:var(--rh-surface);border-left:1px solid var(--rh-line);box-shadow:-12px 0 40px #10182814;align-self:flex-start;min-width:0;height:100svh;max-height:100svh;overflow-y:auto}.rh-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:20px;border-bottom:1px solid var(--rh-line)}.rh-drawer-content{padding:22px;display:flex;flex-direction:column;gap:24px}.rh-setting-group{display:flex;flex-direction:column;gap:14px}.rh-setting-heading{font-size:12px;font-weight:700;display:flex;align-items:center;gap:8px}.rh-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;cursor:pointer}.rh-switch{position:relative;display:inline-flex;flex-shrink:0;width:34px;height:20px}.rh-switch input{position:absolute;inset:0;opacity:0;margin:0;width:100%;height:100%;z-index:1;cursor:pointer}.rh-switch-track{width:100%;height:100%;border-radius:20px;background:var(--rh-line);transition:background .15s}.rh-switch-track:after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;top:3px;left:3px;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .15s}.rh-switch input:checked+.rh-switch-track{background:var(--rh-brand)}.rh-switch input:checked+.rh-switch-track:after{transform:translateX(14px)}.rh-switch input:focus-visible+.rh-switch-track{outline:3px solid var(--rh-brand-soft);outline-offset:3px}.rh-switch input:disabled+.rh-switch-track{opacity:.5}.rh-settings-status{padding:10px 12px;border:1px solid var(--rh-line);border-radius:9px;background:var(--rh-soft);font-size:11px;line-height:1.65;color:var(--rh-muted)}.rh-settings-status[data-state="saved"]{color:var(--rh-success);border-color:color-mix(in srgb,var(--rh-success) 28%,var(--rh-line))}.rh-settings-status[data-state="dirty"]{color:var(--rh-warning);border-color:color-mix(in srgb,var(--rh-warning) 30%,var(--rh-line))}.rh-settings-status[data-state="saving"]{color:var(--rh-brand)}.rh-settings-status[data-state="error"],.rh-settings-status[data-state="conflict"]{color:var(--rh-danger);border-color:color-mix(in srgb,var(--rh-danger) 28%,var(--rh-line))}.rh-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.rh-model-field{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--rh-line);border-radius:9px;background:var(--rh-soft);min-width:0}.rh-model-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.rh-model-field-title{font-size:11px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rh-skeleton{height:13px;border-radius:5px;background:var(--rh-line);opacity:.5;margin:12px 0}
.rh-slot-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:-2px}.rh-slot-actions .rh-btn{font-size:10px}
.rh-library-dialog{position:fixed;inset:0;width:100%;max-width:none;height:100%;max-height:none;margin:0;padding:24px;border:0;background:transparent;display:grid;place-items:center;overflow:auto;box-sizing:border-box}
.rh-library-dialog:not([open]){display:none}
.rh-library-dialog::backdrop{background:#03070c66;backdrop-filter:blur(4px)}
.rh-library{display:flex;flex-direction:column;width:min(760px,100%);max-height:calc(100vh - 48px);overflow:hidden;border:1px solid var(--rh-line);border-radius:16px;background:var(--rh-surface);color:var(--rh-ink);box-shadow:0 30px 90px #10182840,0 2px 8px #10182814;animation:rh-library-in .22s cubic-bezier(.22,1,.36,1)}
@keyframes rh-library-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.rh-library-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 20px 14px;border-bottom:1px solid var(--rh-line)}
.rh-library-head-copy{min-width:0}
.rh-library-kicker{color:var(--rh-brand);font-size:8px;font-weight:700;letter-spacing:1.5px}
.rh-library .rh-library-title{margin:4px 0 0;font-size:16px;line-height:1.4;letter-spacing:-.2px;font-weight:650}
.rh-library .rh-library-sub{margin-top:4px;color:var(--rh-muted);font-size:10.5px;line-height:1.6}
.rh-library-close{flex:none;display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid var(--rh-line);border-radius:8px;background:var(--rh-soft);color:var(--rh-muted)}
.rh-library-close:hover{color:var(--rh-ink);border-color:var(--rh-muted)}
.rh-library-close .icon{width:13px;height:13px}
.rh-library-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 20px;border-bottom:1px solid var(--rh-line);background:var(--rh-soft);flex-wrap:wrap}
.rh-library-body{padding:14px 20px 20px;overflow:auto;min-height:120px}
.rh-library-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px}
.rh-library-item{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:5px;padding:0 0 7px;border:1px solid var(--rh-line);border-radius:10px;background:var(--rh-surface);text-align:left;overflow:hidden;color:var(--rh-ink);min-width:0}
.rh-library-item:hover:not(:disabled){border-color:var(--rh-brand);box-shadow:0 0 0 2px var(--rh-brand-soft)}
.rh-library-item:disabled{cursor:not-allowed;opacity:.65}
.rh-library-thumb{position:relative;display:grid;place-items:center;aspect-ratio:1;background:var(--rh-soft);overflow:hidden;color:var(--rh-muted)}
.rh-library-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:var(--rh-soft)}
.rh-library-name{display:block;padding:0 7px;font-size:10.5px;font-weight:600;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-library-size{display:block;padding:0 7px;color:var(--rh-muted);font-size:9px;line-height:1.5}
.rh-library-list{display:flex;flex-direction:column;gap:7px}
.rh-library-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--rh-line);border-radius:9px;background:var(--rh-surface);text-align:left;color:var(--rh-ink);min-width:0}
.rh-library-row:hover:not(:disabled){border-color:var(--rh-brand);background:var(--rh-brand-soft)}
.rh-library-row:disabled{cursor:not-allowed;opacity:.65}
.rh-library-row-icon{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:8px;background:var(--rh-soft);color:var(--rh-brand)}
.rh-library-row-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.rh-library-row-copy strong{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rh-library-row-copy small{color:var(--rh-muted);font-size:9.5px}
.rh-library-row-action{flex:none;color:var(--rh-brand);font-size:10px;font-weight:600}
.rh-library-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:48px 18px;text-align:center;color:var(--rh-muted);font-size:11px}
.rh-library-empty strong{color:var(--rh-ink);font-size:12px}
.rh-library-empty svg{opacity:.55}
.rh-library-skeleton{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.rh-library-skeleton .rh-skeleton{height:120px;margin:0}
@media (max-width:560px){.rh-library-dialog{padding:10px}.rh-library{max-height:calc(100vh - 20px);border-radius:12px}.rh-library-head,.rh-library-toolbar,.rh-library-body{padding-left:14px;padding-right:14px}.rh-library-grid{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}}
@container (max-width:780px){.rh-composer{grid-template-columns:1fr}.rh-side{border-left:0;border-top:1px solid var(--rh-line)}.rh-side>.rh-stack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.rh-side .rh-fold,.rh-side .rh-rule,.rh-side .rh-section-label{grid-column:1/-1}.rh-prompt{min-height:220px}.rh-workflow-hint{display:none}.rh-jobs{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}}@container (max-width:480px){.rh-topbar{padding:14px}.rh-body{padding:16px 12px}.rh-hero,.rh-prompt-pane{padding:18px 16px}.rh-references{padding:16px}.rh-side{padding:18px 16px}.rh-brand-name{font-size:13px}.rh-brand-sub,.rh-context,.rh-top-actions .rh-pill,.rh-prompt-meta .rh-note:last-child{display:none}.rh-nav{margin-bottom:15px}.rh-workflow{gap:8px;padding:10px;margin-top:16px}.rh-workflow select{padding:8px}.rh-studio h2{font-size:20px}.rh-side>.rh-stack{display:flex}.rh-slots{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.rh-slot{padding:9px}.rh-upload{height:105px}.rh-slot .rh-note{font-size:10px}.rh-submitbar{padding:12px;gap:10px}.rh-submit-sub{display:none}.rh-btn-primary{padding:11px 17px}.rh-submit-summary{font-size:10px}.rh-jobs{grid-template-columns:1fr}.rh-results-head{gap:6px}.rh-drawer-content{padding:18px}.rh-top-actions{gap:4px}.rh-topbar .rh-btn{padding:7px 9px}}
@media(prefers-reduced-motion:reduce){.rh-studio *{transition:none!important;animation:none!important}}
@container (max-width:780px){.rh-pregen-settings{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:480px){.rh-pregen-grid{grid-template-columns:1fr}.rh-pregen-settings{grid-template-columns:1fr}}
`
    const paths = {
      settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'm19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-2.2 1.3l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-2.2-1.3l-1.7.7L6.9 16l1.4-1.1a8 8 0 0 1 0-2.6L6.9 11l1.4-2.4 1.7.7a8 8 0 0 1 2.2-1.3l.3-1.8h2.8l.3 1.8a8 8 0 0 1 2.2 1.3l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2.9'],
      create: ['m15 4 5 5M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4'],
      grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
      refresh: ['M20 7v5h-5M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17'],
      upload: ['M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5'],
      image: ['M3 3h18v18H3zM3 16l5-5 6 6 3-3 4 4', 'M16 7h.01'],
      play: ['M8 5.4v13.2L19 12 8 5.4Z'],
      video: ['M3 5h13v14H3zM16 10l5-3v10l-5-3'],
      audio: ['M9 18V5l11-2v13M9 5l11-2', 'M9 17c0 3-6 4-6 1s6-4 6-1M20 15c0 3-6 4-6 1s6-4 6-1'],
      arrow: ['M5 12h14m-5-5 5 5-5 5'],
      close: ['m6 6 12 12M6 18 18 6'],
      clock: ['M12 8v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
      check: ['m5 12 4 4L19 6'],
      link: ['m9 15 6-6M8 17l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 7l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0'],
    }
    function icon(name, size = 16) {
      const fill = name === 'play'
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: fill ? 'currentColor' : 'none', stroke: fill ? 'none' : 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        (paths[name] || paths.image).map((d, index) => h('path', { key: index, d })))
    }

    const MEDIA_URL = /^\/api\/dsh-runninghub\/media\?/
    const isMediaUrl = url => typeof url === 'string' && MEDIA_URL.test(url)
    const jobLabel = job => job?.model || '生成任务'
    const canRegenerateJob = job => job?.replayable === true && ['ready', 'failed', 'download_failed'].includes(job.status)
    const hasJobBinding = job => Boolean(job?.binding && (job.binding.generationId || job.binding.gameId || Number.isInteger(job.binding.turn)))
    function videoAttachmentOf(job) {
      const items = Array.isArray(job?.attachments) ? job.attachments : []
      return items.find(item => item?.kind === 'video' && isMediaUrl(item.url)) || null
    }
    function compactVideoOf(job) {
      const items = Array.isArray(job?.attachments) ? job.attachments : []
      return items.length === 1 && items[0]?.kind === 'video' && isMediaUrl(items[0].url) ? items[0] : null
    }
    function formatDuration(value) {
      if (!Number.isFinite(value) || value < 0) return ''
      const total = Math.round(value)
      return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
    }
    function formatBytes(value) {
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return Math.round(value) + ' B'
      if (value < MB) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB'
      return (value / MB).toFixed(value < 10 * MB ? 1 : 0) + ' MB'
    }
    function formatJobTime(job) {
      const time = new Date(job?.createdAt)
      return Number.isNaN(time.getTime()) ? '' : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    function formatJobClock(job) {
      const time = new Date(job?.createdAt)
      return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    function toastMeta(job) {
      const parts = []
      const clock = formatJobClock(job)
      if (clock) parts.push(clock)
      if (job?.costCoins != null) parts.push(job.costCoins + ' 币')
      if (hasJobBinding(job)) parts.push(job.insertionError ? '插入失败' : '已绑定正文')
      else parts.push('独立创作')
      return parts.join(' · ')
    }
    function playerSubtitle(job) {
      const parts = []
      if (Number.isInteger(job?.binding?.turn)) parts.push('第 ' + job.binding.turn + ' 轮')
      if (hasJobBinding(job)) parts.push(job.insertionError ? '正文插入失败' : '已绑定正文版本')
      return parts.join(' · ') || '视频预览'
    }
    // 媒体路由偶尔会在面板刚挂载时返回一次失败（鉴权/范围请求的瞬时问题），
    // 原生 <video> 不会自己重试。这里只给 RunningHub 媒体 URL 加一次 retry 参数；
    // React 的 src prop 没变，重渲染不会把改过的 src 覆盖回去。
    function retryMediaOnce(event) {
      const video = event.currentTarget
      if (!video || typeof video.src !== 'string') return
      let url
      try { url = new URL(video.src, window.location.href) } catch { return }
      if (!url.pathname.startsWith('/api/dsh-runninghub/media') || url.searchParams.has('retry')) return
      url.searchParams.set('retry', '1')
      video.src = url.href
    }

    function VideoThumb({ item, className, label, onClick }) {
      const [duration, setDuration] = useState(null)
      return h('div', { className: 'rh-video-thumb' + (className ? ' ' + className : '') },
        h('video', {
          src: item.url, preload: 'metadata', muted: true, playsInline: true, controls: false,
          'aria-hidden': true, tabIndex: -1, onError: retryMediaOnce,
          onLoadedMetadata: event => {
            const value = event.currentTarget.duration
            if (Number.isFinite(value) && value > 0) setDuration(value)
          },
        }),
        h('span', { className: 'rh-video-play', 'aria-hidden': true }, icon('play', 12)),
        duration != null ? h('span', { className: 'rh-video-duration' }, formatDuration(duration)) : null,
        h('button', { type: 'button', className: 'rh-video-thumb-hit', onClick, 'aria-label': label, title: label }))
    }

    async function request(body, signal, gameId) {
      let response
      try {
        const url = body ? API : API + (gameId ? '?gameId=' + encodeURIComponent(String(gameId)) : '')
        response = await fetch(url, {
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

    // 输入框上方的生成状态：任务一提交就显示「生成中」，不等正文结算。
    // 正文走工具调用时正文要到最后才落版，正文里的媒体卡会晚几分钟才出现；
    // 这块停靠区只轮询本地任务记录（action: jobs），与网关、正文渲染都无关。
    const DOCK_ACTIVE = new Set(['preparing', 'submitting', 'queued', 'running', 'downloading'])
    const DOCK_STAGE = { preparing: '准备中', submitting: '提交中', queued: '排队中', running: '生成中', downloading: '下载中' }
    const DOCK_FLASH_MS = 6000

    // 只把最近这批任务算进「已就绪 / 失败」：历史任务不该让停靠区报一个虚高的数字。
    const DOCK_RECENT_MS = 20 * 60 * 1000
    function dockRecent(job, now) {
      const created = Date.parse(job.createdAt)
      if (!Number.isFinite(created)) return false
      const age = now - created
      return age < DOCK_RECENT_MS && age > -2 * 60 * 1000
    }

    function dockSummary(jobs, now = Date.now()) {
      const list = Array.isArray(jobs) ? jobs.filter(job => job && typeof job === 'object') : []
      const active = list.filter(job => DOCK_ACTIVE.has(job.status))
      const ready = list.filter(job => job.status === 'ready' && dockRecent(job, now)).length
      const failed = list.filter(job => ['failed', 'download_failed', 'submit_unknown'].includes(job.status) && dockRecent(job, now)).length
      const stages = []
      for (const status of ['preparing', 'submitting', 'queued', 'running', 'downloading']) {
        const count = active.filter(job => job.status === status).length
        if (count) stages.push(DOCK_STAGE[status] + ' ' + count)
      }
      return { active: active.length, ready, failed, stages }
    }

    const dockCSS = `
.rh-dock{display:flex;align-items:center;gap:10px;box-sizing:border-box;margin:0 0 6px;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07));color:var(--dsw-alias-label-secondary,#667085);font:12px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
.rh-dock-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#175cd3;animation:rh-dock-pulse 1.8s ease-out infinite}
.rh-dock[data-state="done"] .rh-dock-dot{background:#087a55;animation:none}
.rh-dock[data-state="failed"] .rh-dock-dot{background:#b42318;animation:none}
.rh-dock-copy{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.rh-dock-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#18212f)}
.rh-dock-title b{font-weight:650}
.rh-dock-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#98a2b3)}
.rh-dock-bar{flex:none;width:64px;height:3px;border-radius:3px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.3));overflow:hidden}
.rh-dock-bar>span{display:block;width:40%;height:100%;border-radius:3px;background:#175cd3;animation:rh-dock-slide 1.4s ease-in-out infinite}
@keyframes rh-dock-pulse{0%{box-shadow:0 0 0 0 rgba(23,92,211,.4)}70%{box-shadow:0 0 0 6px rgba(23,92,211,0)}100%{box-shadow:0 0 0 0 rgba(23,92,211,0)}}
@keyframes rh-dock-slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.rh-dock-dot{animation:none}.rh-dock-bar>span{animation:none;width:100%}}
`

    function GenerationDock(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [jobs, setJobs] = useState(null)
      const [flash, setFlash] = useState(null)
      const activeRef = useRef(false)
      const seenActive = useRef(false)
      const flashTimer = useRef(null)

      useEffect(() => {
        if (!sessionId) return undefined
        // 换局时先清掉上一局的数字，等第一轮轮询回来再显示。
        setJobs(null)
        setFlash(null)
        seenActive.current = false
        let live = true
        let timer = null
        let controller = null
        let inFlight = false
        const schedule = ms => { timer = setTimeout(poll, ms) }
        async function poll() {
          if (!live || inFlight) return
          // 页面在后台时不打扰：任务状态本来就要等回来再看。
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { schedule(8000); return }
          inFlight = true
          controller = new AbortController()
          // 下一轮间隔跟着这次拿到的状态走：有任务在跑就 2.5 秒一问，闲下来就放慢。
          let nextDelay = activeRef.current ? 2500 : 5000
          try {
            const data = await request({ action: 'jobs', gameId: sessionId }, controller.signal)
            if (!live) return
            const list = Array.isArray(data?.jobs) ? data.jobs : []
            setJobs(list)
            nextDelay = list.some(job => job && DOCK_ACTIVE.has(job.status)) ? 2500 : 5000
          } catch (error) {
            // 读不到任务状态就保持上一次显示；停靠区不该把网络噪声塞进玩家界面。
          } finally {
            inFlight = false
            if (live) schedule(nextDelay)
          }
        }
        poll()
        return () => {
          live = false
          if (timer) clearTimeout(timer)
          if (controller) controller.abort()
        }
      }, [sessionId])

      const summary = dockSummary(jobs)
      useEffect(() => { activeRef.current = summary.active > 0 }, [summary.active])
      // 从「有任务在跑」变成「全跑完」时亮一小会儿结果，之后自己收起来。
      useEffect(() => {
        if (summary.active > 0) {
          seenActive.current = true
          setFlash(null)
          return undefined
        }
        if (!seenActive.current) return undefined
        seenActive.current = false
        setFlash({ ready: summary.ready, failed: summary.failed })
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(null), DOCK_FLASH_MS)
        return undefined
      }, [summary.active, summary.ready, summary.failed])
      useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

      if (!summary.active && !flash) return null
      const failed = flash ? flash.failed : 0
      const ready = flash ? flash.ready : summary.ready
      // 任务被删掉或没有近期结果时，不亮一个空的结果条。
      if (!summary.active && !failed && !ready) return null
      let title, detail = ''
      if (summary.active) {
        title = '生成中 ' + summary.active + ' 段' + (ready ? ' · 已就绪 ' + ready + ' 段' : '')
        detail = summary.stages.join(' · ')
      } else if (failed) {
        title = failed + ' 段生成失败'
        detail = '可到 RunningHub 面板查看'
      } else {
        title = ready + ' 段视频已就绪'
        detail = '可到 RunningHub 面板查看'
      }
      return h('div', { className: 'rh-dock', 'data-state': summary.active ? 'active' : failed ? 'failed' : 'done',
        role: 'status', 'aria-live': 'polite', 'aria-label': 'RunningHub 生成状态' },
      h('style', null, dockCSS),
      h('span', { className: 'rh-dock-dot', 'aria-hidden': true }),
      h('div', { className: 'rh-dock-copy' },
        h('div', { className: 'rh-dock-title' }, h('b', null, 'RunningHub'), ' · ', title),
        detail ? h('div', { className: 'rh-dock-detail' }, detail) : null),
      summary.active ? h('span', { className: 'rh-dock-bar', 'aria-hidden': true }, h('span', null)) : null)
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

    const LIBRARY_LABEL = { image: '常用图库', audio: '常用音频库' }
    function libraryFileURL(kind, id) {
      return LIBRARY + '?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(id)
    }
    function libraryName(name, fallback) {
      const value = typeof name === 'string' ? name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim() : ''
      return (value || fallback || '素材').slice(0, 120)
    }

    /**
     * 客户端素材库选择器。列表只读，选中时由宿主代理取回原文件，再走与本地文件完全相同的
     * 参考素材校验/上传路径——图库里的图不会因为“从图库选”而绕过 10MB 或 MIME 限制。
     */
    function LibraryPicker({ kind, slotLabel, onPick, onClose }) {
      const dialogRef = useRef(null)
      const closeRef = useRef(null)
      const abortRef = useRef(null)
      const aliveRef = useRef(true)
      const [items, setItems] = useState([])
      const [maxBytes, setMaxBytes] = useState(10 * MB)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [busyId, setBusyId] = useState('')
      const [reload, setReload] = useState(0)
      const label = LIBRARY_LABEL[kind] || '素材库'

      useEffect(() => {
        const dialog = dialogRef.current
        const previous = document.activeElement
        if (dialog) {
          if (typeof dialog.showModal === 'function') {
            try { if (!dialog.open) dialog.showModal() } catch { dialog.setAttribute('open', '') }
          } else dialog.setAttribute('open', '')
          if (!dialog.open) dialog.setAttribute('open', '')
        }
        closeRef.current?.focus?.()
        return () => {
          aliveRef.current = false
          abortRef.current?.abort?.()
          if (dialog) {
            try {
              if (typeof dialog.close === 'function' && dialog.open) dialog.close()
              else dialog.removeAttribute('open')
            } catch { dialog.removeAttribute('open') }
            if (dialog.open) dialog.removeAttribute('open')
          }
          if (previous && previous.isConnected !== false) previous.focus?.()
        }
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        let active = true
        setLoading(true)
        setError('')
        fetch(LIBRARY + '?kind=' + encodeURIComponent(kind), {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        }).then(async response => {
          let data = null
          try { data = await response.json() } catch { data = null }
          if (!response.ok) throw new Error(data?.error ? message(data.error) : 'HTTP ' + response.status + '：读取素材库失败')
          if (!Array.isArray(data?.items)) throw new Error('素材库列表格式无效')
          if (!active) return
          const limit = Number(data.maxBytes)
          setMaxBytes(Number.isFinite(limit) && limit > 0 ? limit : 10 * MB)
          setItems(data.items.filter(item => item && typeof item.id === 'string'))
        }).catch(failure => {
          if (active && failure.name !== 'AbortError') setError(message(failure))
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false; controller.abort() }
      }, [kind, reload])

      async function choose(item) {
        if (busyId) return
        if (Number.isFinite(item.size) && item.size > maxBytes) {
          setError('「' + item.name + '」' + formatBytes(item.size) + '，超过单文件 ' + formatBytes(maxBytes) + ' 上限；请先在客户端换一张/一段。')
          return
        }
        const controller = new AbortController()
        abortRef.current = controller
        setBusyId(item.id)
        setError('')
        try {
          const response = await fetch(libraryFileURL(kind, item.id), { credentials: 'same-origin', signal: controller.signal })
          if (!response.ok) {
            let detail = ''
            try { const data = await response.json(); detail = data?.error ? message(data.error) : '' } catch { detail = '' }
            throw new Error('读取「' + item.name + '」失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''))
          }
          const blob = await response.blob()
          if (!blob.size) throw new Error('「' + item.name + '」内容为空。')
          if (blob.size > maxBytes) throw new Error('「' + item.name + '」' + formatBytes(blob.size) + '，超过单文件 ' + formatBytes(maxBytes) + ' 上限。')
          const mimeType = (blob.type || item.mimeType || '').split(';')[0].trim().toLowerCase()
          if (!mimeType.startsWith(kind + '/')) throw new Error('「' + item.name + '」类型与槽位不匹配。')
          const file = new File([blob], libraryName(item.name, 'library-' + item.id), { type: mimeType, lastModified: Date.now() })
          const failure = await onPick(file)
          if (failure) { setError(failure); return }
          onClose()
        } catch (failure) {
          if (failure.name !== 'AbortError' && aliveRef.current) setError(message(failure))
        } finally {
          abortRef.current = null
          if (aliveRef.current) setBusyId('')
        }
      }

      const sizeText = formatBytes(maxBytes) || '10 MB'
      let body
      if (loading) {
        body = h('div', { className: 'rh-library-skeleton' },
          h('div', { className: 'rh-skeleton' }), h('div', { className: 'rh-skeleton' }), h('div', { className: 'rh-skeleton' }))
      } else if (!items.length) {
        body = error ? null : h('div', { className: 'rh-library-empty' },
          icon(kind === 'audio' ? 'audio' : 'image', 24),
          h('strong', null, label + '还是空的'),
          h('span', null, '先在 6888 单镜生成页把' + (kind === 'audio' ? '音频' : '图片') + '存进' + label + '，再回来挑。'))
      } else if (kind === 'image') {
        body = h('div', { className: 'rh-library-grid' }, items.map(item => {
          const tooBig = Number.isFinite(item.size) && item.size > maxBytes
          const busy = busyId === item.id
          return h('button', { key: item.id, type: 'button', className: 'rh-library-item', disabled: tooBig || Boolean(busyId),
            title: tooBig ? '超过单文件 ' + sizeText + ' 上限' : item.name, onClick: () => choose(item) },
          h('span', { className: 'rh-library-thumb' }, icon('image', 18),
            tooBig ? null : h('img', { src: libraryFileURL(kind, item.id), alt: item.name, loading: 'lazy',
              onError: event => { event.currentTarget.style.display = 'none' } })),
          h('span', { className: 'rh-library-name' }, item.name),
          h('span', { className: 'rh-library-size' }, busy ? '读取中…'
            : tooBig ? '超过 ' + sizeText : item.size ? formatBytes(item.size) : '未知大小'))
        }))
      } else {
        body = h('div', { className: 'rh-library-list' }, items.map(item => {
          const tooBig = Number.isFinite(item.size) && item.size > maxBytes
          const busy = busyId === item.id
          return h('button', { key: item.id, type: 'button', className: 'rh-library-row', disabled: tooBig || Boolean(busyId),
            title: tooBig ? '超过单文件 ' + sizeText + ' 上限' : item.name, onClick: () => choose(item) },
          h('span', { className: 'rh-library-row-icon' }, icon('audio', 16)),
          h('span', { className: 'rh-library-row-copy' }, h('strong', null, item.name),
            h('small', null, busy ? '读取中…' : tooBig ? '超过 ' + sizeText + ' 上限'
              : item.size ? formatBytes(item.size) : '未知大小')),
          h('span', { className: 'rh-library-row-action' }, busy ? '…' : tooBig ? '不可用' : '使用'))
        }))
      }

      return h('dialog', {
        ref: dialogRef, className: 'rh-library-dialog', 'aria-modal': 'true', 'aria-labelledby': 'rh-library-title',
        onCancel: event => { event.preventDefault(); onClose() },
        onClick: event => { if (event.target === event.currentTarget) onClose() },
      },
      h('section', { className: 'rh-library' },
        h('header', { className: 'rh-library-head' },
          h('div', { className: 'rh-library-head-copy' },
            h('div', { className: 'rh-library-kicker' }, kind === 'audio' ? 'AUDIO LIBRARY' : 'CLIENT GALLERY'),
            h('h2', { id: 'rh-library-title', className: 'rh-library-title' }, '从' + label + '选'),
            h('p', { className: 'rh-library-sub' }, '选中后放进「' + slotLabel + '」；素材由宿主从客户端库取回，再按普通参考素材保存。')),
          h('button', { ref: closeRef, type: 'button', className: 'rh-library-close', 'aria-label': '关闭素材库', onClick: onClose },
            icon('close', 14))),
        h('div', { className: 'rh-library-toolbar' },
          h('span', { className: 'rh-note' }, loading ? '正在读取…'
            : items.length ? '共 ' + items.length + ' 项 · 单文件 ≤ ' + sizeText : '没有可用素材'),
          h('div', { className: 'rh-row' },
            h('button', { type: 'button', className: 'rh-btn rh-btn-quiet', disabled: loading,
              onClick: () => setReload(value => value + 1) }, icon('refresh', 12), '刷新'),
            h('button', { type: 'button', className: 'rh-btn rh-btn-quiet', onClick: onClose }, '关闭'))),
        h('div', { className: 'rh-library-body' },
          error ? h('div', { role: 'alert', className: 'rh-error' }, error) : null,
          body)))
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
      const libraryPickerRef = useRef(null)
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
      const selectionBusy = useRef(false)
      const [draftContext, setDraftContext] = useState('')
      const [workflow, setWorkflow] = useState(null)
      const [workflowBusy, setWorkflowBusy] = useState(false)
      const [workflowError, setWorkflowError] = useState('')
      const [prompt, setPrompt] = useState('')
      const [duration, setDuration] = useState('')
      const [ratio, setRatio] = useState('')
      const [megapixels, setMegapixels] = useState('')
      const [width, setWidth] = useState('')
      const [height, setHeight] = useState('')
      const [custom, setCustom] = useState({})
      const [references, setReferences] = useState({})
      const [referenceErrors, setReferenceErrors] = useState({})
      const [libraryPicker, setLibraryPicker] = useState(null)
      libraryPickerRef.current = libraryPicker
      const [bindToTurn, setBindToTurn] = useState(true)
      const [generationMode, setGenerationMode] = useState('tool')
      const [alwaysSendPrompt, setAlwaysSendPrompt] = useState(true)
      const [videosPerTurn, setVideosPerTurn] = useState(3)
      const [videosPerTurnDraft, setVideosPerTurnDraft] = useState('3')
      const [settingsBusy, setSettingsBusy] = useState(false)
      const [settingsStatus, setSettingsStatus] = useState('idle')
      const [settingsDirty, setSettingsDirty] = useState(false)
      const [settingsError, setSettingsError] = useState('')
      const [settingsNotice, setSettingsNotice] = useState('')
      const [preferenceBusy, setPreferenceBusy] = useState(false)
      const [preferenceError, setPreferenceError] = useState('')
      const [pregenDraft, setPregenDraft] = useState({ count: 0, perTurn: 0, maxAge: 6, review: true })
      const [pregenBusy, setPregenBusy] = useState({})
      const [pregenRefillBusy, setPregenRefillBusy] = useState(false)
      const [pregenError, setPregenError] = useState('')
      const [pregenNotice, setPregenNotice] = useState('')
      const pregenDraftDirty = useRef(false)
      const [seedDraft, setSeedDraft] = useState({})
      const [modelDraft, setModelDraft] = useState({})
      const [optionGroups, setOptionGroups] = useState([])
      const [optionGroupsError, setOptionGroupsError] = useState('')
      const [slotModes, setSlotModes] = useState({})
      const [clearedDefaults, setClearedDefaults] = useState({})
      const settingsParts = useRef(new Set())
      const settingsDirtyRef = useRef(false)
      const settingsLock = useRef(false)
      const settingsVersion = useRef(0)
      const modelRef = useRef(model)
      modelRef.current = model
      const autoSaveTimer = useRef(null)
      const autoSavePaused = useRef(false)
      const autoSaveConflict = useRef(false)
      const saveSettingsRef = useRef(null)
      // 主面板里的提示词类自定义参数只对本次生成生效，不能被“自动保存成功”清掉。
      const perShotCustomKeys = useRef(new Set())
      // 主面板上传的参考素材同样只覆盖本次生成，不能混进设置同步的 defaults.references。
      const perShotReferenceSlots = useRef(new Set())
      const prefsLoaded = useRef(false)
      const optionGroupsContext = useRef('')
      const [submitBusy, setSubmitBusy] = useState(false)
      const [submitError, setSubmitError] = useState('')
      const [submitNotice, setSubmitNotice] = useState('')
      const [pending, setPending] = useState(() => pendingRequests.get(contextKey) || null)
      const [retrying, setRetrying] = useState({})
      const [downloadErrors, setDownloadErrors] = useState({})
      const [regenerating, setRegenerating] = useState({})
      const [regenerateErrors, setRegenerateErrors] = useState({})
      const [regenerateNotice, setRegenerateNotice] = useState('')
      const [videoNotices, setVideoNotices] = useState([])
      const [player, setPlayer] = useState(null)
      const [playerMedia, setPlayerMedia] = useState({})
      const playerDialogRef = useRef(null)
      const playerCloseRef = useRef(null)
      const seenJobs = useRef(null)
      const toastedJobs = useRef(new Set())
      const alive = useRef(false)
      const controllers = useRef(new Set())
      const configLock = useRef(false)
      const submitLock = useRef(false)
      const downloadLocks = useRef(new Set())
      const regenerateLocks = useRef(new Set())
      const baseInitialized = useRef(false)
      const baseDirty = useRef(false)
      const pendingRef = useRef(pending)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
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
          if (event.key === 'Escape') {
            // 素材库是叠在设置抽屉上的 <dialog>：Escape 只关它，别把底下的抽屉一起关掉。
            if (libraryPickerRef.current) return
            setSettingsOpen(false); return
          }
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
        // 提交结果确认完，继续把之前没写完的设置同步掉。
        if (!value && settingsDirtyRef.current) scheduleAutoSave(0)
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
            const data = await request(null, current.signal, gameId)
            if (!active || !alive.current) return
            if (!data || !Array.isArray(data.jobs) || !Array.isArray(data.workflows)) {
              throw new Error('宿主状态格式无效：缺少 jobs 或 workflows')
            }
            setSummary({ configured: data.configured, baseURL: data.baseURL,
              generationMode: data.generationMode === 'marker' ? 'marker' : 'tool',
              autoInsert: data.autoInsert === true, alwaysSendPrompt: data.alwaysSendPrompt !== false,
              videosPerTurn: Number.isInteger(data.videosPerTurn) ? data.videosPerTurn : 3,
              applyDefaults: data.applyDefaults !== false,
              bindToTurn: data.bindToTurn !== false, workflowSettings: data.workflowSettings === true,
              adapter: data.adapter, model: data.model, defaultModel: data.defaultModel || '',
              templateMode: data.templateMode || '', templateError: data.templateError || '',
              jobs: data.jobs, workflows: data.workflows,
              pregen: data.pregen || null,
              markerError: data.markerError || '', markerWarning: data.markerWarning || '',
              markerRegexError: data.markerRegexError || '',
              gatewayError: data.gatewayError || '', settingsError: data.settingsError || '' })
            if (!prefsLoaded.current) {
              prefsLoaded.current = true
              setBindToTurn(data.bindToTurn !== false)
              setGenerationMode(data.generationMode === 'marker' ? 'marker' : 'tool')
              setAlwaysSendPrompt(data.alwaysSendPrompt !== false)
              const videos = Number.isInteger(data.videosPerTurn) ? data.videosPerTurn : 3
              setVideosPerTurn(videos)
              setVideosPerTurnDraft(String(videos))
            }
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

      const jobsKey = (summary?.jobs || []).map(job => (job?.id || '') + ':' + (job?.status || '')).join('|')
      useEffect(() => {
        const jobs = summary?.jobs
        if (!Array.isArray(jobs) || visible === false) return
        if (seenJobs.current === null) {
          seenJobs.current = new Map(jobs.map(job => [job.id, job.status]))
          return
        }
        const previous = seenJobs.current
        const completed = []
        for (const job of jobs) {
          if (!job || typeof job.id !== 'string') continue
          const before = previous.get(job.id)
          previous.set(job.id, job.status)
          if (job.status !== 'ready' || before === 'ready') continue
          if (toastedJobs.current.has(job.id)) continue
          const item = videoAttachmentOf(job)
          if (!item) continue
          toastedJobs.current.add(job.id)
          completed.push({ id: job.id, job, item })
        }
        if (completed.length) setVideoNotices(current => [...completed, ...current].slice(0, 3))
      }, [jobsKey, visible])

      useEffect(() => {
        if (!player) return
        const dialog = playerDialogRef.current
        const previous = document.activeElement
        if (dialog) {
          if (typeof dialog.showModal === 'function') {
            try { if (!dialog.open) dialog.showModal() } catch { dialog.setAttribute('open', '') }
          } else dialog.setAttribute('open', '')
          if (!dialog.open) dialog.setAttribute('open', '')
        }
        playerCloseRef.current?.focus?.()
        return () => {
          if (dialog) {
            try {
              if (typeof dialog.close === 'function' && dialog.open) dialog.close()
              else dialog.removeAttribute('open')
            } catch { dialog.removeAttribute('open') }
            if (dialog.open) dialog.removeAttribute('open')
          }
          if (previous && previous !== document.body && previous.isConnected !== false) previous.focus?.()
        }
      }, [player])

      const workflowListVersion = JSON.stringify((summary?.workflows || []).map(item => [item.alias, item.revision || item]))
      const pregenSettingsKey = summary?.pregen ? JSON.stringify(summary.pregen.settings) : ''
      useEffect(() => {
        if (!summary?.pregen || pregenDraftDirty.current) return
        setPregenDraft({ ...summary.pregen.settings })
      }, [pregenSettingsKey])
      const syncContext = model + ':' + configVersion
      useEffect(() => {
        if (!summary?.configured || lockedForSync()) return
        const available = (summary.workflows || []).filter(item => !item.broken)
        const preferred = available.some(item => item.alias === summary.model) ? summary.model : available[0]?.alias || ''
        // 面板选择会写回宿主；selectionBusy 期间不要被轮询回来的旧值盖掉。
        if (!selectionBusy.current && preferred && model !== preferred) setModel(preferred)
      }, [workflowListVersion, summary?.model, summary?.configured, configBusy, submitBusy, pending])
      function lockedForSync() { return configBusy || submitBusy || Boolean(pendingRef.current) }

      function markSettings(part) {
        settingsParts.current.add(part)
        settingsVersion.current += 1
        settingsDirtyRef.current = true
        setSettingsDirty(true)
        setSettingsStatus('dirty')
        setSettingsError('')
        setSettingsNotice('')
        autoSavePaused.current = false
        scheduleAutoSave()
      }

      // 改动后短暂合并再写网关：输入框连续敲字只落一次，离散控件也感觉是“立刻保存”。
      function scheduleAutoSave(delay = 500) {
        if (autoSavePaused.current || autoSaveConflict.current) return
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = setTimeout(() => {
          autoSaveTimer.current = null
          if (!alive.current) return
          if (settingsLock.current || submitLock.current) { scheduleAutoSave(250); return }
          // 待核对的提交期间不写设置；等用户处理完 pending 再续。
          if (pendingRef.current) { setSettingsStatus('dirty'); return }
          void saveSettingsRef.current?.({ auto: true })
        }, delay)
      }

      function reloadSettings() {
        const discard = settingsDirtyRef.current || autoSaveConflict.current
        if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
        settingsParts.current.clear()
        settingsVersion.current += 1
        settingsDirtyRef.current = false
        autoSavePaused.current = false
        autoSaveConflict.current = false
        setSettingsDirty(false)
        setSettingsStatus('idle')
        setSettingsError('')
        setSettingsNotice('')
        if (discard) {
          perShotCustomKeys.current.clear()
          perShotReferenceSlots.current.clear()
          setCustom({})
          setReferences({})
          setReferenceErrors({})
          setDuration('')
          setRatio('')
          setMegapixels('')
          setWidth(''); setHeight('')
          setSeedDraft({})
          setModelDraft({})
          setSlotModes({})
          setClearedDefaults({})
        }
        setRefreshVersion(value => value + 1)
      }

      function adoptWorkflowSettings(data) {
        if (!data) return
        const seeds = {}
        for (const seed of data.seedTargets || []) seeds[seed.target] = seed.pinnedValue !== undefined ? String(seed.pinnedValue) : ''
        setSeedDraft(seeds)
        const models = {}
        for (const field of data.modelFields || []) models[field.target] = { value: field.value ?? '', groupId: field.groupId ?? '' }
        setModelDraft(models)
        const modes = {}
        for (const slot of data.referenceSlots || []) modes[slot.nodeId] = !slot.bypassed
        setSlotModes(modes)
        setClearedDefaults({})
        settingsParts.current.clear()
        settingsDirtyRef.current = false
        setSettingsDirty(false)
        setSettingsError('')
      }

      async function loadOptionGroups() {
        if (!summary?.configured || summary?.workflowSettings !== true) return
        const current = controller()
        try {
          const data = await request({ action: 'option-groups' }, current.signal)
          if (!alive.current) return
          setOptionGroups(Array.isArray(data?.groups) ? data.groups : [])
          setOptionGroupsError('')
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setOptionGroupsError(message(error))
        } finally {
          controllers.current.delete(current)
        }
      }

      async function savePreference(patch) {
        setPreferenceBusy(true)
        setPreferenceError('')
        const current = controller()
        try {
          const data = await request({ action: 'preferences', ...patch }, current.signal)
          if (!alive.current) return data
          setSummary(previous => ({ ...(previous || {}),
            ...(data?.generationMode === 'marker' || data?.generationMode === 'tool' ? { generationMode: data.generationMode } : {}),
            ...(typeof data?.autoInsert === 'boolean' ? { autoInsert: data.autoInsert } : {}),
            ...(typeof data?.alwaysSendPrompt === 'boolean' ? { alwaysSendPrompt: data.alwaysSendPrompt } : {}),
            ...(Number.isInteger(data?.videosPerTurn) ? { videosPerTurn: data.videosPerTurn } : {}),
            ...(typeof data?.bindToTurn === 'boolean' ? { bindToTurn: data.bindToTurn } : {}),
            markerRegexError: data?.markerRegexError || '' }))
          return data
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setPreferenceError(message(error))
          throw error
        } finally {
          controllers.current.delete(current)
          if (alive.current) setPreferenceBusy(false)
        }
      }

      async function changePreference(key, value) {
        const previous = bindToTurn
        setBindToTurn(value)
        try { await savePreference({ [key]: value }) }
        catch {
          if (alive.current) setBindToTurn(previous)
        }
      }

      async function changeAlwaysSendPrompt(value) {
        const previous = alwaysSendPrompt
        setAlwaysSendPrompt(value)
        try { await savePreference({ alwaysSendPrompt: value }) }
        catch {
          if (alive.current) setAlwaysSendPrompt(previous)
        }
      }

      async function changeGenerationMode(value) {
        const previous = generationMode
        setGenerationMode(value)
        setPreferenceError('')
        try { await savePreference({ generationMode: value }) }
        catch {
          if (alive.current) setGenerationMode(previous)
        }
      }

      function commitVideosPerTurn() {
        setPreferenceError('')
        const value = Number(videosPerTurnDraft)
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          setPreferenceError('每回合视频段数必须是 1–10 的整数')
          setVideosPerTurnDraft(String(videosPerTurn))
          return
        }
        if (value === videosPerTurn) return
        const previous = videosPerTurn
        setVideosPerTurn(value)
        setVideosPerTurnDraft(String(value))
        savePreference({ videosPerTurn: value }).catch(() => {
          if (!alive.current) return
          setVideosPerTurn(previous)
          setVideosPerTurnDraft(String(previous))
        })
      }

      function settingsResolution() {
        const resolution = {}
        if (resolutionFields.has('aspect_ratio') && ratio.trim()) resolution.aspect_ratio = ratio.trim()
        if (resolutionFields.has('megapixels') && megapixels.trim()) resolution.megapixels = Number(megapixels)
        if (dimensionsSupported && !resolutionFields.has('aspect_ratio') && (width.trim() || height.trim())) {
          if (!width.trim() || !height.trim()) throw new Error('宽度和高度必须成对填写。')
          resolution.width = Number(width)
          resolution.height = Number(height)
        }
        return Object.keys(resolution).length ? resolution : null
      }

      function settingsCustom(defaults) {
        const values = { ...(defaults || {}) }
        for (const field of workflow?.customFields || []) {
          // 主面板里的提示词类参数只属于本次生成，不写进客户端默认值。
          if (perShotCustomKeys.current.has(field.key)) continue
          if (!own(custom, field.key)) continue
          const value = custom[field.key]
          if (value === '' || value === null || value === undefined) delete values[field.key]
          else values[field.key] = value
        }
        return Object.keys(values).length ? values : null
      }

      function settingsSeeds() {
        const changes = []
        for (const target of workflow?.seedTargets || []) {
          if (target.managedByCustomField) continue
          const raw = seedDraft[target.target] === undefined ? '' : String(seedDraft[target.target]).trim()
          const previous = target.pinnedValue !== undefined ? String(target.pinnedValue) : ''
          if (raw === previous) continue
          if (!raw) { changes.push({ target: target.target, value: null }); continue }
          const value = Number(raw)
          if (!Number.isSafeInteger(value) || value < 0) throw new Error('种子必须是非负整数。')
          changes.push({ target: target.target, value })
        }
        return changes
      }

      function settingsModelFields() {
        const changes = []
        for (const field of workflow?.modelFields || []) {
          const draft = modelDraft[field.target] || { value: field.value ?? '', groupId: field.groupId ?? '' }
          const patch = {}
          if ((draft.groupId || '') !== (field.groupId || '')) patch.groupId = draft.groupId || null
          if ((draft.value ?? '') !== (field.value ?? '')) patch.value = draft.value ?? ''
          if (Object.keys(patch).length) changes.push({ target: field.target, ...patch })
        }
        return changes
      }

      function settingsSlots() {
        const changes = []
        for (const slot of workflow?.referenceSlots || []) {
          const enabled = slotModes[slot.nodeId] !== false
          if (enabled !== !slot.bypassed) changes.push({ nodeId: slot.nodeId, enabled })
        }
        return changes
      }

      async function settingsReferences(signal) {
        const defaults = workflow?.defaults || {}
        const current = new Map((defaults.references || []).map(asset => [asset.nodeId, asset]))
        const items = []
        // 管线工作流的素材属于子工作流，插件只沿用客户端的整组值，不在设置里改。
        if (workflow?.pipeline) {
          for (const asset of defaults.references || []) {
            items.push({ nodeId: asset.nodeId, kind: asset.kind, ...(asset.note ? { note: asset.note } : {}) })
          }
          return items
        }
        for (const slot of workflow?.referenceSlots || []) {
          if (slotModes[slot.nodeId] === false || clearedDefaults[slot.nodeId]) continue
          const asset = current.get(slot.nodeId)
          // 主面板的素材/备注是本次生成用的，设置同步只用客户端已保存的那份。
          const perShot = perShotReferenceSlots.current.has(String(slot.nodeId))
          const entry = perShot ? {} : references[slot.nodeId] || {}
          const note = String(own(entry, 'note') ? entry.note : asset?.note || '').trim()
          if (entry.file) {
            items.push({ nodeId: slot.nodeId, kind: slot.kind, name: entry.file.name, mimeType: entry.file.type,
              data: await readBase64(entry.file, signal), ...(note ? { note } : {}) })
          } else if (asset) {
            items.push({ nodeId: slot.nodeId, kind: slot.kind, ...(note ? { note } : {}) })
          }
        }
        return items
      }

      async function settingsDefaults(parts, signal) {
        const defaults = workflow?.defaults || {}
        const payload = {
          presetIds: defaults.presetIds || [],
          promptSuffix: defaults.promptSuffix || '',
          resolution: parts.has('resolution') ? settingsResolution() : defaults.resolution ?? null,
          custom: parts.has('custom') ? settingsCustom(defaults.custom) : defaults.custom ?? null,
          ...(defaults.updatedAt ? { baseUpdatedAt: defaults.updatedAt } : {}),
        }
        // 管线工作流的参考素材属于子工作流：整段省略 references/referencePools，
        // 服务端会保留原来的那组，而不是被插件清空。
        if (!workflow?.pipeline) {
          payload.references = await settingsReferences(signal)
          payload.referencePools = defaults.referencePools || []
        }
        return payload
      }

      async function saveSettings(options = {}) {
        if (settingsLock.current || !workflow || !settingsDirtyRef.current) return
        if (submitLock.current || pendingRef.current) {
          if (options.auto) scheduleAutoSave(300)
          return
        }
        if (summary?.workflowSettings !== true) {
          autoSavePaused.current = true
          setSettingsStatus('error')
          setSettingsError('宿主侧还是旧版本：请重启 DSH 后再保存设置。')
          return
        }
        settingsLock.current = true
        setSettingsBusy(true)
        setSettingsStatus('saving')
        setSettingsError('')
        setSettingsNotice('')
        const targetModel = model
        const current = controller()
        const version = settingsVersion.current
        try {
          const parts = new Set(settingsParts.current)
          const body = { action: 'save-settings', model }
          if (['resolution', 'custom', 'references', 'slots'].some(part => parts.has(part))) body.defaults = await settingsDefaults(parts, current.signal)
          if (parts.has('duration')) body.duration = { seconds: duration.trim() === '' ? null : Number(duration) }
          if (parts.has('seeds')) {
            const seeds = settingsSeeds()
            if (seeds.length) body.seeds = seeds
          }
          if (parts.has('modelFields')) {
            const fields = settingsModelFields()
            if (fields.length) body.modelFields = fields
          }
          if (parts.has('slots')) {
            const slots = settingsSlots()
            if (slots.length) body.referenceSlots = slots
          }
          if (!['defaults', 'duration', 'seeds', 'modelFields', 'referenceSlots'].some(key => body[key] !== undefined)) {
            if (settingsVersion.current === version) {
              settingsParts.current.clear()
              settingsDirtyRef.current = false
              setSettingsDirty(false)
              setSettingsStatus('saved')
              setSettingsNotice('已与客户端同步')
            } else scheduleAutoSave(150)
            return
          }
          const data = await request(body, current.signal)
          if (!alive.current || modelRef.current !== targetModel) return
          autoSavePaused.current = false
          autoSaveConflict.current = false
          const changedDuringSave = settingsVersion.current !== version
          if (!changedDuringSave) {
            settingsParts.current.clear()
            settingsDirtyRef.current = false
            setSettingsDirty(false)
            setSettingsStatus('saved')
            setSettingsNotice('已自动写入客户端；6888 管理页与端口调用使用同一份。')
            // 已保存成默认素材的本地文件清掉预览；主面板本次生成用的素材保留。
            setReferences(previous => {
              const next = {}
              for (const [nodeId, entry] of Object.entries(previous)) {
                next[nodeId] = perShotReferenceSlots.current.has(nodeId) ? { ...entry } : { ...entry, file: null }
              }
              return next
            })
            setReferenceErrors({})
          } else {
            setSettingsStatus('dirty')
            setSettingsNotice('')
          }
          if (data?.workflow && data.workflow.alias === model) {
            setWorkflow({ ...data.workflow, syncContext })
            setSummary(previous => previous ? { ...previous,
              workflows: (previous.workflows || []).map(item => item.alias === data.workflow.alias ? data.workflow : item) } : previous)
            if (!changedDuringSave) adoptWorkflowSettings(data.workflow)
          } else if (!changedDuringSave) setRefreshVersion(value => value + 1)
          if (!changedDuringSave) {
            // 已写进客户端，本地不再保留设置类覆盖；输入框回到“占位符＝客户端当前值”。
            setCustom(previous => {
              const next = {}
              for (const [key, value] of Object.entries(previous)) if (perShotCustomKeys.current.has(key)) next[key] = value
              return next
            })
            setDuration(''); setRatio(''); setMegapixels(''); setWidth(''); setHeight('')
          }
          if (changedDuringSave) scheduleAutoSave(150)
        } catch (error) {
          if (error.name === 'AbortError') return
          if (alive.current && modelRef.current === targetModel) {
            const conflict = /别处更新|409/.test(message(error))
            if (conflict) autoSaveConflict.current = true
            else autoSavePaused.current = true
            setSettingsStatus(conflict ? 'conflict' : 'error')
            setSettingsError(message(error))
          }
        } finally {
          controllers.current.delete(current)
          settingsLock.current = false
          if (alive.current) setSettingsBusy(false)
        }
      }
      saveSettingsRef.current = saveSettings

      function retrySave() {
        autoSavePaused.current = false
        autoSaveConflict.current = false
        setSettingsError('')
        setSettingsStatus('dirty')
        void saveSettingsRef.current?.({ auto: false })
      }

      useEffect(() => {
        if (draftContext === syncContext) return
        setDraftContext(syncContext)
        setCustom({}); setReferences({}); setReferenceErrors({})
        setDuration(''); setRatio(''); setMegapixels(''); setWidth(''); setHeight('')
        setSubmitError(''); setSubmitNotice('')
        if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
        settingsParts.current.clear()
        settingsVersion.current += 1
        perShotCustomKeys.current.clear()
        perShotReferenceSlots.current.clear()
        autoSavePaused.current = false
        autoSaveConflict.current = false
        settingsDirtyRef.current = false
        setSettingsDirty(false)
        setSettingsStatus('idle')
        setSettingsError('')
        setSettingsNotice('')
      }, [syncContext])
      useEffect(() => {
        if (!summary?.configured || !model || visible === false || selectionBusy.current) return
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
          // 有未保存改动时轮询只刷新展示数据，不把用户正在改的值冲掉。
          if (!settingsDirtyRef.current || data.alias !== workflow?.alias) adoptWorkflowSettings(data)
        }).catch(error => {
          if (active && alive.current && error.name !== 'AbortError') setWorkflowError(message(error))
        }).finally(() => {
          controllers.current.delete(current)
          if (active && alive.current) setWorkflowBusy(false)
        })
        return () => { active = false; current.abort(); controllers.current.delete(current) }
      }, [model, summary?.workflows, summary?.configured, configVersion, visible, refreshVersion])

      useEffect(() => {
        if (!settingsOpen || !workflow || !(workflow.modelFields || []).length) return
        if (summary?.workflowSettings !== true) return
        const context = workflow.alias + ':' + (workflow.revision || '')
        if (optionGroupsContext.current === context) return
        optionGroupsContext.current = context
        void loadOptionGroups()
      }, [settingsOpen, workflow?.alias, workflow?.revision])

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

      async function savePregenSettings(patch) {
        if (!gameId) { setPregenError('打开一局游戏后再配置预生成'); return }
        const current = controller()
        setPregenError('')
        setPregenNotice('')
        try {
          const data = await request({ action: 'pregen-settings', gameId, ...patch }, current.signal)
          if (!alive.current) return
          if (data?.pregen) setSummary(previous => ({ ...(previous || {}), pregen: data.pregen }))
          pregenDraftDirty.current = false
          if (data?.pregen?.settings) setPregenDraft({ ...data.pregen.settings })
          setPregenNotice('预生成设置已保存')
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setPregenError(message(error))
        } finally {
          controllers.current.delete(current)
        }
      }

      async function pregenAction(action, id) {
        if (!gameId) { setPregenError('打开一局游戏后再使用预生成'); return }
        const current = controller()
        if (id) setPregenBusy(previous => ({ ...previous, [id]: action }))
        else setPregenRefillBusy(true)
        setPregenError('')
        setPregenNotice('')
        try {
          const body = { action: action === 'refill' ? 'pregen-refill' : action === 'send' ? 'pregen-send' : 'pregen-delete', gameId }
          if (id) body.id = id
          const data = await request(body, current.signal)
          if (!alive.current) return
          if (data?.pregen) setSummary(previous => ({ ...(previous || {}), pregen: data.pregen }))
          if (action === 'refill') setPregenNotice(data?.cooldown ? '上次失败后冷却中，稍后再试。' : '已开始后台补池。')
          else if (action === 'delete') setPregenNotice('已从池子里移除。')
          else if (action === 'send') setPregenNotice(data?.queued ? '已排入本轮：正文写完、版本确定后补入。' : '视频已补到当前正文。')
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') setPregenError(message(error))
        } finally {
          controllers.current.delete(current)
          if (id) setPregenBusy(previous => { const next = { ...previous }; delete next[id]; return next })
          else setPregenRefillBusy(false)
        }
      }

      async function selectModel(value) {
        if (!value || value === model || selectionBusy.current || settingsLock.current) return
        selectionBusy.current = true
        const previous = model
        const current = controller()
        setModel(value)
        setWorkflow(null)
        setWorkflowBusy(true)
        setCustom({})
        setReferences({})
        setReferenceErrors({})
        setDuration('')
        setRatio('')
        setMegapixels('')
        setWidth(''); setHeight('')
        setSubmitError('')
        setSubmitNotice('')
        if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null }
        settingsParts.current.clear()
        settingsVersion.current += 1
        perShotCustomKeys.current.clear()
        perShotReferenceSlots.current.clear()
        autoSavePaused.current = false
        autoSaveConflict.current = false
        settingsDirtyRef.current = false
        setSettingsDirty(false)
        setSettingsStatus('idle')
        setSettingsError('')
        setSettingsNotice('')
        setClearedDefaults({})
        try {
          const data = await request({ action: 'select-model', model: value }, current.signal)
          if (!alive.current) return
          setSummary(previousSummary => ({ ...(previousSummary || {}), model: data?.model || value,
            templateMode: data?.templateMode || '', templateError: data?.templateError || '' }))
          setWorkflowError('')
          setRefreshVersion(version => version + 1)
        } catch (error) {
          if (alive.current && error.name !== 'AbortError') {
            setModel(previous)
            setWorkflowError(message(error))
          }
        } finally {
          controllers.current.delete(current)
          selectionBusy.current = false
          if (alive.current) setWorkflowBusy(false)
        }
      }
      function updateReference(nodeId, patch) {
        setReferences(previous => ({ ...previous, [nodeId]: { ...previous[nodeId], ...patch } }))
      }
      // 本地文件与客户端素材库共用这一段：两条入口必须过同一套大小、MIME 与总大小校验。
      function applyReferenceFile(slot, file, inSettings = false) {
        let error = ''
        if (file) {
          if (file.size > 10 * MB) error = '单个文件不能超过 10MB。'
          else if (!file.type.startsWith(slot.kind + '/')) error = '文件类型不符或 MIME 类型无法识别。'
          const others = Object.entries(references).reduce((sum, [key, entry]) =>
            sum + (key === String(slot.nodeId) ? 0 : entry.file?.size || 0), 0)
          if (!error && others + file.size > 25 * MB) error = '参考文件总大小不能超过 25MB。'
        }
        updateReference(slot.nodeId, { file: error ? null : file || null })
        setReferenceErrors(previous => ({ ...previous, [slot.nodeId]: error }))
        if (file && !error) setClearedDefaults(previous => ({ ...previous, [slot.nodeId]: false }))
        // 设置抽屉里的素材是客户端默认素材；主面板上传或从图库选的只覆盖本次生成，不写回客户端。
        if (inSettings) {
          perShotReferenceSlots.current.delete(String(slot.nodeId))
          markSettings('references')
        } else perShotReferenceSlots.current.add(String(slot.nodeId))
        return error
      }
      function chooseFile(slot, event, inSettings = false) {
        const file = event.target.files?.[0]
        const error = applyReferenceFile(slot, file || null, inSettings)
        if (error) event.target.value = ''
      }
      function openLibrary(slot, inSettings) {
        setLibraryPicker({ nodeId: String(slot.nodeId), kind: slot.kind,
          label: slot.label || slot.nodeId, inSettings })
      }

      async function makeInput(signal) {
        if (!workflow || workflow.syncContext !== syncContext || draftContext !== syncContext || workflowError || workflowBusy) throw new Error('请先同步当前工作流描述。')
        if (workflow.pipeline && Object.values(references).some(entry => entry.file || entry.note)) throw new Error('管线素材请在本地客户端修改，插件同步沿用。')
        if (!prompt.trim()) throw new Error('请先写下提示词。')
        const input = { model, prompt, apply_defaults: true }
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
          if (slot.bypassed) continue
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

      async function regenerate(job) {
        if (regenerateLocks.current.has(job.id)) return
        regenerateLocks.current.add(job.id)
        setRegenerating(previous => ({ ...previous, [job.id]: true }))
        setRegenerateErrors(previous => ({ ...previous, [job.id]: '' }))
        setRegenerateNotice('')
        const current = controller()
        const key = contextKey + '|' + job.id
        let body = pendingRegenerations.get(key)
        if (!body) {
          body = { action: 'regenerate', id: job.id, requestId: crypto.randomUUID(),
            ...(gameId ? { gameId } : {}), bindToTurn: Boolean(bindToTurn && gameId) }
          pendingRegenerations.set(key, body)
        }
        try {
          const next = await request(body, current.signal)
          if (!alive.current) return
          if (!next || typeof next.id !== 'string') {
            const error = new Error('宿主未返回有效任务，重新生成结果未知。')
            error.uncertain = true
            throw error
          }
          mergeJob(next)
          pendingRegenerations.delete(key)
          setRegenerateNotice('已按原任务重新提交，新任务会出现在列表顶部。')
          setRefreshVersion(value => value + 1)
        } catch (error) {
          if (error.name === 'AbortError') return
          if (alive.current) setRegenerateErrors(previous => ({
            ...previous, [job.id]: message(error) + ' 再次点击会沿用同一请求 ID，不会重复提交。',
          }))
        } finally {
          controllers.current.delete(current)
          regenerateLocks.current.delete(job.id)
          if (alive.current) setRegenerating(previous => ({ ...previous, [job.id]: false }))
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
        ...workflow?.defaults?.resolution,
      }
      const referenceGroups = workflow?.pipeline ? workflow.referenceGroups || [] : []
      function renderCustom(definition, options = {}) {
        const inSettings = options.settings === true
        const changed = own(custom, definition.key)
        const defaultValue = own(workflow.defaults?.custom, definition.key)
          ? workflow.defaults.custom[definition.key] : definition.randomize ? '' : definition.defaultValue
        const value = changed ? custom[definition.key] : defaultValue ?? ''
        const change = next => {
          // 主面板里的提示词类参数只对本次生成生效；开关、数值、LoRA 和设置抽屉里的改动都自动写回客户端。
          if (!inSettings && definition.type === 'text') {
            if (next === '') perShotCustomKeys.current.delete(definition.key)
            else perShotCustomKeys.current.add(definition.key)
          } else perShotCustomKeys.current.delete(definition.key)
          if (inSettings || definition.type !== 'text') markSettings('custom')
          setCustom(previous => {
            const values = { ...previous }
            if (next === '') {
              delete values[definition.key]
              if (definition.aiLora && definition.strengthKey) delete values[definition.strengthKey]
            } else values[definition.key] = next
            const option = definition.aiLoraOptions?.find(item => String(item.value) === String(next))
            if (option?.strength != null && definition.strengthKey) values[definition.strengthKey] = option.strength
            return values
          })
        }
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
      function renderReference(slot, group, options = {}) {
        const inSettings = options.settings === true
        const readonly = Boolean(group)
        const source = group || workflow
        const entry = readonly ? {} : references[slot.nodeId] || {}
        const gatewayEnabled = !inSettings || slotModes[slot.nodeId] !== false
        const cleared = inSettings && clearedDefaults[slot.nodeId] === true
        const supported = !readonly && gatewayEnabled && (slot.kind === 'image' || slot.kind === 'audio')
        const label = slot.label || slot.nodeId
        const defaults = (source?.defaults?.references || []).find(item => String(item.nodeId) === String(slot.nodeId))
        const pool = (source?.defaults?.referencePools || []).find(item => String(item.nodeId) === String(slot.nodeId))
        const usesDefaults = true
        const automatic = readonly && workflow.pipeline?.kind === 'first-frame' && group.title === '视频' && /first_frame/i.test(slot.role || '')
        return h('div', { key: slot.nodeId, className: 'rh-slot' },
          h('div', { className: 'rh-slot-head' }, h('span', { className: 'rh-slot-title' }, label),
            h('span', { className: 'rh-slot-tag' }, slot.tag || (slot.kind === 'audio' ? 'AUDIO' : 'IMAGE'))),
          !entry.file && defaults && !automatic && !cleared ? h(SavedReference, { model: source.alias, asset: defaults, revision: source.revision || defaults.updatedAt }) : null,
          automatic ? note('由生图阶段自动填充') : null,
          cleared ? note('自动同步后将清除客户端上的默认素材。') : null,
          !entry.file && pool && usesDefaults && !automatic ? note('客户端随机图库池 · ' + pool.galleryIds.length + ' 张，生成时随机抽取') : null,
          supported ? h('label', { className: 'rh-upload', 'data-selected': Boolean(entry.file) },
            entry.file?.type.startsWith('image/') ? h(ReferencePreview, { file: entry.file }) : icon(entry.file ? 'audio' : 'upload', 22),
            !entry.file?.type.startsWith('image/') ? h('strong', null, entry.file ? entry.file.name : '点击上传' + (slot.kind === 'audio' ? '音频' : '图片')) : null,
            !entry.file ? h('small', null, '单个文件不超过 10MB') : null,
            h('input', { key: model + ':' + slot.nodeId + ':' + (entry.file?.name || ''), type: 'file', accept: slot.kind + '/*',
              'aria-label': (inSettings ? '设置里上传' : '上传') + label, disabled: formDisabled,
              onChange: event => chooseFile(slot, event, inSettings) })) : readonly ? note('与客户端共用素材 · 在客户端修改') :
            !gatewayEnabled ? note('先在网关启用这个槽位，才能保存默认素材。') : note('暂不支持此素材类型'),
          supported ? h('div', { className: 'rh-slot-actions' },
            h('button', { type: 'button', className: 'rh-btn rh-btn-link', disabled: formDisabled,
              title: '从客户端' + (slot.kind === 'audio' ? '常用音频库' : '常用图库') + '选择；由宿主代取，不用手动找文件',
              onClick: () => openLibrary(slot, inSettings) },
            icon(slot.kind === 'audio' ? 'audio' : 'image', 12),
            slot.kind === 'audio' ? '从音频库选' : '从图库选')) : null,
          entry.file ? h('div', { className: 'rh-filename' },
            h('span', { className: 'rh-filename-name', title: entry.file.name }, entry.file.name),
            h('span', null, (entry.file.size / MB).toFixed(2) + ' MB'),
            h('button', { type: 'button', className: 'rh-remove', disabled: formDisabled,
              onClick: () => {
                updateReference(slot.nodeId, { file: null })
                setReferenceErrors(previous => ({ ...previous, [slot.nodeId]: '' }))
                if (inSettings) { perShotReferenceSlots.current.delete(String(slot.nodeId)); markSettings('references') }
                else perShotReferenceSlots.current.add(String(slot.nodeId))
              } }, '移除素材')) :
            h('div', { className: 'rh-row', style: { gap: 8 } },
              note(cleared ? '待清除' : defaults ? '默认 · ' + (defaults.name || '工作流素材') : '未上传时保留工作流素材'),
              inSettings && defaults && !cleared ? button('清除默认', () => {
                setClearedDefaults(previous => ({ ...previous, [slot.nodeId]: true }))
                updateReference(slot.nodeId, { file: null, note: '' })
                perShotReferenceSlots.current.delete(String(slot.nodeId))
                markSettings('references')
              }, formDisabled, null, 'link') : null,
              inSettings && cleared ? button('撤销', () => {
                setClearedDefaults(previous => ({ ...previous, [slot.nodeId]: false }))
                markSettings('references')
              }, formDisabled, null, 'link') : null),
          field('素材备注', h('input', { type: 'text', className: 'rh-input', maxLength: 200,
            value: own(entry, 'note') ? entry.note : pool?.note || defaults?.note || '', placeholder: '可选：人物身份、声音或用途',
            disabled: formDisabled || readonly || !gatewayEnabled,
            onChange: event => {
              updateReference(slot.nodeId, { note: event.target.value })
              if (inSettings) { perShotReferenceSlots.current.delete(String(slot.nodeId)); markSettings('references') }
              else perShotReferenceSlots.current.add(String(slot.nodeId))
            } })),
          inSettings ? checkbox('在网关启用此槽位', slotModes[slot.nodeId] !== false, enable => {
            setSlotModes(previous => ({ ...previous, [slot.nodeId]: enable }))
            markSettings('slots')
          }, formDisabled) :
            !readonly && slot.bypassed ? checkbox('启用此旁路节点', Boolean(entry.enable), enable => updateReference(slot.nodeId, { enable }), formDisabled) : null,
          alert(referenceErrors[slot.nodeId]))
      }
      function settingsStatusText() {
        if (settingsStatus === 'saving') return '正在自动同步到客户端…'
        if (settingsStatus === 'conflict') return settingsError || '客户端设置已在别处更新；点“重新载入”取回客户端那份。'
        if (settingsStatus === 'error') return settingsError || '自动同步失败，修改任意设置或点“重试同步”再试。'
        if (settingsDirty) return '已改动，正在自动同步到客户端…'
        if (settingsNotice) return settingsNotice
        return '已与客户端同步；这里的值与 6888 管理页是同一份。'
      }

      function renderSettingsStatus() {
        const adminURL = (() => {
          try { return new URL('/admin/', summary?.baseURL || baseURL || DEFAULT_BASE).href } catch { return '' }
        })()
        const hostReady = summary?.workflowSettings === true
        const failed = settingsStatus === 'error'
        return h('div', { className: 'rh-stack', style: { gap: 9 } },
          h('div', { className: 'rh-settings-status', 'data-state': settingsStatus, role: 'status' }, settingsStatusText()),
          !hostReady ? h('div', { className: 'rh-error', role: 'alert' },
            '宿主侧还是旧版本：请重启 DSH 后再保存设置。只刷新页面只会更新界面，保存、候选组和切换工作流仍会失败。') : null,
          h('div', { className: 'rh-settings-actions' },
            failed ? button(settingsBusy ? '同步中…' : '重试同步', retrySave, !hostReady || settingsBusy || !settingsDirty, null, 'primary') : null,
            button(settingsDirty ? '放弃并重新载入' : '重新载入', reloadSettings, settingsBusy),
            adminURL ? h('a', { className: 'rh-btn rh-btn-link', href: adminURL, target: '_blank', rel: 'noopener' }, '打开 6888 管理页') : null))
      }

      function renderSeedSettings() {
        if (!workflow?.seedTargets?.length) return null
        return h('details', { className: 'rh-fold' },
          h('summary', null, '随机种子', h('span', { className: 'rh-count' }, workflow.seedTargets.length)),
          h('div', { className: 'rh-fold-content' },
            ...workflow.seedTargets.map(target => {
              if (target.managedByCustomField) return note(target.classType + ' · ' + target.target + '：由自定义参数接管，请在自定义参数里设置。', target.target)
              const pinned = target.pinnedValue !== undefined
              return h('div', { className: 'rh-field', key: target.target },
                h('span', { className: 'rh-field-label' }, target.classType + ' · ' + target.target,
                  h('span', { className: 'rh-note' }, pinned ? '已固定' : '每次随机')),
                h('div', { className: 'rh-row' },
                  h('input', { className: 'rh-input', type: 'text', inputMode: 'numeric', value: seedDraft[target.target] ?? '',
                    placeholder: '每次随机', disabled: formDisabled,
                    onChange: event => {
                      const digits = event.target.value.replace(/[^\d]/g, '')
                      setSeedDraft(previous => ({ ...previous, [target.target]: digits }))
                      markSettings('seeds')
                    } }),
                  button('解除', () => {
                    setSeedDraft(previous => ({ ...previous, [target.target]: '' }))
                    markSettings('seeds')
                  }, formDisabled, null, 'quiet')))
            }),
            note('留空＝每次生成换一个随机种子；填数字＝固定。改动会立即写回客户端，与 6888 管理页同一份。')))
      }

      function renderModelSettings() {
        if (!workflow?.modelFields?.length) return null
        return h('details', { className: 'rh-fold' },
          h('summary', null, '模型字段', h('span', { className: 'rh-count' }, workflow.modelFields.length)),
          h('div', { className: 'rh-fold-content' },
            optionGroupsError ? alert('候选组读取失败：' + optionGroupsError) : null,
            h('div', { className: 'rh-row' }, button('刷新候选组', loadOptionGroups, formDisabled, null, 'link')),
            ...workflow.modelFields.map(modelField => {
              const draft = modelDraft[modelField.target] || { value: modelField.value ?? '', groupId: modelField.groupId ?? '' }
              const group = optionGroups.find(item => item.id === draft.groupId)
              const values = group?.values || []
              const known = Array.from(new Set([draft.value, modelField.canvasValue, ...values].filter(value => typeof value === 'string' && value)))
              const overridden = (draft.value ?? '') !== (modelField.canvasValue ?? '')
              return h('div', { className: 'rh-model-field', key: modelField.target },
                h('div', { className: 'rh-model-field-head' },
                  h('span', { className: 'rh-model-field-title', title: modelField.target },
                    (modelField.groupTitle || '未分组') + ' · ' + (modelField.classType || '模型') + ' ' + modelField.nodeId),
                  overridden ? h('span', { className: 'rh-slot-tag' }, '已覆盖') : null),
                h('div', { className: 'rh-grid2' },
                  field('候选组', h('select', { className: 'rh-input', value: draft.groupId || '', disabled: formDisabled,
                    onChange: event => {
                      setModelDraft(previous => ({ ...previous, [modelField.target]: { ...draft, groupId: event.target.value } }))
                      markSettings('modelFields')
                    } },
                  h('option', { value: '' }, '未选择候选组'),
                  group ? h('option', { value: group.id }, group.label + '（' + group.values.length + '）') : draft.groupId ? h('option', { value: draft.groupId }, '当前候选组（未载入）') : null,
                  optionGroups.filter(item => item.id !== draft.groupId).map(item => h('option', { key: item.id, value: item.id }, item.label + '（' + item.values.length + '）')))),
                  field('模型', h('select', { className: 'rh-input', value: draft.value ?? '', disabled: formDisabled || !known.length,
                    onChange: event => {
                      setModelDraft(previous => ({ ...previous, [modelField.target]: { ...draft, value: event.target.value } }))
                      markSettings('modelFields')
                    } },
                  known.map(value => h('option', { key: value, value }, value === modelField.canvasValue ? value + '（画布原值）' : value))))),
                note('画布原值：' + (modelField.canvasValue || '—') + (group ? '' : ' · 先在 6888 管理页给这个字段选一个候选组，或直接保留下拉里的当前值。')))
            }),
            note('切换后写入网关工作流覆盖层；与「单镜生成」页的模型设置是同一份。')))
      }

      function renderGenerationSettings() {
        return h('section', { className: 'rh-setting-group' },
          h('div', { className: 'rh-setting-heading' }, icon('create'), '生成设置'),
          note('网关当前：画幅 ' + (workflow?.defaults?.resolution ? JSON.stringify(workflow.defaults.resolution) : '画布原值')
            + ' · 片长 ' + (durationDefault ?? '画布原值') + ' 秒 · 自定义 '
            + Object.keys(workflow?.defaults?.custom || {}).length + ' 项'),
          h('details', { className: 'rh-fold', open: true },
            h('summary', null, '分辨率与片长'),
            h('div', { className: 'rh-fold-content' },
              resolutionFields.has('aspect_ratio') ? field('默认画面比例', h('input', { className: 'rh-input', value: ratio,
                placeholder: String(effectiveResolution.aspect_ratio || workflow?.videoAspect?.ratio || '工作流默认'), disabled: formDisabled,
                onChange: event => { setRatio(event.target.value); markSettings('resolution') } })) : null,
              resolutionFields.has('megapixels') ? field('默认像素量 / MP', h('input', { className: 'rh-input', type: 'number', min: 0.1, max: 16, step: 'any', value: megapixels,
                placeholder: String(effectiveResolution.megapixels ?? '工作流默认'), disabled: formDisabled,
                onChange: event => { setMegapixels(event.target.value); markSettings('resolution') } })) : null,
              dimensionsSupported && !resolutionFields.has('aspect_ratio') ? h('div', { className: 'rh-grid2' },
                field('默认宽度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: width,
                  placeholder: String(effectiveResolution.width ?? '工作流默认'), disabled: formDisabled,
                  onChange: event => { setWidth(event.target.value); markSettings('resolution') } })),
                field('默认高度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: height,
                  placeholder: String(effectiveResolution.height ?? '工作流默认'), disabled: formDisabled,
                  onChange: event => { setHeight(event.target.value); markSettings('resolution') } }))) : null,
              durationSupported ? field('默认片长 / 秒', h('input', { className: 'rh-input', type: 'number', min: 0.5, max: 120, step: 'any', value: duration,
                placeholder: durationDefault != null ? String(durationDefault) : '工作流默认', disabled: formDisabled,
                onChange: event => { setDuration(event.target.value); markSettings('duration') } })) : null,
              !resolutionFields.size ? note('此工作流没有声明可覆盖的分辨率字段。') : null,
              h('div', { className: 'rh-row' },
                button('清除分辨率默认', () => { setRatio(''); setMegapixels(''); setWidth(''); setHeight(''); markSettings('resolution') }, formDisabled, null, 'link'),
                durationSupported ? button('清除片长默认', () => { setDuration(''); markSettings('duration') }, formDisabled, null, 'link') : null),
              note('留空＝用工作流画布原值；填写＝保存为网关默认。与 6888 管理页「单镜生成」的分辨率/片长是同一份。'))),
          renderCustomSettings(),
          renderModelSettings(),
          renderSeedSettings())
      }

      function renderCustomSettings() {
        if (!workflow?.customFields?.length) return null
        return h('details', { className: 'rh-fold' },
          h('summary', null, '自定义参数默认值', h('span', { className: 'rh-count' }, workflow.customFields.length)),
          h('div', { className: 'rh-fold-content' }, workflow.customFields.map(field => renderCustom(field, { settings: true })),
            note('改动会立即自动写回客户端，与 6888 管理页「单镜生成」的自定义参数是同一份。')))
      }

      function renderGenerationBehavior() {
        return h('section', { className: 'rh-setting-group' },
          h('div', { className: 'rh-setting-heading' }, icon('settings'), '生成行为'),
          h('label', { className: 'rh-toggle-row' }, h('span', null, '总是发送当前工作流的提示词模板',
            h('span', { className: 'rh-switch' }, h('input', { type: 'checkbox', checked: alwaysSendPrompt,
              disabled: locked || preferenceBusy, onChange: event => changeAlwaysSendPrompt(event.target.checked) }),
            h('span', { className: 'rh-switch-track', 'aria-hidden': true })))),
          note('开启后，每轮把当前工作流完整的提示词模板直接发给模型，不再让模型多一步读 Skill；切换工作流后下一次请求自动使用新模板。关闭后不发送模板，模型工具生成会被拒绝，面板手动生成不受影响。'),
          checkbox('绑定当前对话轮次', bindToTurn, value => changePreference('bindToTurn', value), locked),
          note('提交时绑定当前正文版本，成片完成后插回对应位置；关闭只影响新任务。'),
          note('生成永远套用客户端保存的分辨率、参考素材、模型字段、自定义参数和随机种子，不再单独提供「套用默认值」开关。'),
          preferenceError ? alert(preferenceError) : null)
      }

      function renderReferenceSettings() {
        return h('section', { className: 'rh-setting-group' },
          h('div', { className: 'rh-setting-heading' }, icon('image'), '参考素材默认值'),
          workflow?.pipeline
            ? note('管线工作流的素材在子工作流上，请在 6888 管理页或「单镜生成」页修改；这里沿用客户端保存的整组素材。')
            : workflow?.referenceSlots?.length
              ? h('div', { className: 'rh-slots' }, workflow.referenceSlots.map(slot => renderReference(slot, null, { settings: true })))
              : note('此工作流没有参考素材槽。'),
          note('这里是保存到网关的默认素材，与「单镜生成」页的参考素材、6888 管理页同一份；单个文件 ≤ 10MB，保存请求 ≤ 25MB。'))
      }


      function renderAttachment(item, index) {
        let media = null
        if (isMediaUrl(item.url) && item.kind === 'video') {
          media = h('video', { src: item.url, controls: true, preload: 'metadata', playsInline: true,
            className: 'rh-job-media', onError: retryMediaOnce })
        } else if (isMediaUrl(item.url) && item.kind === 'image') {
          media = h('img', { src: item.url, alt: item.name || '生成图片', loading: 'lazy', className: 'rh-job-media' })
        } else if (isMediaUrl(item.url) && item.kind === 'audio') {
          media = h('audio', { src: item.url, controls: true, preload: 'metadata', className: 'rh-job-audio' })
        }
        return h('div', { key: index, style: { width: '100%' } }, media || note('此附件暂无可预览媒体。'))
      }
      const jobs = summary?.jobs || []
      const activeStatuses = ['preparing', 'submitting', 'queued', 'running', 'downloading']
      const activeCount = jobs.filter(job => activeStatuses.includes(job.status)).length
      const shownJobs = jobs.filter(job => jobFilter === 'all' || (jobFilter === 'active' ? activeStatuses.includes(job.status)
        : jobFilter === 'ready' ? job.status === 'ready' : ['failed', 'download_failed', 'submit_unknown'].includes(job.status)))
      const visibleJobs = view === 'create' ? shownJobs.slice(0, 6) : shownJobs
      const mediaJobs = visibleJobs.filter(job => activeStatuses.includes(job.status)
        || (Array.isArray(job.attachments) && job.attachments.some(item => item && ['video', 'image', 'audio'].includes(item.kind) && isMediaUrl(item.url))))
      const failedJobs = visibleJobs.filter(job => !mediaJobs.includes(job))
      const durationDefault = workflow?.videoDuration?.seconds
      const selectedReferences = Object.values(references).filter(entry => entry.file).length

      function openPlayer(job, item) {
        if (!job || !item || !isMediaUrl(item.url)) return
        setPlayerMedia({})
        setPlayer({ job, item })
      }
      function closePlayer() { setPlayer(null) }
      function dismissVideoNotice(id) {
        setVideoNotices(current => current.filter(notice => notice.id !== id))
      }
      function renderJobErrors(job) {
        return [
          alert(job.queryError ? '查询暂时失败，将自动重试。' : '', 'query-' + job.id),
          alert(job.error, 'error-' + job.id),
          alert(job.insertionError ? '正文插入失败，媒体已保留：' + message(job.insertionError) : '', 'insertion-' + job.id),
          job.status === 'submit_unknown' ? note('先核对任务，请勿重复生成。', 'unknown-' + job.id) : null,
        ]
      }
      function jobPrimaryError(job) {
        if (job.insertionError) return '正文插入失败：' + message(job.insertionError)
        if (job.queryError) return '查询暂时失败，将自动重试'
        if (job.error) return message(job.error)
        if (job.status === 'submit_unknown') return '提交结果未知，先核对任务'
        if (job.status === 'download_failed') return '下载失败，可仅重试下载'
        return ''
      }
      function renderJobMedia(job) {
        const items = Array.isArray(job.attachments) ? job.attachments : []
        const video = videoAttachmentOf(job)
        const image = items.find(item => item?.kind === 'image' && isMediaUrl(item.url))
        const audio = items.find(item => item?.kind === 'audio' && isMediaUrl(item.url))
        let media
        if (video) {
          media = h(VideoThumb, { item: video, className: 'rh-video-thumb-card rh-video-thumb-dense',
            label: '播放视频：' + jobLabel(job), onClick: () => openPlayer(job, video) })
        } else if (image) {
          media = h('a', { className: 'rh-job-row-thumb', href: image.url, target: '_blank', rel: 'noreferrer', title: '打开图片' },
            h('img', { src: image.url, alt: image.name || '生成图片', loading: 'lazy' }))
        } else if (audio) {
          media = h('div', { className: 'rh-job-wait rh-job-wait-dense', title: '音频产物' }, icon('audio', 14))
        } else {
          const inProgress = activeStatuses.includes(job.status)
          media = h('div', { className: 'rh-job-wait rh-job-wait-dense', 'data-state': job.status },
            icon(inProgress ? 'clock' : job.status === 'failed' || job.status === 'download_failed' ? 'image' : 'video', 14),
            h('span', null, inProgress ? '生成中' : job.status === 'failed' ? '失败' : statuses[job.status] || job.status))
        }
        const extra = items.length > 1 ? h('span', { className: 'rh-job-row-count', title: '共 ' + items.length + ' 个产物' }, '+' + (items.length - 1)) : null
        return h('div', { className: 'rh-task-media' }, media, extra)
      }
      function renderJobRowActions(job, video) {
        const play = video ? button('播放', () => openPlayer(job, video), false, 'play-' + job.id, 'primary', 'play') : null
        const regenerateButton = canRegenerateJob(job) ? button(regenerating[job.id] ? '重新提交中…' : '重新生成', () => regenerate(job),
          Boolean(regenerating[job.id]), 'regen-' + job.id, '', 'refresh')
          : video ? h('button', { type: 'button', className: 'rh-btn', disabled: true,
            title: '此任务没有保存可重放的输入，无法重新生成',
            'aria-label': '重新生成不可用：此任务没有保存可重放的输入' }, icon('refresh'), '重新生成') : null
        const retryButton = job.status === 'download_failed' ? button(retrying[job.id] ? '重试中…' : '重试下载', () => retryDownload(job.id),
          Boolean(retrying[job.id]), 'retry-' + job.id, 'quiet', 'refresh') : null
        if (!play && !regenerateButton && !retryButton) return null
        return h('div', { className: 'rh-task-actions' }, play, regenerateButton, retryButton)
      }
      function renderJobDetails(job, variant = 'row') {
        const cls = variant === 'media' ? 'rh-media-details' : variant === 'fail' ? 'rh-fail-details' : 'rh-task-details'
        return h('details', { className: 'rh-job-details ' + cls }, h('summary', null, '任务详情'),
          renderJobErrors(job),
          h('code', null, '本地 · ' + job.id), job.remoteTaskId ? h('code', null, '远端 · ' + job.remoteTaskId) : null,
          note(job.replayable ? '刷新只查询状态；「重新生成」会按原提示词、参数与参考素材新建任务并重新计费。'
            : ['ready', 'failed', 'download_failed'].includes(job.status)
              ? '刷新只查询状态；此任务没有保存可重放的输入，无法重新生成。'
              : '刷新只查询状态，不会重新提交。'))
      }
      function renderMediaActions(job, video) {
        if (canRegenerateJob(job)) return button(regenerating[job.id] ? '重新提交中…' : '重新生成', () => regenerate(job),
          Boolean(regenerating[job.id]), 'regen-' + job.id, 'quiet', 'refresh')
        if (video) return h('button', { type: 'button', className: 'rh-btn rh-btn-quiet', disabled: true,
          title: '此任务没有保存可重放的输入，无法重新生成',
          'aria-label': '重新生成不可用：此任务没有保存可重放的输入' }, icon('refresh'), '重新生成')
        return null
      }
      function renderMediaJob(job) {
        const video = videoAttachmentOf(job)
        const items = Array.isArray(job.attachments) ? job.attachments : []
        const image = items.find(item => item?.kind === 'image' && isMediaUrl(item.url))
        const audio = items.find(item => item?.kind === 'audio' && isMediaUrl(item.url))
        const inProgress = activeStatuses.includes(job.status)
        const progress = Number(job.progress)
        const width = Number.isFinite(progress) && progress > 0 ? Math.min(100, progress <= 1 ? progress * 100 : progress) : 24
        let media
        if (video) {
          media = h(VideoThumb, { item: video, className: 'rh-video-thumb-card rh-video-thumb-cover',
            label: '播放视频：' + jobLabel(job), onClick: () => openPlayer(job, video) })
        } else if (image) {
          media = h('a', { className: 'rh-media-thumb-link', href: image.url, target: '_blank', rel: 'noreferrer', title: '打开图片' },
            h('img', { src: image.url, alt: image.name || '生成图片', loading: 'lazy' }))
        } else if (audio) {
          media = h('div', { className: 'rh-media-placeholder' }, icon('audio', 24), h('span', null, '音频产物'))
        } else {
          media = h('div', { className: 'rh-media-placeholder rh-job-wait' }, icon('clock', 24),
            h('span', null, statuses[job.status] || job.status),
            inProgress ? h('div', { className: 'rh-media-progress' }, h('span', { style: { width: width + '%' } })) : null)
        }
        const meta = [formatJobTime(job), job.costCoins != null ? job.costCoins + ' 币' : '', hasJobBinding(job) ? (Number.isInteger(job.binding?.turn) ? '第 ' + job.binding.turn + ' 轮' : '已绑定正文') : ''].filter(Boolean).join(' · ')
        return h('article', { key: job.id, className: 'rh-job rh-media-card' },
          h('div', { className: 'rh-media-thumb' }, media,
            h('span', { className: 'rh-status rh-media-status', 'data-state': job.status },
              h('span', { className: 'rh-dot' }), statuses[job.status] || job.status),
            items.length > 1 ? h('span', { className: 'rh-media-count', title: '共 ' + items.length + ' 个产物' }, '+' + (items.length - 1)) : null),
          h('div', { className: 'rh-media-foot' },
            h('div', { className: 'rh-media-info' },
              h('div', { className: 'rh-job-title', title: job.model }, jobLabel(job)),
              h('div', { className: 'rh-media-meta', title: meta }, meta || '等待生成')),
            h('div', { className: 'rh-media-actions' }, renderMediaActions(job, video))),
          renderJobDetails(job, 'media'))
      }
      function renderFailedJob(job) {
        const error = jobPrimaryError(job) || '任务失败'
        return h('article', { key: job.id, className: 'rh-job rh-fail-row' },
          h('div', { className: 'rh-fail-icon', 'aria-hidden': true }, icon('image', 14)),
          h('div', { className: 'rh-fail-copy' },
            h('div', { className: 'rh-fail-title' },
              h('span', { className: 'rh-status', 'data-state': job.status },
                h('span', { className: 'rh-dot' }), statuses[job.status] || job.status),
              h('span', { className: 'rh-job-title', title: job.model }, jobLabel(job))),
            h('div', { className: 'rh-fail-error', title: error }, error)),
          h('time', { className: 'rh-fail-time' }, formatJobTime(job)),
          h('span', { className: 'rh-fail-cost' }, job.costCoins != null ? job.costCoins + ' 币' : '—'),
          h('div', { className: 'rh-fail-actions' }, canRegenerateJob(job) ? button('重新生成', () => regenerate(job),
            Boolean(regenerating[job.id]), 'regen-' + job.id, 'quiet', 'refresh') : null),
          renderJobDetails(job, 'fail'))
      }
      function renderVideoNotice(notice) {
        const job = notice.job
        return h('div', {
          key: notice.id, className: 'rh-video-toast', role: 'group', 'aria-label': '视频生成完成',
          onClick: () => openPlayer(job, notice.item),
        },
        h(VideoThumb, { item: notice.item, className: 'rh-video-thumb-toast', label: '播放视频：' + jobLabel(job),
          onClick: event => { event.stopPropagation(); openPlayer(job, notice.item) } }),
        h('div', { className: 'rh-video-toast-copy' },
          h('div', { className: 'rh-video-toast-kicker' },
            h('span', { className: 'rh-video-check', 'aria-hidden': true }, icon('check', 8)), '生成完成'),
          h('div', { className: 'rh-video-toast-title', title: jobLabel(job) }, jobLabel(job)),
          h('div', { className: 'rh-video-toast-meta' }, toastMeta(job))),
        h('button', { type: 'button', className: 'rh-video-toast-close', 'aria-label': '收起通知',
          onClick: event => { event.stopPropagation(); dismissVideoNotice(notice.id) } }, icon('close', 12)))
      }
      function renderPlayer() {
        if (!player) return null
        const job = player.job
        const chips = []
        if (playerMedia.duration != null) chips.push(formatDuration(playerMedia.duration))
        if (playerMedia.width && playerMedia.height) chips.push(playerMedia.width + ' × ' + playerMedia.height)
        if (job.costCoins != null) chips.push(job.costCoins + ' 币')
        if (!chips.length) chips.push('视频')
        const busy = Boolean(regenerating[job.id])
        return h('dialog', {
          ref: playerDialogRef, className: 'rh-player-dialog', 'aria-modal': 'true', 'aria-labelledby': 'rh-player-title',
          onCancel: event => { event.preventDefault(); closePlayer() },
          onClick: event => { if (event.target === event.currentTarget) closePlayer() },
        },
        h('section', { className: 'rh-player' },
          h('header', { className: 'rh-player-head' },
            h('div', null,
              h('div', { className: 'rh-player-kicker' }, 'VIDEO PREVIEW'),
              h('h3', { id: 'rh-player-title', className: 'rh-player-title' }, jobLabel(job)),
              h('div', { className: 'rh-player-sub' }, playerSubtitle(job))),
            h('button', { type: 'button', className: 'rh-player-close', ref: playerCloseRef, 'aria-label': '关闭播放器',
              onClick: closePlayer }, icon('close'))),
          h('div', { className: 'rh-player-stage' },
            h('video', { key: player.item.url, className: 'rh-player-video', src: player.item.url, controls: true,
              autoPlay: true, playsInline: true, preload: 'metadata', onError: retryMediaOnce,
              onLoadedMetadata: event => {
                const video = event.currentTarget
                setPlayerMedia({ duration: Number.isFinite(video.duration) ? video.duration : null,
                  width: video.videoWidth || null, height: video.videoHeight || null })
              } })),
          h('footer', { className: 'rh-player-foot' },
            h('div', { className: 'rh-player-chips' }, chips.map((chip, index) => h('span', { key: index, className: 'rh-player-chip' }, chip))),
            h('div', { className: 'rh-player-actions' },
              canRegenerateJob(job) ? h('button', { type: 'button', className: 'rh-player-btn', disabled: busy,
                onClick: () => { const target = job; closePlayer(); regenerate(target) } },
                icon('refresh'), busy ? '重新提交中…' : '重新生成') : null,
              h('button', { type: 'button', className: 'rh-player-btn primary', onClick: closePlayer }, '关闭')))))
      }

      const pregen = summary?.pregen || null
      const pregenLive = (pregen?.entries || []).filter(entry => entry.status === 'ready' || entry.status === 'generating')
      const pregenInactive = (pregen?.entries || []).filter(entry => entry.status !== 'ready' && entry.status !== 'generating').reverse()
      function updatePregenDraft(key, value) {
        pregenDraftDirty.current = true
        setPregenDraft(previous => ({ ...previous, [key]: value }))
      }
      function renderPregenEntry(entry) {
        const busy = pregenBusy[entry.id]
        const video = (entry.attachments || []).find(item => item.kind === 'video' && item.url)
        const canSend = entry.status === 'ready' || entry.status === 'stale'
        const canDelete = ['generating', 'ready', 'failed', 'stale'].includes(entry.status)
        const progress = Number(entry.progress)
        return h('article', { key: entry.id, className: 'rh-pregen-entry' },
          h('div', { className: 'rh-pregen-preview' }, video ?
            h('video', { className: 'rh-pregen-video', src: video.url, controls: true, preload: 'metadata', playsInline: true,
              onError: retryMediaOnce }) :
            h('div', { className: 'rh-job-wait' }, icon(entry.status === 'generating' ? 'clock' : 'video', 24),
              h('span', null, pregenStatuses[entry.status] || entry.status),
              entry.status === 'generating' ? h('div', { className: 'rh-progress' }, h('span', {
                style: { width: (Number.isFinite(progress) && progress > 0 ? Math.min(100, progress <= 1 ? progress * 100 : progress) : 28) + '%' },
              })) : null)),
          h('div', { className: 'rh-pregen-info' },
            h('div', { className: 'rh-pregen-meta' },
              h('span', { className: 'rh-status', 'data-state': entry.status }, h('span', { className: 'rh-dot' }), pregenStatuses[entry.status] || entry.status),
              entry.createdTurn ? h('span', null, '第 ' + entry.createdTurn + ' 轮规划') : null),
            h('p', { className: 'rh-pregen-desc', title: entry.description }, entry.description),
            entry.summary && entry.status !== 'ready' ? note(entry.summary) : null,
            alert(entry.error),
            h('div', { className: 'rh-pregen-actions' },
              canSend ? button(busy === 'send' ? '发送中…' : '发送到本轮', () => pregenAction('send', entry.id), Boolean(busy), null, '', 'arrow') : null,
              canDelete ? button(busy === 'delete' ? '删除中…' : '删除', () => pregenAction('delete', entry.id), Boolean(busy), null, 'quiet') : null)))
      }
      const pregenCard = gameId && pregen ? h('section', { className: 'rh-card rh-pregen', 'aria-label': '预生成视频池' },
        h('div', { className: 'rh-card-head' },
          h('div', null,
            h('div', { className: 'rh-eyebrow' }, 'PRE-GENERATED POOL'),
            h('h3', null, '预生成视频池'),
            note(`就绪 ${pregen.ready || 0} · 生成中 ${pregen.generating || 0}${pregen.settings?.count ? ` · 目标 ${pregen.settings.count}` : ''}`)),
          h('div', { className: 'rh-row' },
            pregen.planning ? h('span', { className: 'rh-pill' }, '规划中…') : null,
            button(pregenRefillBusy ? '补池中…' : '补池', () => pregenAction('refill'), pregenRefillBusy || !pregen.settings?.count, null, 'quiet', 'refresh'))),
        h('div', { className: 'rh-card-body' },
          h('div', { className: 'rh-pregen-settings' },
            field('预生成目标数量', h('input', { className: 'rh-input', type: 'number', min: 0, max: 20, step: 1,
              value: String(pregenDraft.count ?? 0), disabled: !gameId || pregenRefillBusy,
              onChange: event => updatePregenDraft('count', Math.max(0, Math.min(20, Number(event.target.value) || 0))) })),
            field('预生成每轮上限', h('input', { className: 'rh-input', type: 'number', min: 0, max: 20, step: 1,
              value: String(pregenDraft.perTurn ?? 0), disabled: !gameId || pregenRefillBusy,
              onChange: event => updatePregenDraft('perTurn', Math.max(0, Math.min(20, Number(event.target.value) || 0))) })),
            field('预生成自动退出轮数', h('input', { className: 'rh-input', type: 'number', min: 0, max: 99, step: 1,
              value: String(pregenDraft.maxAge ?? 6), disabled: !gameId || pregenRefillBusy,
              onChange: event => updatePregenDraft('maxAge', Math.max(0, Math.min(99, Number(event.target.value) || 0))) })),
            h('label', { className: 'rh-check' }, h('input', { type: 'checkbox', checked: pregenDraft.review !== false,
              disabled: !gameId || pregenRefillBusy,
              onChange: event => {
                updatePregenDraft('review', event.target.checked)
                void savePregenSettings({ ...pregenDraft, review: event.target.checked })
              } }), '每轮复审'),
            button('保存设置', () => savePregenSettings(pregenDraft), !gameId || pregenRefillBusy, null, 'quiet')),
          note('数量 0 表示关闭；每轮上限 0 表示一次补满；自动退出 0 表示不按轮数退。开启后每轮结束会调用后台模型规划并自动花积分，只在有对话的局生效。'),
          pregen.lastError ? alert('后台规划失败：' + pregen.lastError) : null,
          pregenError ? alert(pregenError) : null,
          pregenNotice ? h('div', { className: 'rh-notice', role: 'status' }, pregenNotice) : null,
          pregenLive.length ? h('div', { className: 'rh-pregen-grid' }, pregenLive.map(renderPregenEntry)) :
            h('div', { className: 'rh-pregen-empty' }, icon('video', 24),
              h('strong', null, pregen.settings?.count > 0 ? '池子还空着' : '预生成未开启'),
              h('small', null, pregen.settings?.count > 0 ? '后台会在每轮结束后按剧情补；想马上要就点「补池」。' : '把目标数量设为 1–20，后台会在每轮结束后按剧情预生成备用视频。')),
          pregenInactive.length ? h('details', { className: 'rh-fold' },
            h('summary', null, '已用 / 已退 / 失败 · ' + pregenInactive.length),
            h('div', { className: 'rh-pregen-grid' }, pregenInactive.map(renderPregenEntry))) : null,
          h('div', { style: { marginTop: 12 } }, note('就绪的视频会列进正文提示词，模型用 runninghub_send_pregenerated 直接发，不花积分；用掉后台自动补。'))))
        : null

      return h('div', { className: 'rh-studio', ref: rootRef, 'data-theme': theme },
        h('style', null, css),
        h('header', { className: 'rh-topbar' },
          h('div', { className: 'rh-brand' }, h('div', { className: 'rh-mark', 'aria-hidden': true }, 'RH'),
            h('div', null, h('div', { className: 'rh-brand-name' }, 'RunningHub', h('span', { className: 'rh-ui-badge', title: '视频缩略图界面 v5（PC 缩略图库）' }, 'v5')),
              h('div', { className: 'rh-kicker rh-brand-sub' }, 'LOCAL CREATIVE STUDIO'))),
          h('div', { className: 'rh-top-actions' },
            h('span', { className: 'rh-pill', 'data-state': summary?.configured && !summary.gatewayError && !refreshError ? 'online' : 'offline' },
              h('span', { className: 'rh-dot' }), summary == null ? '读取连接中' : summary.configured ? summary.gatewayError || refreshError ? '连接异常' : '网关已连接' : '待配置'),
            h('button', { type: 'button', className: 'rh-btn', ref: settingsButtonRef, 'aria-haspopup': 'dialog',
              onClick: () => setSettingsOpen(true) }, icon('settings'), '设置'))),
        h('div', { className: 'rh-body', inert: settingsOpen ? '' : undefined,
          style: videoNotices.length ? { paddingBottom: view === 'create' ? 190 : 112 } : undefined },
          h('nav', { className: 'rh-nav', 'aria-label': '工作台导航' },
            h('div', { className: 'rh-tabs', role: 'tablist', 'aria-label': '工作台页面' },
              h('button', { type: 'button', role: 'tab', id: 'rh-create-tab', 'aria-controls': 'rh-create-view',
                'aria-selected': view === 'create', className: 'rh-tab', onClick: () => setView('create') }, icon('create', 14), '单镜生成'),
              h('button', { type: 'button', role: 'tab', id: 'rh-pregen-tab', 'aria-controls': 'rh-pregen-view',
                'aria-selected': view === 'pregen', className: 'rh-tab', onClick: () => setView('pregen') }, icon('video', 14), '预生成',
                pregen ? h('span', { className: 'rh-count' }, pregenLive.length) : null),
              h('button', { type: 'button', role: 'tab', id: 'rh-history-tab', 'aria-controls': 'rh-history-view',
                'aria-selected': view === 'history', className: 'rh-tab', onClick: () => setView('history') }, icon('grid', 14), '任务历史', h('span', { className: 'rh-count' }, jobs.length))),
            h('div', { className: 'rh-context' }, icon('link', 12), gameId ? '已关联当前对话' : '独立创作')),
          alert(refreshError), alert(summary?.gatewayError), alert(summary?.settingsError ? '客户端默认模型读取失败：' + summary.settingsError : ''),
          alert(summary?.autoInsert === true && summary?.alwaysSendPrompt === false
            ? '自动插入已开启，但「总是发送提示词模板」关闭：模型不会收到生成说明，工具生成会被拒绝。' : ''),
          alert(summary?.generationMode === 'marker' && summary?.alwaysSendPrompt === false
            ? '正文标记模式已开启，但「总是发送提示词模板」关闭：模型看不到标记格式，不会输出镜头。' : ''),
          alert(summary?.generationMode === 'marker' && summary?.autoInsert !== true
            ? '正文标记模式已开启，但自动插入关闭：标记块会被保留，不会提交生成。' : ''),
          alert(summary?.markerError ? '正文标记处理失败：' + summary.markerError : ''),
          alert(summary?.markerWarning ? '正文标记：' + summary.markerWarning : ''),
          alert(summary?.markerRegexError ? '正文标记正则库同步失败：' + summary.markerRegexError : ''),
          summary && !summary.configured ? h('div', { className: 'rh-notice' }, '连接本地网关后，即可读取工作流并开始创作。 ',
            button('配置连接', () => setSettingsOpen(true), false, null, 'link')) : null,
          h('div', { id: 'rh-create-view', role: 'tabpanel', 'aria-labelledby': 'rh-create-tab', hidden: view !== 'create' },
            h('section', { className: 'rh-card' },
              h('div', { className: 'rh-hero' }, h('div', { className: 'rh-eyebrow' }, 'PROMPT PASSTHROUGH'),
                h('h2', null, '把故事，变成镜头'),
                h('p', { className: 'rh-lead' }, '选择工作流、写下画面。生成在后台继续，你可以留在故事里。'),
                h('label', { className: 'rh-workflow' }, h('span', { className: 'rh-workflow-label' }, '工作流'),
                  h('select', { className: 'rh-input', 'aria-label': '工作流', value: model, disabled: locked || settingsBusy || !aliases.length,
                    onChange: event => selectModel(event.target.value) }, !aliases.length ? h('option', { value: '' }, '等待客户端工作流') : null,
                    aliases.map(alias => h('option', { key: alias, value: alias }, alias))),
                  h('span', { className: 'rh-workflow-hint' }, workflowBusy ? '读取参数中…' : workflow ? '已与客户端同步' : '等待连接')),
                h('div', { className: 'rh-row', style: { marginTop: 10 } },
                  button('同步客户端', () => setRefreshVersion(value => value + 1), locked || refreshBusy || workflowBusy, null, 'link', 'refresh'),
                  note(summary?.templateMode
                    ? '提示词模板 · ' + summary.templateMode + (summary?.alwaysSendPrompt === false ? ' · 开关关闭，未发送' : ' · 每轮发送')
                    : '工作流由面板固定，AI 不选别名')),
                alert(summary?.templateError ? '提示词模板读取失败：' + summary.templateError : ''),
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
                    note(summary?.autoInsert ? 'AI 生成的镜头会按设置（每回合 ' + (summary?.videosPerTurn || 3) + ' 段）绑定提交时的正文版本，完成后自动补入。' : '在设置里开启自动插入，AI 可先写正文，视频完成后再补入。'))),
                h('aside', { className: 'rh-side', 'aria-label': '生成参数' },
                  h('div', { className: 'rh-stack' },
                    h('div', { className: 'rh-section-label', style: { marginBottom: 0 } }, '生成参数',
                      settingsBusy ? h('span', { className: 'rh-note' }, '正在同步…') :
                        settingsDirty ? h('span', { className: 'rh-note' }, '改动待同步…') : null),
                    resolutionFields.has('aspect_ratio') ? field('画面比例', h('input', { className: 'rh-input', value: ratio,
                      placeholder: String(effectiveResolution.aspect_ratio || workflow?.videoAspect?.ratio || '客户端默认'), disabled: formDisabled, onChange: event => { setRatio(event.target.value); markSettings('resolution') } })) : null,
                    durationSupported ? field('片长 / 秒', h('input', { className: 'rh-input', type: 'number', min: 0.5, max: 120, step: 'any', value: duration,
                      placeholder: durationDefault != null ? String(durationDefault) : '默认', disabled: formDisabled, onChange: event => { setDuration(event.target.value); markSettings('duration') } })) : null,
                    resolutionFields.has('megapixels') ? field('像素量 / MP', h('input', { className: 'rh-input', type: 'number', min: 0.1, max: 16, step: 'any', value: megapixels,
                      placeholder: String(effectiveResolution.megapixels ?? '默认'), disabled: formDisabled, onChange: event => { setMegapixels(event.target.value); markSettings('resolution') } })) : null,
                    dimensionsSupported && !resolutionFields.has('aspect_ratio') ? h('div', { className: 'rh-grid2' },
                      field('宽度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: width,
                        placeholder: String(effectiveResolution.width ?? '默认'), disabled: formDisabled, onChange: event => { setWidth(event.target.value); markSettings('resolution') } })),
                      field('高度 / px', h('input', { className: 'rh-input', type: 'number', min: 64, max: 8192, step: 1, value: height,
                        placeholder: String(effectiveResolution.height ?? '默认'), disabled: formDisabled, onChange: event => { setHeight(event.target.value); markSettings('resolution') } }))) : null,
                    !resolutionFields.size ? note('分辨率沿用客户端工作流；未声明可覆盖字段。') : null,
                    checkbox('绑定当前对话轮次', bindToTurn, value => changePreference('bindToTurn', value), locked),
                    preferenceError ? alert(preferenceError) : null,
                    h('details', { className: 'rh-fold' }, h('summary', null, '自定义参数', h('span', { className: 'rh-count' }, workflow?.customFields.length || 0)),
                      h('div', { className: 'rh-fold-content' }, workflow?.customFields.length ? workflow.customFields.map(field => renderCustom(field)) : note('此工作流暂无自定义参数。'),
                        note('开关、数值、LoRA 与强度改动会立即写回客户端；提示词类参数只对本次生成生效。'))),
                    h('details', { className: 'rh-fold' }, h('summary', null, '工作流默认设置'),
                      h('div', { className: 'rh-fold-content rh-meta-list' },
                        note('片长 ' + (durationDefault ?? '—') + ' 秒 · ' + (workflow?.videoDuration?.fps ?? '—') + ' fps'),
                        note('分辨率 ' + (workflow?.defaults?.resolution ? JSON.stringify(workflow.defaults.resolution) : '使用画布原值')),
                        ...(workflow?.defaults?.references || []).map((item, index) => note('素材 · ' + (item.name || '未命名'), index)),
                        note('模型字段 ' + (workflow?.modelFields?.length || 0) + ' 个 · 种子 ' + (workflow?.seedTargets?.length || 0) + ' 个'),
                        note('这些默认值与 6888 管理页是同一份；改动在右上角「设置」里会自动同步。'),
                        button('打开完整设置', () => setSettingsOpen(true), false, null, 'link')))))),
              h('section', { className: 'rh-references', 'aria-label': '参考素材' },
                h('div', { className: 'rh-section-label', style: { marginBottom: 0 } }, h('span', null, '参考素材'),
                  h('span', { className: 'rh-note' }, selectedReferences ? '已选择 ' + selectedReferences + ' 份' : '图片 / 音频')),
                workflowBusy ? h('div', { className: 'rh-skeleton' }) : null,
                workflow?.pipeline ? referenceGroups.map(group => h('section', { key: group.alias + group.title, style: { marginTop: 14 } },
                  h('h3', null, group.title + ' · ' + group.alias), h('div', { className: 'rh-slots' }, group.referenceSlots.map(slot => renderReference(slot, group))))) :
                workflow?.referenceSlots.length ? h('div', { className: 'rh-slots' }, workflow.referenceSlots.map(slot => renderReference(slot))) :
                  h('div', { style: { paddingTop: 13 } }, note(workflow ? '此工作流无需上传参考素材。' : '连接工作流后显示参考素材槽位。')),
                h('div', { style: { marginTop: 12 } }, note('槽位、默认素材、备注和随机池与客户端同步。主面板上传或从图库选的素材只覆盖本次生成；要改客户端默认素材，请在右上角「设置」里上传或从图库选（自动同步）。单文件 ≤ 10MB，请求 ≤ 25MB。')))),
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
          h('div', { id: 'rh-pregen-view', role: 'tabpanel', 'aria-labelledby': 'rh-pregen-tab', hidden: view !== 'pregen' },
            pregenCard || h('div', { className: 'rh-empty' }, icon('video', 30),
              h('strong', null, !gameId ? '请先打开一局游戏' : summary ? '预生成池还没就绪' : '正在读取预生成池…'),
              h('small', null, !gameId ? '预生成按局保存；打开一局游戏后回来配置。' : '连接网关并设好目标数量后，这里会列出就绪与生成中的候补视频。'))),
          view === 'pregen' ? null : h('section', { className: 'rh-results', id: 'rh-history-view', role: view === 'history' ? 'tabpanel' : undefined,
            'aria-labelledby': view === 'history' ? 'rh-history-tab' : undefined },
            h('div', { className: 'rh-results-head' }, h('div', { className: 'rh-results-title' }, h('h3', null, view === 'history' ? '任务历史' : '最近生成'),
              h('span', { className: 'rh-count' }, jobs.length)),
              button(refreshBusy ? '正在刷新…' : '刷新', () => setRefreshVersion(value => value + 1), refreshBusy || visible === false, null, 'quiet', 'refresh')),
            regenerateNotice ? h('div', { className: 'rh-notice', role: 'status' }, regenerateNotice) : null,
            h('div', { className: 'rh-filters', role: 'group', 'aria-label': '任务筛选' },
              [['all', '全部'], ['active', '进行中'], ['ready', '已完成'], ['failed', '异常']].map(([value, label]) =>
                h('button', { key: value, type: 'button', className: 'rh-filter', 'aria-pressed': jobFilter === value,
                  onClick: () => setJobFilter(value) }, label))),
            shownJobs.length ? h('div', { className: 'rh-task-groups' },
              mediaJobs.length ? h('div', { className: 'rh-media-grid' }, mediaJobs.map(renderMediaJob)) : null,
              failedJobs.length ? h('section', { className: 'rh-fail-section' },
                h('div', { className: 'rh-fail-head' }, icon('image', 12), '异常任务', h('span', { className: 'rh-count' }, failedJobs.length)),
                failedJobs.map(renderFailedJob)) : null) :
              h('div', { className: 'rh-empty' }, icon('image', 30), h('strong', null, jobs.length ? '暂无符合筛选的任务' : '你的第一个镜头，从这里开始'),
                h('small', null, jobs.length ? '试试切换筛选条件。' : '生成结果会保存在本地。切换页面，不会打断后台任务。')),
            h('div', { style: { marginTop: 12 } }, note(visible === false ? '面板隐藏时暂停轮询' : '每 5 秒自动更新 · 刷新只查询状态，不会重新提交')))),
        settingsOpen ? h('div', { className: 'rh-drawer-layer' },
          h('button', { type: 'button', className: 'rh-backdrop', 'aria-label': '关闭设置遮罩', tabIndex: -1, onClick: () => setSettingsOpen(false) }),
          h('section', { className: 'rh-drawer', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'rh-settings-title', ref: drawerRef },
            h('div', { className: 'rh-drawer-head' }, h('div', null, h('h3', { id: 'rh-settings-title' }, '工作台设置'),
              note('工作流、生成默认值与正文联动 · 与 6888 管理页互通')),
              h('button', { type: 'button', className: 'rh-btn rh-btn-quiet', 'aria-label': '关闭设置', onClick: () => setSettingsOpen(false) }, icon('close'))),
            h('div', { className: 'rh-drawer-content' },
              renderSettingsStatus(),
              h('div', { className: 'rh-rule' }),
              h('section', { className: 'rh-setting-group' },
                h('div', { className: 'rh-setting-heading' }, icon('grid'), '工作流'),
                field('工作流', h('select', { className: 'rh-input', 'aria-label': '设置里的工作流', value: model,
                  disabled: locked || settingsBusy || !aliases.length, onChange: event => selectModel(event.target.value) },
                !aliases.length ? h('option', { value: '' }, '等待客户端工作流') : null,
                aliases.map(alias => h('option', { key: alias, value: alias }, alias)))),
                summary?.templateMode
                  ? note('提示词模板 · ' + summary.templateMode + (summary?.alwaysSendPrompt === false ? ' · 开关关闭，未发送' : ' · 每轮发送'))
                  : null,
                note('与单镜生成页共用同一个选择；切换后自动载入该工作流的网关设置。'),
                alert(workflowError)),
              h('div', { className: 'rh-rule' }),
              workflow ? renderGenerationSettings() : note('连接网关并选择工作流后，这里显示可保存的生成设置。'),
              h('div', { className: 'rh-rule' }),
              renderReferenceSettings(),
              h('div', { className: 'rh-rule' }),
              h('section', { className: 'rh-setting-group' }, h('div', { className: 'rh-setting-heading' }, icon('video'), '正文视频'),
                field('生成方式', h('select', { className: 'rh-input', 'aria-label': '正文视频生成方式', value: generationMode,
                  disabled: locked || preferenceBusy, onChange: event => changeGenerationMode(event.target.value) },
                h('option', { value: 'tool' }, '工具调用（runninghub_generate）'),
                h('option', { value: 'marker' }, '正文标记（非工具调用）'))),
                note(generationMode === 'marker'
                  ? '正文标记模式：不注册任何 RunningHub 工具（含 describe / status），模型把镜头提示词写在正文末尾的 [[RH:SHOT]] 块里，插件会自动把标记块写进 Tavern 正则库，从正文显示和后续提示词里移除，并把成片插回 @after 指定的句子之后。'
                  : '工具调用模式：模型在同一条回复里调用 runninghub_generate 提交；需要模型支持工具调用。'),
                generationMode === 'marker' ? h('details', { className: 'rh-fold' },
                  h('summary', null, '正文标记格式'),
                  h('div', { className: 'rh-fold-content' },
                    h('pre', { style: { margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--rh-soft)', color: 'var(--rh-ink)', fontSize: 11, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowX: 'auto' } },
                      '[[RH:SHOT]]\n@after\n正文里紧挨插入位置的一句原句\n@caption\n可选，短镜头名\n@prompt\n单段工作流的提示词\n[[/RH:SHOT]]'),
                    note('两段式管线（Qwen 多图生图 → 图生视频）把 @prompt 换成 @image 与 @video，两段都写。多个镜头就重复多个块，块统一放在正文最后。'),
                    note('启用插件时会把这条标记清理规则自动加入 Tavern 全局正则库，名称「RunningHub · 移除正文标记块（自动管理）」。即使块里出现 <Picture N> / <Subject N>、或标记块跨进 HTML，也会在正文显示和提示词投影时整段移除。'),
                    note('原始存档正文里仍保留标记，可在 Tavern 正则库查看或停用；正文区和发送给模型的提示词里不会出现。'),
                    note('@after 必须逐字引用本轮正文原句；省略则附在正文末尾。标记块不会进入后续上下文。'))) : null,
                generationMode === 'marker' && summary?.alwaysSendPrompt === false
                  ? alert('正文标记模式需要「总是发送当前工作流的提示词模板」：模型看不到标记格式就不会输出镜头。') : null,
                generationMode === 'marker' && summary?.autoInsert !== true
                  ? alert('自动插入未开启：正文标记会被保留，不会提交生成。') : null,
                h('label', { className: 'rh-toggle-row' }, h('span', null, '视频完成后自动插入对应正文'),
                  h('span', { className: 'rh-switch' }, h('input', { type: 'checkbox', checked: summary?.autoInsert === true,
                    disabled: autoInsertBusy || !summary, onChange: event => saveAutoInsert(event.target.checked) }), h('span', { className: 'rh-switch-track', 'aria-hidden': true }))),
                note('开启后每回合都会自动生成视频，不需要玩家额外说“生成视频”；视频在后台生成，完成后补到原句或正文末尾。绑定提交时的版本，不随重生成串位。'),
                field('每回合生成视频段数', h('input', { className: 'rh-input', type: 'number', min: 1, max: 10, step: 1,
                  value: videosPerTurnDraft, disabled: locked || preferenceBusy,
                  onChange: event => { setVideosPerTurnDraft(event.target.value); if (preferenceError) setPreferenceError('') },
                  onBlur: commitVideosPerTurn,
                  onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); commitVideosPerTurn() } } })),
                note('自动插入开启时，模型会按这个数量拆分镜并提交；默认 3 段。保存后下一轮提示词立即使用新数量。'),
                h('details', { className: 'rh-fold' }, h('summary', null, '联动说明'), h('div', { className: 'rh-fold-content' },
                  note('开启后，模型每回合都会按「每回合生成视频段数」自动拆分镜并提交（当前 ' + (summary?.videosPerTurn || 3) + ' 段）；仅切换开关不会生成或收费。'),
                  note('关闭后模型工具提交会被宿主拒绝，面板手动生成仍可用；已提交的任务仍按原约定插入。'))), alert(autoInsertError)),
              h('div', { className: 'rh-rule' }),
              h('section', { className: 'rh-setting-group' }, h('div', { className: 'rh-setting-heading' }, icon('grid'), '预生成视频池'),
                note('按局配置与查看：在「预生成」页里设置目标数量、每轮上限、自动退出轮数与复审。'),
                note(generationMode === 'marker'
                  ? '正文标记模式下不会自动补池：池子里的视频不会进入正文提示词，仍可在「预生成」页手动补池并发送到本轮。'
                  : '开启后每轮结束会用 Tavern 后台模型按剧情规划并自动花积分；没有配置后台模型或当前工作流没有提示词模板时会明确失败，不会提交。')),
              h('div', { className: 'rh-rule' }),
              renderGenerationBehavior(),
              h('div', { className: 'rh-rule' }),
              h('section', { className: 'rh-setting-group' }, h('div', { className: 'rh-setting-heading' }, icon('link'), '网关连接'),
                field('网关地址', h('input', { type: 'url', className: 'rh-input', value: baseURL, disabled: locked,
                  onChange: event => { baseDirty.current = true; setBaseURL(event.target.value) } })),
                field('网关 Key', h('input', { type: 'password', className: 'rh-input', autoComplete: 'new-password', value: apiKey,
                  placeholder: summary?.configured ? '已配置，留空保留原 Key' : '输入网关 Key', disabled: locked, onChange: event => setApiKey(event.target.value) })),
                note('经 Tavern 同源接口访问本地网关。Key 存入宿主凭据服务，不显示已保存的值。'),
                button(configBusy ? '保存中…' : '保存连接设置', saveConfig, locked), alert(configError),
                configNotice ? h('div', { className: 'rh-notice', role: 'status' }, configNotice) : null),
              note('写在客户端里的设置（分辨率、片长、自定义参数、模型字段、种子、参考素材）与 6888 管理页「单镜生成」是同一份；这里的改动会立即同步，生成也永远以这份为准。')))) : null,
        videoNotices.length ? h('div', { className: 'rh-video-toasts' + (view === 'create' ? ' rh-video-toasts-raised' : ''), 'aria-live': 'polite', 'aria-label': '视频生成完成' }, videoNotices.map(renderVideoNotice)) : null,
        libraryPicker ? h(LibraryPicker, {
          key: libraryPicker.kind + ':' + libraryPicker.nodeId,
          kind: libraryPicker.kind,
          slotLabel: libraryPicker.label,
          onClose: () => setLibraryPicker(null),
          onPick: file => {
            const slot = (workflow?.referenceSlots || []).find(item => String(item.nodeId) === libraryPicker.nodeId)
            if (!slot) return '当前工作流的参考槽已变化，请关闭素材库后重新打开。'
            return applyReferenceFile(slot, file, libraryPicker.inSettings)
          },
        }) : null,
        renderPlayer())
    }

    return {
      name: 'dsh-runninghub',
      inject: ['tavernUi'],
      apply(ctx) {
        // 正文标记（非工具调用模式）：生成过程中先把整块提示词藏成一个镜头占位，
        // 避免提示词在正文里闪一下；插件会把它写进 Tavern 正则库，结算后从正文显示和提示词里移除。
        if (typeof ctx.tavernUi.registerTextMarker === 'function') {
          try {
            ctx.tavernUi.registerTextMarker({
              pattern: /[\[［]{2}\s*RH\s*[:：]\s*SHOT\s*[\]］]{2}[\s\S]*?(?:[\[［]{2}\s*\/\s*RH\s*(?:[:：]\s*SHOT\s*)?[\]］]{2}|$)/gi,
              render: ({ match, streaming }) => {
                const caption = /@caption[ \t]*[:：]?[ \t]*([^\r\n]+)/i.exec(String(match || ''))?.[1]?.trim()
                const label = caption ? '镜头 · ' + caption : (streaming ? '正在整理镜头…' : '镜头提示词已捕获')
                return h('span', {
                  'data-rh-marker': 'shot',
                  title: 'RunningHub 正文标记：插件已把它加入 Tavern 正则库，正文和后续提示词都会移除；成片会插到 @after 指定的句子后面。',
                  style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', border: '1px dashed currentColor', borderRadius: 999, fontSize: '0.85em', lineHeight: 1.6, opacity: 0.75, verticalAlign: 'baseline' },
                }, '🎬 ', label)
              },
            })
          } catch (error) { console.warn('[dsh-runninghub] 正文标记注册失败', error) }
          try {
            ctx.tavernUi.registerTextMarker({
              // Tavern 会把以 <Picture N> / <Subject N> 开头的独立行当成 HTML 块。
              // 标记块被切开时，上面的 pattern 只能盖住前半截，后半截会留在 HTML
              // 里；这里把「从标签到闭合」的尾巴一并隐藏。完整的标记块仍由上面的
              // pattern 优先匹配，不会被这段抢走。
              pattern: /<\s*(?:Picture|Subject)\s+\d+\s*>[\s\S]*?[\[［]{2}\s*\/\s*RH\s*(?:[:：]\s*SHOT\s*)?[\]］]{2}/gi,
              render: () => h('span', { 'data-rh-marker': 'shot-tail', hidden: true, 'aria-hidden': true }),
            })
          } catch (error) { console.warn('[dsh-runninghub] 正文标记尾部注册失败', error) }
        }
        ctx.tavernUi.registerPanel({
          id: 'studio', title: 'RunningHub',
          render: ({ gameId, visible }) => h(Panel, { key: gameId ?? '__unbound__', gameId, visible }),
        })
        // 输入框上方的生成状态（Tavern 插件接口 v6）。只登记 story 模式：卡片工作台的
        // 停靠区是独占的，留给桌宠这类先注册的插件，别把它们挤掉。
        if (typeof ctx.tavernUi.registerComposerSlot === 'function') {
          try {
            ctx.tavernUi.registerComposerSlot({
              id: 'status', modes: ['story'],
              render: ({ sessionId }) => h(GenerationDock, { sessionId }),
            })
          } catch (error) { console.warn('[dsh-runninghub] 生成状态停靠区注册失败', error) }
        }
      },
    }
  },
})
