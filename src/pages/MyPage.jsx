import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { UiIcon } from '../components/Icons'
import CategoryDropdown from '../components/CategoryDropdown'
import Modal from '../components/Modal'
import ActionButton from '../components/ActionButton'
import { PROVIDERS, getProvider, getThinkingLevels, isValidThinkingLevel, AI_DEFAULTS } from '../utils/aiProviders'
import { apiFetch } from '../utils/api'
import { fmtDateTime } from '../utils/format'
import { t } from '../i18n'
import CampusCredPanel from '../features/campus-service/CampusCredPanel'
import BindingsPanel from '../features/account-binding/BindingsPanel'
import './MyPage.css'

const TYPE_META = {
  comment_reply: { icon: 'message', label: 'myPage.notify.type.commentReply' },
  comment_like: { icon: 'heart', label: 'myPage.notify.type.commentLike' },
  blog_comment_like: { icon: 'thumb', label: 'myPage.notify.type.blogCommentLike' },
  project_new_blog: { icon: 'pin', label: 'myPage.notify.type.projectNewBlog' },
  blog_like: { icon: 'heart', label: 'myPage.notify.type.blogLike' },
  blog_new_comment: { icon: 'message', label: 'myPage.notify.type.blogNewComment' },
}

function MyPage() {
  const navigate = useNavigate()
  // 记住上次所在 tab（刷新后停留），网页刷新后依然在 AI 界面
  const [tab, setTab] = useState(() => localStorage.getItem('my_tab') || 'notify')

  const switchTab = (t) => {
    setTab(t)
    localStorage.setItem('my_tab', t)
  }

  // ── 通知 ──
  const [notifications, setNotifications] = useState([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [badgeOn, setBadgeOn] = useState(localStorage.getItem('notify_badge_enabled') !== '0')

  // ── AI 设置 ──
  const [keys, setKeys] = useState([])
  const [currentKeyId, setCurrentKeyId] = useState(null)
  const [favorites, setFavorites] = useState([])
  const [customModels, setCustomModels] = useState([])
  const [dynModels, setDynModels] = useState([])
  const [model, setModel] = useState('')
  const [thinking, setThinking] = useState(AI_DEFAULTS.thinkingLevel)
  const [temperature, setTemperature] = useState(AI_DEFAULTS.temperature)
  const [topK, setTopK] = useState(AI_DEFAULTS.topK)
  const [aiLoading, setAiLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [savingAi, setSavingAi] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [aiSaved, setAiSaved] = useState(false)
  const [aiError, setAiError] = useState('')
  const [testResult, setTestResult] = useState(null)
  // 识图模型配置（识图类工具使用）
  const [visionKeyId, setVisionKeyId] = useState(null)
  const [visionModel, setVisionModel] = useState('')
  const [visionThinking, setVisionThinking] = useState('')

  // ── 弹窗状态 ──
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [newKey, setNewKey] = useState({ provider: 'deepseek', label: '', api_key: '', base_url: '' })
  const [savingKey, setSavingKey] = useState(false)
  const [editKeyTarget, setEditKeyTarget] = useState(null)
  const [editKey, setEditKey] = useState({ label: '', api_key: '', base_url: '' })
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [newModelName, setNewModelName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const currentKey = keys.find(k => k.id === currentKeyId) || null
  const currentProv = useMemo(() => getProvider(currentKey ? currentKey.provider : 'deepseek'), [currentKey])
  // 识图思考档位按「识图 Key 的厂商 + 识图模型」解析（与对话模型互不影响）
  const visionKey = keys.find(k => k.id === visionKeyId) || null
  const visionProv = useMemo(() => (visionKey ? getProvider(visionKey.provider) : null), [visionKey])
  const visionThinkingEnabled = !!visionProv && visionProv.thinking !== false

  // 可用模型 = 动态 + 自定义 去重合并
  const availableModels = useMemo(() => {
    const set = new Set()
    const merged = []
    dynModels.forEach(m => { if (!set.has(m)) { set.add(m); merged.push({ model: m, custom: false }) } })
    customModels.forEach(cm => { if (!set.has(cm.model)) { set.add(cm.model); merged.push({ model: cm.model, custom: true }) } })
    return merged
  }, [dynModels, customModels])

  // 排序：收藏置顶，其余按添加顺序
  const sortedModels = useMemo(() => {
    return [...availableModels].sort((a, b) => {
      const fa = favorites.includes(a.model) ? 1 : 0
      const fb = favorites.includes(b.model) ? 1 : 0
      return fb - fa
    })
  }, [availableModels, favorites])

  const handleToggleBadge = () => {
    const next = !badgeOn
    localStorage.setItem('notify_badge_enabled', next ? '1' : '0')
    window.dispatchEvent(new StorageEvent('storage', { key: 'notify_badge_enabled' }))
    setBadgeOn(next)
  }

  useEffect(() => {
    if (!localStorage.getItem('token')) {
      navigate('/auth')
      return
    }
    let cancelled = false
    setLoading(true)
    apiFetch('/api/notifications')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled || !data) return
        setNotifications(data.notifications || [])
        setUnread(data.unread_count || 0)
      })
      .catch(() => setError(t('myPage.notify.loadError')))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [navigate])

  // 加载 AI 设置
  useEffect(() => {
    if (!localStorage.getItem('token') || tab !== 'ai') return
    let cancelled = false
    setAiLoading(true)
    setAiError('')
    Promise.all([
      apiFetch('/api/user/ai-settings'),
      apiFetch('/api/user/ai-keys'),
      apiFetch('/api/user/ai-favorites'),
      apiFetch('/api/user/ai-models'),
    ])
      .then(async ([sRes, kRes, fRes, mRes]) => {
        const [s, k, f, m] = await Promise.all([sRes.json(), kRes.json(), fRes.json(), mRes.json()])
        if (cancelled) return
        setCurrentKeyId(s.key_id || null)
        setModel(s.model || '')
        setThinking(s.thinking_level || AI_DEFAULTS.thinkingLevel)
        setTemperature(typeof s.temperature === 'number' ? s.temperature : AI_DEFAULTS.temperature)
        setTopK(s.top_k || AI_DEFAULTS.topK)
        setKeys(k.keys || [])
        setFavorites(f.favorites || [])
        setCustomModels((m.models || []).map(mm => ({ model: mm })))
        setVisionKeyId(s.vision_key_id || null)
        setVisionModel(s.vision_model || '')
        setVisionThinking(s.vision_thinking || '')
      })
      .catch(() => setAiError(t('myPage.ai.loadError')))

      .finally(() => { if (!cancelled) setAiLoading(false) })
    return () => { cancelled = true }
  }, [tab])

  // 拉取动态模型（可复用：进入页面/切 key 自动，刷新按钮手动）
  // 先读 localStorage 缓存立即显示，再后台拉取更新并写缓存；seq 防快速切换 Key 的竞态
  const dynModelReqRef = useRef(0)
  const loadModels = useCallback((keyId) => {
    if (!keyId) { setDynModels([]); return }
    const seq = ++dynModelReqRef.current
    const cacheKey = `ai_models_${keyId}`
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      try {
        const arr = JSON.parse(cached)
        if (Array.isArray(arr) && arr.length > 0) setDynModels(arr)
      } catch { /* 缓存损坏忽略 */ }
    }
    setModelsLoading(true)
    apiFetch(`/api/user/ai-keys/${keyId}/models`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (seq !== dynModelReqRef.current) return
        if (data) {
          setDynModels(data.models || [])
          if (data.models && data.models.length > 0) {
            try { localStorage.setItem(cacheKey, JSON.stringify(data.models)) } catch { /* 忽略 */ }
          }
        }
      })
      .catch(() => {})
      .finally(() => { if (seq === dynModelReqRef.current) setModelsLoading(false) })
  }, [])

  // 手动刷新：同时重新拉取动态模型 + 自定义模型（新增模型后靠此看到新模型）
  const refreshModels = useCallback((keyId) => {
    loadModels(keyId)
    if (currentKey) {
      apiFetch('/api/user/ai-models')
        .then(r => (r.ok ? r.json() : null))
        .then(data => { if (data) setCustomModels((data.models || []).map(mm => ({ model: mm }))) })
        .catch(() => {})
    }
  }, [loadModels, currentKey])

  // 当前 key 变化时拉取动态模型
  useEffect(() => {
    if (tab !== 'ai' || !currentKeyId) { setDynModels([]); return }
    loadModels(currentKeyId)
  }, [currentKeyId, tab, loadModels])

  // 思考深度按当前厂商+模型净化：切换 key/模型后若当前档位不在可选范围则重置
  useEffect(() => {
    if (!currentKey) return
    if (!isValidThinkingLevel(currentKey.provider, thinking, model)) {
      const levels = getThinkingLevels(currentKey.provider, model)
      const def = levels.find(t => t.value === AI_DEFAULTS.thinkingLevel)
      setThinking(def ? def.value : (levels[0] ? levels[0].value : AI_DEFAULTS.thinkingLevel))
    }
  }, [currentKeyId, currentKey, model])

  // 识图思考深度净化：厂商不支持思考档位时清空；切换识图 key/模型后档位失效则回退默认（''）
  useEffect(() => {
    if (!visionKeyId) return
    if (!visionProv || visionProv.thinking === false) { setVisionThinking(''); return }
    if (visionThinking && !isValidThinkingLevel(visionProv.id, visionThinking, visionModel)) setVisionThinking('')
  }, [visionKeyId, visionProv, visionModel])

  // ── Key 弹窗 ──

  const openAddKey = () => {
    setNewKey({ provider: 'deepseek', label: '', api_key: '', base_url: '' })
    setAiError('')
    setAddKeyOpen(true)
  }

  const handleAddKey = async () => {
    if (!newKey.api_key.trim()) { setAiError(t('myPage.key.add.needApiKey')); return }
    if (!getProvider(newKey.provider)) { setAiError(t('myPage.key.add.unknownProvider')); return }
    if (newKey.provider === 'custom' && !newKey.base_url.trim()) { setAiError(t('myPage.key.add.needBaseUrl')); return }
    setSavingKey(true)
    setAiError('')
    try {
      const res = await apiFetch('/api/user/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: newKey.provider,
          api_key: newKey.api_key.trim(),
          label: newKey.label.trim(),
          custom_base_url: newKey.base_url.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.key.add.failed')); return }
      setKeys(ks => [...ks, data])
      // 立即选中新 Key 并恢复其默认模型（创建时已写入 provider 默认模型为 last_model）
      setCurrentKeyId(data.id)
      restoreKey(data.id)
      setAddKeyOpen(false)
    } catch {
      setAiError(t('myPage.key.add.networkError'))
    } finally {
      setSavingKey(false)
    }
  }

  const openEditKey = (k) => {
    setEditKeyTarget(k)
    setEditKey({ label: k.label || '', api_key: '', base_url: k.custom_base_url || '' })
    setAiError('')
  }

  const handleSaveEditKey = async () => {
    if (!editKeyTarget) return
    setAiError('')
    try {
      const body = { label: editKey.label.trim() }
      if (editKey.base_url.trim()) body.custom_base_url = editKey.base_url.trim()
      if (editKey.api_key.trim()) body.api_key = editKey.api_key.trim()
      const res = await apiFetch(`/api/user/ai-keys/${editKeyTarget.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.key.edit.failed')); return }
      setKeys(ks => ks.map(x => (x.id === editKeyTarget.id ? data : x)))
      setEditKeyTarget(null)
    } catch {
      setAiError(t('myPage.key.edit.networkError'))
    }
  }

  const openDeleteKey = (k) => {
    setDeleteTarget(k)
    setAiError('')
  }

  const handleDeleteKey = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setAiError('')
    try {
      const res = await apiFetch(`/api/user/ai-keys/${deleteTarget.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) { setAiError(t('myPage.key.delete.failed')); setDeleting(false); return }
      setKeys(ks => ks.filter(x => x.id !== deleteTarget.id))
      if (currentKeyId === deleteTarget.id) { setCurrentKeyId(null); setDynModels([]) }
      setDeleteTarget(null)
    } catch {
      setAiError(t('myPage.key.delete.networkError'))
    } finally {
      setDeleting(false)
    }
  }

  // 切换 Key：restore 协议，后端恢复该 Key 上次的选择并返回完整设置
  const restoreKey = async (keyId) => {
    setCurrentKeyId(keyId)
    try {
      const res = await apiFetch('/api/user/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_id: keyId, restore: true }),
      })
      const data = await res.json()
      if (!res.ok) return
      // 用后端返回的该 Key 上次选择刷新 UI
      if (data.model !== undefined) setModel(data.model || '')
      if (data.thinking_level) setThinking(data.thinking_level)
      if (typeof data.temperature === 'number') setTemperature(data.temperature)
      if (data.top_k) setTopK(data.top_k)
    } catch { /* 网络错误静默 */ }
  }

  const handleSetCurrentKey = (keyId) => {
    restoreKey(keyId)
  }

  // 统一持久化当前选择（key/模型/采样参数）：立即提交（热区修复后点击已可靠）
  const pendingRef = useRef({})
  // 最新 state 快照：供原生事件监听/回调读取（避开渲染闭包过期问题）
  const stateRef = useRef({})
  stateRef.current = { currentKeyId, model, thinking, temperature, topK }
  const persistSettings = (patch = {}) => {
    pendingRef.current = { ...pendingRef.current, ...patch }
    const p = { ...pendingRef.current }
    pendingRef.current = {}
    const s = stateRef.current
    apiFetch('/api/user/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_id: p.key_id !== undefined ? p.key_id : s.currentKeyId,
        model: p.model !== undefined ? (p.model || null) : (s.model.trim() || null),
        thinking_level: p.thinking_level !== undefined ? p.thinking_level : s.thinking,
        temperature: p.temperature !== undefined ? p.temperature : s.temperature,
        top_k: p.top_k !== undefined ? p.top_k : s.topK,
      }),
    }).catch(() => {})
  }

  // 模型列表用原生 capture 监听切换（React 委托在快速连点+重渲染时会丢事件）。
  // 依赖列表渲染条件，确保 <ul> 挂载后完成绑定。
  const modelListRef = useRef(null)
  useEffect(() => {
    const el = modelListRef.current
    if (!el) return
    const onDown = (e) => {
      const item = e.target.closest && e.target.closest('.ai-model-item')
      if (!item || !item.dataset.model) return
      e.preventDefault()
      // 乐观高亮：纯 DOM 操作立即反馈（0ms），React 渲染放下一帧且结果幂等
      el.querySelectorAll('.ai-model-item.active').forEach(x => x.classList.remove('active'))
      item.classList.add('active')
      const name = item.dataset.model
      requestAnimationFrame(() => {
        setModel(name)
        persistSettings({ model: name })
      })
    }
    el.addEventListener('mousedown', onDown, true)
    return () => el.removeEventListener('mousedown', onDown, true)
  }, [tab, aiLoading, currentKeyId, currentKey, sortedModels.length])

  // ── 模型弹窗 ──

  const openAddModel = () => {
    setNewModelName('')
    setAiError('')
    setAddModelOpen(true)
  }

  const handleAddModel = async () => {
    const name = newModelName.trim()
    if (!name) return
    if (!currentKey) { setAiError(t('myPage.model.add.needKey')); return }
    setAiError('')
    try {
      const res = await apiFetch('/api/user/ai-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: currentKey.provider, model: name }),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.model.add.failed')); return }
      // 新增成功后不自动刷新列表，由用户点「刷新」后手动看到新模型
      setAddModelOpen(false)
    } catch {
      setAiError(t('myPage.model.add.networkError'))
    }
  }

  const handleToggleFavorite = async (m) => {
    const wasFav = favorites.includes(m.model)
    const newFavs = wasFav ? favorites.filter(f => f !== m.model) : [...favorites, m.model]
    setFavorites(newFavs)
    try {
      const res = await apiFetch('/api/user/ai-favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: currentKey.provider, model: m.model }),
      })
      const data = await res.json()
      if (data && data.favorites) setFavorites(data.favorites)
    } catch {
      setFavorites(wasFav ? [...favorites, m.model] : favorites.filter(f => f !== m.model))
    }
  }

  const handleRemoveCustomModel = async (m) => {
    if (!currentKey) return
    setAiError('')
    try {
      const res = await apiFetch('/api/user/ai-models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: currentKey.provider, model: m.model }),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.model.remove.failed')); return }
      setCustomModels(data.models.map(mm => ({ model: mm })))
    } catch {
      setAiError(t('myPage.model.remove.networkError'))
    }
  }

  // ── 保存 / 测试 ──

  const handleSaveAi = async () => {
    setSavingAi(true)
    setAiError('')
    setAiSaved(false)
    setTestResult(null)
    try {
      const body = { thinking_level: thinking, temperature, top_k: topK, model: model.trim() || null }
      if (currentKeyId) body.key_id = currentKeyId
      body.vision_key_id = visionKeyId || 0
      body.vision_model = visionModel || ''
      // 识图厂商不支持思考档位时不提交档位（保持 ''）
      body.vision_thinking = visionThinkingEnabled ? visionThinking : ''
      const res = await apiFetch('/api/user/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.save.failed')); return }
      setAiSaved(true)
      setTimeout(() => setAiSaved(false), 2500)
    } catch {
      setAiError(t('myPage.save.networkError'))
    } finally {
      setSavingAi(false)
    }
  }

  const handleTestAi = async () => {
    if (!currentKeyId) { setTestResult({ ok: false, text: t('myPage.test.needKey') }); return }
    setTestingAi(true)
    setAiError('')
    setTestResult(null)
    try {
      const body = {}
      if (model.trim()) body.model = model.trim()
      const res = await apiFetch('/api/user/ai-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setAiError(data.detail || t('myPage.test.failed')); return }
      setTestResult({
        ok: data.ok,
        text: data.ok
          ? t('myPage.test.ok', { latency: data.latency_ms })
          : t('myPage.test.err', { error: data.error || t('myPage.test.unknownError') }),
      })
    } catch {
      setTestResult({ ok: false, text: t('myPage.test.networkError') })
    } finally {
      setTestingAi(false)
    }
  }

  const handleReadAll = async () => {
    try {
      await apiFetch('/api/notifications/read', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setNotifications(ns => ns.map(n => ({ ...n, is_read: true })))
      setUnread(0)
    } catch { /* 网络错误静默处理 */ }
  }

  const handleClick = (n) => {
    if (!n.blog_id) return
    if (!n.is_read) {
      apiFetch('/api/notifications/read', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [n.id] }),
      }).catch(() => {})
      setNotifications(ns => ns.map(x => (x.id === n.id ? { ...x, is_read: true } : x)))
      setUnread(u => Math.max(0, u - 1))
    }
    navigate(`/blogs/${n.blog_id}`)
  }

  return (
    <div className="my-page">
      <Navbar activePage="my" />
      <div className="my-container">
        <div className="my-header">
          <h1 className="my-title">{t('myPage.title')}</h1>
          <div className="my-tabs">
            <button type="button" className={`my-tab ${tab === 'notify' ? 'active' : ''}`} onClick={() => switchTab('notify')}>
              {t('myPage.tab.notifications')}{unread > 0 && <span className="my-tab-badge">{unread}</span>}
            </button>
            <button type="button" className={`my-tab ${tab === 'ai' ? 'active' : ''}`} onClick={() => switchTab('ai')}>
              {t('myPage.tab.aiSettings')}
            </button>
            <button type="button" className={`my-tab ${tab === 'campus' ? 'active' : ''}`} onClick={() => switchTab('campus')}>
              {t('myPage.tab.campus')}
            </button>
            <button type="button" className={`my-tab ${tab === 'bindings' ? 'active' : ''}`} onClick={() => switchTab('bindings')}>
              {t('myPage.tab.bindings')}
            </button>
          </div>
        </div>

        {tab === 'notify' && (
          <>
            <div className="my-subheader">
              <label className="my-badge-toggle">
                <input type="checkbox" checked={badgeOn} onChange={handleToggleBadge} />
                <span>{t('myPage.notify.unreadBadge')}</span>
              </label>
              {unread > 0 && <span className="my-unread-count">{t('myPage.notify.unreadCount', { n: unread })}</span>}
              <ActionButton size="sm" onClick={handleReadAll}>{t('myPage.notify.readAll')}</ActionButton>
            </div>
            {error && <div className="my-error">{error}</div>}
            {loading ? (
              <div className="my-loading">{t('myPage.loading')}</div>
            ) : notifications.length === 0 ? (
              <div className="my-empty">{t('myPage.notify.empty')}</div>
            ) : (
              <ul className="my-list">
                {notifications.map((n, i) => {
                  const meta = TYPE_META[n.type] || { icon: '•', label: n.type }
                  return (
                    <li
                      key={n.id}
                      className={`my-item ${n.is_read ? '' : 'my-item-unread'} ${n.blog_id ? 'my-item-link' : ''}`}
                      onClick={() => handleClick(n)}
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <span className="my-item-icon" title={t(meta.label)}><UiIcon name={meta.icon} size={15} /></span>
                      <div className="my-item-main">
                        <p className="my-item-content">{n.content}</p>
                        <p className="my-item-meta">
                          {n.actor_username && <span className="my-item-actor">{n.actor_username}</span>}
                          <span className="my-item-time">{fmtDateTime(n.created_at)}</span>
                        </p>
                      </div>
                      {!n.is_read && <span className="my-item-dot" />}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {tab === 'ai' && (
          <div className="ai-settings">
            {aiLoading ? (
              <div className="my-loading">{t('myPage.loading')}</div>
            ) : (
              <>
                {aiError && <div className="my-error">{aiError}</div>}

                {/* ═══ Key 管理 ═══ */}
                <div className="ai-section">
                  <div className="ai-section-head">
                    <span className="ai-section-title">{t('myPage.key.manage')}</span>
                    <ActionButton size="sm" onClick={openAddKey}>+ {t('myPage.key.addButton')}</ActionButton>
                  </div>

                  {keys.length === 0 ? (
                    <div className="my-empty">{t('myPage.key.noKeys')}</div>
                  ) : (
                    <div className="ai-key-list">
                      {keys.map(k => (
                        <div key={k.id} className={`ai-key-item ${k.id === currentKeyId ? 'active' : ''}`}>
                          <div className="ai-key-main">
                            <div className="ai-key-top">
                              <span className="ai-key-provider">{getProvider(k.provider)?.label || k.provider}</span>
                              {k.label && <span className="ai-key-label">{k.label}</span>}
                              {k.id === currentKeyId && <span className="ai-key-current">{t('myPage.key.current')}</span>}
                            </div>
                            <div className="ai-key-meta">
                              <span className="ai-key-hint">{k.key_hint || t('myPage.key.noKey')}</span>
                              {k.custom_base_url && <span className="ai-key-url">{k.custom_base_url}</span>}
                            </div>
                          </div>
                          <div className="ai-key-ops">
                            {k.id !== currentKeyId && (
                              <button className="ai-op-btn" title={t('myPage.key.setCurrent')} onClick={() => handleSetCurrentKey(k.id)}>
                                <UiIcon name="check" size={14} />
                              </button>
                            )}
                            <button className="ai-op-btn" title={t('myPage.key.editTitle')} onClick={() => openEditKey(k)}>
                              <UiIcon name="edit" size={14} />
                            </button>
                            <button className="ai-op-btn danger" title={t('myPage.key.deleteTitle')} onClick={() => openDeleteKey(k)}>
                              <UiIcon name="trash" size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ═══ 选择当前模型（点击可用模型项）═══ */}
                <div className="ai-section">
                  <div className="ai-section-head">
                    <span className="ai-section-title">{t('myPage.model.select')}</span>
                    {currentProv && <span className="ai-key-provider">{currentProv.label}</span>}
                    <div className="ai-section-ops">
                      <ActionButton
                        size="sm"
                        onClick={() => refreshModels(currentKeyId)}
                        disabled={modelsLoading || !currentKeyId}
                        title={t('myPage.model.refreshTitle')}
                      >
                        {modelsLoading ? t('myPage.loading') : t('myPage.model.refresh')}
                      </ActionButton>
                      <ActionButton size="sm" onClick={openAddModel}>+ {t('myPage.model.addButton')}</ActionButton>
                    </div>
                  </div>

                  {!currentKeyId ? (
                    <div className="my-empty">{t('myPage.model.needKey')}</div>
                  ) : (
                    <>
                      <p className="ai-hint">{t('myPage.model.sortHint')}</p>
                      {sortedModels.length === 0 ? (
                        <div className="my-empty">
                          {modelsLoading ? t('myPage.model.querying') : t('myPage.model.none')}
                        </div>
                      ) : (
                        <ul className="ai-model-list" ref={modelListRef}>
                          {sortedModels.map(m => (
                            <li
                              key={m.model}
                              className={`ai-model-item ${model === m.model ? 'active' : ''}`}
                              data-model={m.model}
                            >
                              <button
                                type="button"
                                className="ai-model-name"
                                title={t('myPage.model.setCurrent')}
                              >
                                {m.model}
                                {m.custom && <span className="ai-model-tag">{t('myPage.model.custom')}</span>}
                              </button>
                              <div className="ai-model-ops">
                                <button
                                  type="button"
                                  className={`ai-fav-btn ${favorites.includes(m.model) ? 'active' : ''}`}
                                  title={favorites.includes(m.model) ? t('myPage.model.unfav') : t('myPage.model.fav')}
                                  onClick={() => handleToggleFavorite(m)}
                                >
                                  <UiIcon name="star" size={14} filled={favorites.includes(m.model)} />
                                </button>
                                {m.custom && (
                                  <button type="button" className="ai-op-btn danger" title={t('myPage.model.removeTitle')} onClick={() => handleRemoveCustomModel(m)}>
                                    <UiIcon name="trash" size={14} />
                                  </button>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>

                {/* ═══ 识图模型（识图类工具使用）═══ */}
                <div className="ai-section">
                  <div className="ai-section-head">
                    <span className="ai-section-title">{t('myPage.visionSpeech.title')}</span>
                    <span className="ai-section-sub">{t('myPage.visionSpeech.sub')}</span>
                  </div>

                  <div className="ai-field">
                    <label className="ai-label">{t('myPage.visionSpeech.visionLabel')}</label>
                    <div className="vs-config-row">
                      <CategoryDropdown
                        value={visionKeyId || ''}
                        onChange={v => {
                          setVisionKeyId(v ? Number(v) : null)
                          setVisionModel('')
                        }}
                        options={keys.map(k => ({ value: k.id, label: `${k.provider} · ${k.label || k.key_hint || k.id}` }))}
                        placeholder={t('myPage.visionSpeech.selectKey')}
                        closeOnSelect
                      />
                      <input
                        type="text"
                        className="profile-input ai-input"
                        value={visionModel}
                        onChange={e => setVisionModel(e.target.value)}
                        placeholder={t('myPage.visionSpeech.visionModel')}
                      />
                    </div>
                    <p className="ai-hint">{t('myPage.visionSpeech.visionHint')}</p>
                  </div>

                  {/* 识图思考深度：档位按识图 Key 的厂商/模型解析；厂商不支持则不显示 */}
                  {visionThinkingEnabled && (
                    <div className="ai-field">
                      <label className="ai-label">{t('myPage.visionSpeech.thinking')}</label>
                      <CategoryDropdown
                        value={visionThinking}
                        onChange={setVisionThinking}
                        options={[
                          { value: '', label: t('myPage.visionSpeech.thinkingDefault') },
                          ...getThinkingLevels(visionProv.id, visionModel).map(l => ({ value: l.value, label: l.label })),
                        ]}
                        placeholder={t('myPage.visionSpeech.thinkingDefault')}
                        hideClear
                        closeOnSelect
                      />
                      <p className="ai-hint">{t('myPage.visionSpeech.thinkingHint')}</p>
                    </div>
                  )}
                </div>

                {/* ═══ 采样参数（先选模型后呈现）═══ */}
                {model ? (
                  <div className="ai-section">
                    <div className="ai-section-head">
                      <span className="ai-section-title">{t('myPage.sampling.title')}</span>
                      <span className="ai-section-sub">{t('myPage.sampling.currentModel', { model })}</span>
                    </div>

                    <div className="ai-field">
                      <label className="ai-label">{t('myPage.sampling.thinking')}</label>
                      <CategoryDropdown
                        value={thinking}
                        onChange={setThinking}
                        options={getThinkingLevels(currentKey ? currentKey.provider : 'deepseek', model).map(t => ({ value: t.value, label: t.label }))}
                        placeholder={t('myPage.sampling.selectThinking')}
                        hideClear
                        closeOnSelect
                      />
                      <p className="ai-hint">{t('myPage.sampling.thinkingHint')}</p>
                    </div>

                    {getProvider(currentKey ? currentKey.provider : 'deepseek')?.sampling !== false && (
                      <>
                        <div className="ai-field">
                          <label className="ai-label">
                            {t('myPage.sampling.temperature')}
                            <span className="ai-value">{temperature.toFixed(2)}</span>
                          </label>
                          <input
                            type="range"
                            className="ai-range"
                            min="0" max="2" step="0.05"
                            value={temperature}
                            onChange={(e) => setTemperature(parseFloat(e.target.value))}
                          />
                          <p className="ai-hint">{t('myPage.sampling.temperatureHint')}</p>
                        </div>

                        <div className="ai-field">
                          <label className="ai-label">
                            {t('myPage.sampling.topK')}
                            <span className="ai-value">{topK}</span>
                          </label>
                          <input
                            type="range"
                            className="ai-range"
                            min="1" max="100" step="1"
                            value={topK}
                            onChange={(e) => setTopK(parseInt(e.target.value, 10))}
                          />
                          <p className="ai-hint">{t('myPage.sampling.topKHint')}</p>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="ai-section">
                    <div className="my-empty">{t('myPage.sampling.needModel')}</div>
                  </div>
                )}

                <div className="ai-actions">
                  <button className="btn btn-primary" onClick={handleSaveAi} disabled={savingAi}>
                    {savingAi ? t('myPage.save.saving') : t('myPage.save.title')}
                  </button>
                  <button className="btn btn-secondary" onClick={handleTestAi} disabled={testingAi}>
                    {testingAi ? t('myPage.test.testing') : t('myPage.test.title')}
                  </button>
                </div>

                {aiSaved && <div className="profile-success ai-saved">&#10003; {t('myPage.save.done')}</div>}
                {testResult && (
                  <div className={`ai-test ${testResult.ok ? 'ok' : 'err'}`}>{testResult.text}</div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'campus' && <CampusCredPanel />}
        {tab === 'bindings' && <BindingsPanel />}
      </div>

      {/* ═══ 二级弹窗（新增/编辑 Key）═══ */}
      <Modal open={addKeyOpen} title={t('myPage.key.addModal.title')} confirmText={t('myPage.key.addModal.confirm')} onCancel={() => setAddKeyOpen(false)} onConfirm={handleAddKey} confirmDisabled={savingKey}>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.key.addModal.provider')}</label>
          <CategoryDropdown
            value={newKey.provider}
            onChange={(v) => setNewKey({ ...newKey, provider: v })}
            options={PROVIDERS.map(p => ({ value: p.id, label: p.label }))}
            placeholder={t('myPage.key.addModal.selectProvider')}
            hideClear
          />
        </div>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.key.addModal.apiKey')}</label>
          <input
            type="password"
            className="profile-input ai-input"
            placeholder={t('myPage.key.addModal.apiKeyPlaceholder')}
            value={newKey.api_key}
            onChange={(e) => setNewKey({ ...newKey, api_key: e.target.value })}
            maxLength={300}
            autoComplete="off"
          />
        </div>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.key.addModal.label')}</label>
          <input
            type="text"
            className="profile-input ai-input"
            placeholder={t('myPage.key.addModal.labelPlaceholder')}
            value={newKey.label}
            onChange={(e) => setNewKey({ ...newKey, label: e.target.value })}
            maxLength={50}
          />
        </div>
        {newKey.provider === 'custom' && (
          <div className="ai-modal-field">
            <label className="ai-label">{t('myPage.key.addModal.baseUrlRequired')}</label>
            <input
              type="text"
              className="profile-input ai-input"
              placeholder={t('myPage.key.addModal.baseUrlPlaceholder')}
              value={newKey.base_url}
              onChange={(e) => setNewKey({ ...newKey, base_url: e.target.value })}
              maxLength={500}
            />
          </div>
        )}
        {aiError && addKeyOpen && <div className="ai-modal-err">{aiError}</div>}
      </Modal>

      <Modal open={!!editKeyTarget} title={t('myPage.key.editModal.title', { label: editKeyTarget ? (editKeyTarget.label ? editKeyTarget.label : '') : '' })} confirmText={t('myPage.key.editModal.confirm')} onCancel={() => setEditKeyTarget(null)} onConfirm={handleSaveEditKey}>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.key.editModal.label')}</label>
          <input
            type="text"
            className="profile-input ai-input"
            placeholder={t('myPage.key.editModal.labelPlaceholder')}
            value={editKey.label}
            onChange={(e) => setEditKey({ ...editKey, label: e.target.value })}
            maxLength={50}
          />
        </div>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.key.editModal.apiKey')}</label>
          <input
            type="password"
            className="profile-input ai-input"
            placeholder={editKeyTarget?.key_hint ? t('myPage.key.editModal.overwriteHint', { hint: editKeyTarget.key_hint }) : t('myPage.key.editModal.apiKey')}
            value={editKey.api_key}
            onChange={(e) => setEditKey({ ...editKey, api_key: e.target.value })}
            maxLength={300}
            autoComplete="off"
          />
        </div>
        {editKeyTarget?.provider === 'custom' && (
          <div className="ai-modal-field">
            <label className="ai-label">{t('myPage.key.editModal.baseUrl')}</label>
            <input
              type="text"
              className="profile-input ai-input"
              placeholder={t('myPage.key.editModal.baseUrl')}
              value={editKey.base_url}
              onChange={(e) => setEditKey({ ...editKey, base_url: e.target.value })}
              maxLength={500}
            />
          </div>
        )}
        {aiError && editKeyTarget && <div className="ai-modal-err">{aiError}</div>}
      </Modal>

      <Modal open={addModelOpen} title={t('myPage.model.addModal.title')} confirmText={t('myPage.model.addModal.confirm')} onCancel={() => setAddModelOpen(false)} onConfirm={handleAddModel}>
        <div className="ai-modal-field">
          <label className="ai-label">{t('myPage.model.addModal.modelId')}</label>
          <input
            type="text"
            className="profile-input ai-input"
            placeholder={t('myPage.model.addModal.modelIdPlaceholder')}
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            maxLength={100}
            autoFocus
          />
          <p className="ai-hint">{t('myPage.model.addModal.hint')}</p>
        </div>
        {aiError && addModelOpen && <div className="ai-modal-err">{aiError}</div>}
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={t('myPage.key.deleteModal.title')}
        message={t('myPage.key.deleteModal.message', { name: deleteTarget ? (deleteTarget.label || deleteTarget.key_hint || deleteTarget.id) : '' })}
        confirmText={t('myPage.key.deleteModal.confirm')}
        cancelText={t('myPage.key.deleteModal.cancel')}
        danger
        confirmDisabled={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteKey}
      />
    </div>
  )
}

export default MyPage
