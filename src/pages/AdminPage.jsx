import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import Modal from '../components/Modal'
import CategoryDropdown from '../components/CategoryDropdown'
import { CONTACT_ICON_OPTIONS, ContactIcon } from '../components/Icons'
import { BLOG_CATEGORIES as CATEGORIES } from '../constants'
import BindAppsPanel from '../features/account-binding/BindAppsPanel'
import AdminDownloadsPanel from '../features/admin-downloads/AdminDownloadsPanel'
import { t } from '../i18n'
import { apiFetch } from '../utils/api'
import { fmtDateTimeMinute } from '../utils/format'
import './AdminPage.css'

function AdminPage() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [tab, setTab] = useState('users')
  const settingsLoaded = useRef(false)
  const [authChecked, setAuthChecked] = useState(false)

  // 各 tab 数据
  const [users, setUsers] = useState([])
  const [comments, setComments] = useState([])
  const [blogs, setBlogs] = useState([])
  const [codes, setCodes] = useState([])
  const [links, setLinks] = useState([])
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '' })
  const [linkEditingId, setLinkEditingId] = useState(null)
  const [settings, setSettings] = useState({ email: '', github_url: '', contact_items: [] })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [lcDebug, setLcDebug] = useState(null)
  const [lcDebugInput, setLcDebugInput] = useState({ easy: 0, medium: 0, hard: 0 })
  const [lcDebugBusy, setLcDebugBusy] = useState(false)
  const [editingUserId, setEditingUserId] = useState(null)
  const [editForm, setEditForm] = useState({ nickname: '', avatar_url: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 弹窗
  const [modal, setModal] = useState(null) // { type, id, title, message, confirmText, onConfirm }

  // 新邀请码
  const [newCode, setNewCode] = useState('')
  // 正在显示"已复制"的复制按钮（'new' 表示新邀请码，否则为邀请码 id）
  const [copiedKey, setCopiedKey] = useState(null)
  const copiedTimerRef = useRef(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userStr = localStorage.getItem('user')
    if (!token || !userStr) {
      navigate('/auth')
      return
    }
    let u = null
    try {
      u = JSON.parse(userStr)
    } catch { /* user 信息损坏时按未登录处理，避免整页白屏 */ }
    if (!u) {
      navigate('/auth')
      return
    }
    if (u.role !== 'admin') {
      navigate('/profile')
      return
    }
    setUser(u)
    setAuthChecked(true)
  }, [navigate])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/users')
      if (res.status === 403) { navigate('/profile'); return }
      const data = await res.json()
      setUsers(data.users || [])
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [navigate])

  const loadComments = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/comments')
      const data = await res.json()
      setComments(data.comments || [])
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [])

  const loadBlogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/blogs')
      const data = await res.json()
      setBlogs(data.blogs || [])
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [])

  const loadCodes = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/invite-codes')
      const data = await res.json()
      setCodes(data.codes || [])
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [])

  const loadLinks = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/admin/friend-links')
      const data = await res.json()
      setLinks(data.links || [])
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [])

  const loadSettings = useCallback(async () => {
    if (settingsLoaded.current) return
    settingsLoaded.current = true
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch('/api/site-settings')
      const data = await res.json()
      setSettings({
        email: data.email || '',
        github_url: data.github_url || '',
        contact_items: (data.contact_items || []).map(it => ({
          label: it.label || '',
          value: it.value || '',
          type: it.type || 'link',
          icon: it.icon || '',
          description: it.description || '',
        })),
      })
    } catch { setError(t('admin.error.network')) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (!authChecked) return
    if (tab === 'users') loadUsers()
    else if (tab === 'comments') loadComments()
    else if (tab === 'blogs') loadBlogs()
    else if (tab === 'codes') loadCodes()
    else if (tab === 'links') loadLinks()
    else if (tab === 'settings') loadSettings()
  }, [authChecked, tab, loadUsers, loadComments, loadBlogs, loadCodes, loadLinks, loadSettings])

  // 设置角色
  const handleSetRole = async (userId, role) => {
    try {
      const res = await apiFetch(`/api/admin/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.operationFailed')); return }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u))
    } catch { alert(t('admin.error.network')) }
  }

  // 编辑用户
  const handleStartEditUser = (u) => {
    setEditForm({ nickname: u.nickname || '', avatar_url: u.avatar_url || '', password: '' })
    setEditingUserId(u.id)
  }

  const handleCancelEditUser = () => {
    setEditingUserId(null)
    setEditForm({ nickname: '', avatar_url: '', password: '' })
  }

  const handleSaveUser = async (userId) => {
    try {
      const res = await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: editForm.nickname.trim() || undefined,
          avatar_url: editForm.avatar_url.trim() || undefined,
          password: editForm.password || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.saveFailed')); return }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, ...data } : u))
      handleCancelEditUser()
    } catch { alert(t('admin.error.network')) }
  }

  // 删除用户
  const handleDeleteUser = async (userId) => {
    if (!userId) return
    try {
      const res = await apiFetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.detail || t('admin.error.deleteFailed')); return }
      setUsers(prev => prev.filter(u => u.id !== userId))
    } catch { alert(t('admin.error.network')) }
    finally { setModal(null) }
  }

  // 删除评论
  const handleDeleteComment = async (commentId) => {
    if (!commentId) return
    try {
      const res = await apiFetch(`/api/admin/comments/${commentId}`, {
        method: 'DELETE',
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.detail || t('admin.error.deleteFailed')); return }
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch { alert(t('admin.error.network')) }
    finally { setModal(null) }
  }

  // 撤回博客
  const handleDeleteBlog = async (blogId) => {
    if (!blogId) return
    try {
      const res = await apiFetch(`/api/admin/blogs/${blogId}`, {
        method: 'DELETE',
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.detail || t('admin.error.operationFailed')); return }
      setBlogs(prev => prev.filter(b => b.id !== blogId))
    } catch { alert(t('admin.error.network')) }
    finally { setModal(null) }
  }

  // 设置博客分类
  const handleSetCategory = async (blogId, category) => {
    try {
      const res = await apiFetch(`/api/admin/blogs/${blogId}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: category || null }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.operationFailed')); return }
      setBlogs(prev => prev.map(b => b.id === blogId ? { ...b, category: data.category } : b))
    } catch { alert(t('admin.error.network')) }
  }

  // 生成邀请码
  const handleCreateCode = async () => {
    try {
      const res = await apiFetch('/api/admin/invite-codes', {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.generateFailed')); return }
      setNewCode(data.code)
      loadCodes()
    } catch { alert(t('admin.error.network')) }
  }

  // 删除邀请码
  const handleDeleteCode = async (codeId) => {
    if (!codeId) return
    try {
      const res = await apiFetch(`/api/admin/invite-codes/${codeId}`, {
        method: 'DELETE',
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.detail || t('admin.error.deleteFailed')); return }
      setCodes(prev => prev.filter(c => c.id !== codeId))
    } catch { alert(t('admin.error.network')) }
    finally { setModal(null) }
  }

  // 切换可重复使用
  const handleToggleReusable = async (codeId, currentReusable) => {
    try {
      const res = await apiFetch(`/api/admin/invite-codes/${codeId}/reusable`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_reusable: !currentReusable }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.operationFailed')); return }
      setCodes(prev => prev.map(c => c.id === codeId ? { ...c, is_reusable: !currentReusable } : c))
    } catch { alert(t('admin.error.network')) }
  }

  // 保存 / 更新友情链接
  const handleSaveLink = async () => {
    if (!linkForm.name.trim() || !linkForm.url.trim()) { alert(t('admin.error.fillNameAndUrl')); return }
    try {
      const url = linkEditingId ? `/api/admin/friend-links/${linkEditingId}` : '/api/admin/friend-links'
      const method = linkEditingId ? 'PUT' : 'POST'
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: linkForm.name.trim(),
          url: linkForm.url.trim(),
          description: linkForm.description || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.saveFailed')); return }
      setLinkForm({ name: '', url: '', description: '' })
      setLinkEditingId(null)
      loadLinks()
    } catch { alert(t('admin.error.network')) }
  }

  const handleStartEditLink = (link) => {
    setLinkForm({ name: link.name, url: link.url, description: link.description || '' })
    setLinkEditingId(link.id)
  }

  const handleDeleteLink = async (linkId) => {
    if (!linkId) return
    try {
      const res = await apiFetch(`/api/admin/friend-links/${linkId}`, {
        method: 'DELETE',
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.detail || t('admin.error.deleteFailed')); return }
      setLinks(prev => prev.filter(l => l.id !== linkId))
    } catch { alert(t('admin.error.network')) }
    finally { setModal(null) }
  }

  const copyCode = (code, key) => {
    const done = () => {
      setCopiedKey(key)
      clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => done())
    } else {
      done()
    }
  }

  // 自定义联系项（与邮箱/GitHub 并列展示在首页"保持联系"）
  const updateContactItem = (idx, patch) => {
    setSettings(prev => {
      const items = [...(prev.contact_items || [])]
      items[idx] = { ...items[idx], ...patch }
      return { ...prev, contact_items: items }
    })
  }

  const removeContactItem = (idx) => {
    setSettings(prev => ({
      ...prev,
      contact_items: (prev.contact_items || []).filter((_, i) => i !== idx),
    }))
  }

  // LeetCode 调试模式
  const loadLcDebug = () => {
    apiFetch('/api/leetcode/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.bound) {
          setLcDebug(d)
          setLcDebugInput({ easy: d.inc.easy, medium: d.inc.medium, hard: d.inc.hard })
        }
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (authChecked && tab === 'leetcode') loadLcDebug()
  }, [authChecked, tab])

  const handleLcDebugToggle = async (on) => {
    setLcDebugBusy(true)
    try {
      const res = await apiFetch('/api/leetcode/me/debug', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debug_mode: on }),
      })
      const d = await res.json()
      if (!res.ok) { alert(d.detail || t('admin.error.operationFailed')); return }
      setLcDebug(d)
      setLcDebugInput({ easy: d.inc.easy, medium: d.inc.medium, hard: d.inc.hard })
    } catch { alert(t('admin.error.network')) }
    finally { setLcDebugBusy(false) }
  }

  const handleLcDebugSet = async () => {
    setLcDebugBusy(true)
    try {
      const res = await apiFetch('/api/leetcode/me/debug/set', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ easy: Number(lcDebugInput.easy) || 0, medium: Number(lcDebugInput.medium) || 0, hard: Number(lcDebugInput.hard) || 0 }),
      })
      const d = await res.json()
      if (!res.ok) { alert(d.detail || t('admin.error.operationFailed')); return }
      setLcDebug(d)
    } catch { alert(t('admin.error.network')) }
    finally { setLcDebugBusy(false) }
  }

  // 保存站点设置
  const handleSaveSettings = async () => {
    setSettingsSaving(true)
    try {
      const res = await apiFetch('/api/admin/site-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: settings.email.trim() || null,
          github_url: settings.github_url.trim() || null,
          contact_items: (settings.contact_items || [])
            .map(it => ({
              label: (it.label || '').trim(),
              value: (it.value || '').trim(),
              type: it.type === 'text' ? 'text' : 'link',
              icon: it.icon || '',
              description: it.description || '',
            }))
            .filter(it => it.label && it.value),
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('admin.error.saveFailed')); return }
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2500)
    } catch { alert(t('admin.error.network')) }
    finally { setSettingsSaving(false) }
  }

  if (!authChecked) return null

  return (
    <div className="admin-page">
      <Navbar activePage="" />
      <div className="admin-container">
        <div className="admin-header">
          <Link to="/profile" className="admin-back">&larr; {t('admin.backProfile')}</Link>
          <h1 className="admin-title">{t('admin.title')}</h1>
        </div>

        <div className="admin-tabs">
          <button className={`admin-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>{t('admin.tabs.users')}</button>
          <button className={`admin-tab ${tab === 'comments' ? 'active' : ''}`} onClick={() => setTab('comments')}>{t('admin.tabs.comments')}</button>
          <button className={`admin-tab ${tab === 'blogs' ? 'active' : ''}`} onClick={() => setTab('blogs')}>{t('admin.tabs.blogs')}</button>
          <button className={`admin-tab ${tab === 'codes' ? 'active' : ''}`} onClick={() => setTab('codes')}>{t('admin.tabs.codes')}</button>
          <button className={`admin-tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>{t('admin.tabs.links')}</button>
          <button className={`admin-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>{t('admin.tabs.settings')}</button>
          <button className={`admin-tab ${tab === 'leetcode' ? 'active' : ''}`} onClick={() => setTab('leetcode')}>{t('admin.tabs.leetcode')}</button>
          <button className={`admin-tab ${tab === 'bindApps' ? 'active' : ''}`} onClick={() => setTab('bindApps')}>{t('admin.tabs.bindApps')}</button>
          <button className={`admin-tab ${tab === 'downloads' ? 'active' : ''}`} onClick={() => setTab('downloads')}>{t('admin.tabs.downloads')}</button>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {loading && <div className="admin-loading">{t('admin.loading')}</div>}

        {/* 用户管理 */}
        {tab === 'users' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.users.all', { count: users.length })}</h2>
            </div>
            <div className="admin-table">
              <div className="admin-row admin-row-head">
                <span>{t('admin.users.colId')}</span>
                <span>{t('admin.users.colUsername')}</span>
                <span>{t('admin.users.colNickname')}</span>
                <span>{t('admin.users.colRole')}</span>
                <span>{t('admin.users.colRegistered')}</span>
                <span>{t('admin.users.colActions')}</span>
              </div>
              {users.map(u => (
                <div key={u.id} className="admin-row">
                  <span>{u.id}</span>
                  <span className="admin-cell-user">{u.username}</span>
                  <span>{u.nickname || '-'}</span>
                  <span>
                    <span className={`role-badge ${u.role}`}>{u.role === 'admin' ? t('admin.users.admin') : t('admin.users.user')}</span>
                  </span>
                  <span className="admin-cell-time">{fmtDateTimeMinute(u.created_at)}</span>
                  <span className="admin-user-actions">
                    {u.id !== user.id && (
                      <button
                        className="btn-role-toggle"
                        onClick={() => handleSetRole(u.id, u.role === 'admin' ? 'user' : 'admin')}
                      >
                        {u.role === 'admin' ? t('admin.users.demote') : t('admin.users.promote')}
                      </button>
                    )}
                    {u.id === user.id && <span className="admin-self">（{t('admin.users.currentAccount')}）</span>}
                    <button className="btn-role-toggle" onClick={() => handleStartEditUser(u)}>{t('admin.edit')}</button>
                    {u.id !== user.id && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setModal({
                          id: u.id,
                          title: t('admin.users.deleteTitle'),
                          message: t('admin.users.deleteConfirm', { name: u.nickname || u.username }),
                          confirmText: t('admin.users.deleteConfirmText'),
                          onConfirm: () => handleDeleteUser(u.id),
                        })}
                      >
                        {t('admin.delete')}
                      </button>
                    )}
                    </span>
                  {editingUserId === u.id && (
                  <div className="admin-user-edit">
                    <input
                      className="admin-link-input"
                      placeholder={t('admin.users.editNickname')}
                      value={editForm.nickname}
                      onChange={e => setEditForm({ ...editForm, nickname: e.target.value })}
                      maxLength={50}
                    />
                    <input
                      className="admin-link-input"
                      placeholder={t('admin.users.editAvatar')}
                      value={editForm.avatar_url}
                      onChange={e => setEditForm({ ...editForm, avatar_url: e.target.value })}
                      maxLength={500}
                    />
                    <input
                      className="admin-link-input"
                      type="password"
                      placeholder={t('admin.users.editPassword')}
                      value={editForm.password}
                      onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                    />
                    <button className="btn btn-primary btn-sm" onClick={() => handleSaveUser(u.id)}>{t('admin.save')}</button>
                    <button className="btn btn-secondary btn-sm" onClick={handleCancelEditUser}>{t('admin.cancel')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        )}

        {/* 评论管理 */}
        {tab === 'comments' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.comments.all', { count: comments.length })}</h2>
            </div>
            {comments.length === 0 ? (
              <div className="admin-empty">{t('admin.comments.empty')}</div>
            ) : (
              <div className="admin-comment-list">
                {comments.map(c => (
                  <div key={c.id} className="admin-comment-item">
                    <div className="admin-comment-main">
                      <div className="admin-comment-meta">
                        <span className="admin-comment-author">{c.user?.nickname || c.user?.username || t('admin.anonymous')}</span>
                        <span className="admin-comment-blog">
                          {c.project_id ? (
                            <Link to={`/projects/${c.project_id}`} target="_blank" rel="noopener noreferrer">{c.project_title || `#${c.project_id}`}</Link>
                          ) : (
                            <Link to={`/blogs/${c.blog_id}`} target="_blank" rel="noopener noreferrer">{c.blog_title || `#${c.blog_id}`}</Link>
                          )}
                        </span>
                        <span className="admin-cell-time">{fmtDateTimeMinute(c.created_at)}</span>
                      </div>
                      {c.parent_id && (
                        <div className="admin-comment-parent">{t('admin.comments.replyTo', { name: c.parent_username || t('admin.anonymous') })}：{c.parent_content}</div>
                      )}
                      <div className="admin-comment-content">{c.content}</div>
                    </div>
                    <button
                      className="admin-comment-delete-btn"
                      title={t('admin.comments.deleteTitle')}
                      onClick={() => setModal({
                        id: c.id,
                        title: t('admin.comments.deleteModalTitle'),
                        message: t('admin.comments.deleteConfirm'),
                        confirmText: t('admin.comments.deleteConfirmText'),
                        onConfirm: () => handleDeleteComment(c.id),
                      })}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 博客管理 */}
        {tab === 'blogs' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.blogs.all', { count: blogs.length })}</h2>
            </div>
            {blogs.length === 0 ? (
              <div className="admin-empty">{t('admin.blogs.empty')}</div>
            ) : (
              <div className="admin-table">
                <div className="admin-row admin-row-head">
                  <span>{t('admin.blogs.colId')}</span>
                  <span>{t('admin.blogs.colTitle')}</span>
                  <span>{t('admin.blogs.colAuthor')}</span>
                  <span>{t('admin.blogs.colCategory')}</span>
                  <span>{t('admin.blogs.colPublished')}</span>
                  <span>{t('admin.blogs.colActions')}</span>
                </div>
                {blogs.map(b => (
                  <div key={b.id} className="admin-row">
                    <span>{b.id}</span>
                    <span className="admin-cell-title">
                      <Link to={`/blogs/${b.id}`} target="_blank" rel="noopener noreferrer">{b.title}</Link>
                    </span>
                    <span>{b.author?.nickname || b.author?.username || '-'}</span>
                    <span>
                      <CategoryDropdown
                        value={b.category || ''}
                        onChange={(v) => handleSetCategory(b.id, v)}
                        options={CATEGORIES.map(c => ({ value: c, label: c }))}
                        placeholder={t('admin.blogs.uncategorized')}
                        size="sm"
                      />
                    </span>
                    <span className="admin-cell-time">{fmtDateTimeMinute(b.created_at)}</span>
                    <span>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setModal({
                          id: b.id,
                          title: t('admin.blogs.recallTitle'),
                          message: t('admin.blogs.recallConfirm', { title: b.title }),
                          confirmText: t('admin.blogs.recallConfirmText'),
                          onConfirm: () => handleDeleteBlog(b.id),
                        })}
                      >
                        {t('admin.blogs.recall')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 友情链接管理 */}
        {tab === 'links' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.links.all', { count: links.length })}</h2>
            </div>
            <div className="admin-link-form">
              <input
                className="admin-link-input"
                placeholder={t('admin.links.name')}
                value={linkForm.name}
                onChange={e => setLinkForm({ ...linkForm, name: e.target.value })}
              />
              <input
                className="admin-link-input"
                placeholder={t('admin.links.url')}
                value={linkForm.url}
                onChange={e => setLinkForm({ ...linkForm, url: e.target.value })}
              />
              <input
                className="admin-link-input"
                placeholder={t('admin.links.description')}
                value={linkForm.description}
                onChange={e => setLinkForm({ ...linkForm, description: e.target.value })}
              />
              <button className="btn btn-primary btn-sm" onClick={handleSaveLink}>
                {linkEditingId ? t('admin.save') : t('admin.links.add')}
              </button>
              {linkEditingId && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setLinkForm({ name: '', url: '', description: '' })
                    setLinkEditingId(null)
                  }}
                >
                  {t('admin.cancel')}
                </button>
              )}
            </div>
            {links.length === 0 ? (
              <div className="admin-empty">{t('admin.links.empty')}</div>
            ) : (
              <div className="admin-table">
                <div className="admin-row admin-row-head admin-row-links">
                  <span>{t('admin.links.colName')}</span>
                  <span>{t('admin.links.colUrl')}</span>
                  <span>{t('admin.links.colDescription')}</span>
                  <span>{t('admin.links.colActions')}</span>
                </div>
                {links.map(l => (
                  <div key={l.id} className="admin-row admin-row-links">
                    <span>{l.name}</span>
                    <span className="admin-cell-title">
                      <a href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a>
                    </span>
                    <span>{l.description || '-'}</span>
                    <span className="admin-link-actions">
                      <button className="btn-role-toggle" onClick={() => handleStartEditLink(l)}>{t('admin.edit')}</button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setModal({
                          id: l.id,
                          title: t('admin.links.deleteTitle'),
                          message: t('admin.links.deleteConfirm', { name: l.name }),
                          confirmText: t('admin.links.deleteConfirmText'),
                          onConfirm: () => handleDeleteLink(l.id),
                        })}
                      >
                        {t('admin.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 邀请码管理 */}
        {tab === 'codes' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.codes.manage', { count: codes.length })}</h2>
              <button className="btn btn-primary btn-sm" onClick={handleCreateCode}>{t('admin.codes.generate')}</button>
            </div>
            {newCode && (
              <div className="admin-new-code">
                <span>{t('admin.codes.new')}</span>
                <code className="admin-code-highlight">{newCode}</code>
                <button className="btn-copy" onClick={() => copyCode(newCode, 'new')}>{copiedKey === 'new' ? t('admin.codes.copied') : t('admin.codes.copy')}</button>
              </div>
            )}
            {codes.length === 0 ? (
              <div className="admin-empty">{t('admin.codes.empty')}</div>
            ) : (
              <div className="admin-table">
                <div className="admin-row admin-row-head admin-row-codes">
                  <span>{t('admin.codes.colId')}</span>
                  <span>{t('admin.codes.colCode')}</span>
                  <span>{t('admin.codes.colOwner')}</span>
                  <span>{t('admin.codes.colUsed')}</span>
                  <span>{t('admin.codes.colReusable')}</span>
                  <span>{t('admin.codes.colCreated')}</span>
                  <span>{t('admin.codes.colActions')}</span>
                </div>
                {codes.map(c => (
                  <div key={c.id} className="admin-row admin-row-codes">
                    <span>{c.id}</span>
                    <span><code className="admin-code">{c.code}</code></span>
                    <span>{c.owner_username ? c.owner_username : '-'}</span>
                    <span>
                      {c.is_used ? (
                        <span className="check-used" title={t('admin.codes.used')}>&#10003;</span>
                      ) : (
                        <span className="check-unused" title={t('admin.codes.unused')}>&#9711;</span>
                      )}
                    </span>
                    <span>
                      <label className="reusable-toggle">
                        <input
                          type="checkbox"
                          checked={c.is_reusable}
                          onChange={() => handleToggleReusable(c.id, c.is_reusable)}
                        />
                        <span className="reusable-slider"></span>
                      </label>
                    </span>
                    <span className="admin-cell-time">{fmtDateTimeMinute(c.created_at)}</span>
                    <span className="admin-code-actions">
                      <button className="btn-copy" onClick={() => copyCode(c.code, c.id)}>{copiedKey === c.id ? t('admin.codes.copied') : t('admin.codes.copy')}</button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setModal({
                          id: c.id,
                          title: t('admin.codes.deleteTitle'),
                          message: t('admin.codes.deleteConfirm', { code: c.code }),
                          confirmText: t('admin.codes.deleteConfirmText'),
                          onConfirm: () => handleDeleteCode(c.id),
                        })}
                      >
                        {t('admin.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 站点设置 */}
        {tab === 'settings' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.site.all')}</h2>
            </div>
            <div className="admin-settings-form">
              <div className="admin-sections-head">
                <h3 className="admin-sub-title">{t('admin.site.cardHint')}</h3>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setSettings(prev => ({
                    ...prev,
                    contact_items: [...(prev.contact_items || []), { label: '', value: '', type: 'link', icon: '', description: '' }],
                  }))}
                >+ {t('admin.site.addItem')}</button>
              </div>
              {!settings.contact_items || settings.contact_items.length === 0 ? (
                <div className="admin-empty">{t('admin.site.noItems')}</div>
              ) : (
                <div className="admin-sections-list">
                  {settings.contact_items.map((item, i) => (
                    <div key={i} className="admin-section-row">
                      <div className="admin-section-row-fields">
                        <div className="admin-contact-row">
                          <select
                            className="admin-link-input"
                            value={CONTACT_ICON_OPTIONS.some(o => o.key === item.icon) ? item.icon : 'custom'}
                            onChange={e => {
                              const v = e.target.value
                              updateContactItem(i, v === 'custom' ? { icon: '' } : { icon: v })
                            }}
                          >
                            {CONTACT_ICON_OPTIONS.map(o => (
                              <option key={o.key} value={o.key}>{t('icons.contact.' + o.key)}</option>
                            ))}
                          </select>
                          <span className="admin-icon-preview"><ContactIcon icon={item.icon} type={item.type} /></span>
                          {!CONTACT_ICON_OPTIONS.some(o => o.key === item.icon) && (
                            <input
                              className="admin-link-input"
                              placeholder={t('admin.site.customIcon')}
                              value={item.icon || ''}
                              onChange={e => updateContactItem(i, { icon: e.target.value })}
                            />
                          )}
                        </div>
                        <input
                          className="admin-link-input"
                          placeholder={t('admin.site.label')}
                          value={item.label}
                          onChange={e => updateContactItem(i, { label: e.target.value })}
                        />
                        <input
                          className="admin-link-input"
                          placeholder={t('admin.site.description')}
                          value={item.description || ''}
                          onChange={e => updateContactItem(i, { description: e.target.value })}
                        />
                        <input
                          className="admin-link-input"
                          placeholder={t('admin.site.value')}
                          value={item.value}
                          onChange={e => updateContactItem(i, { value: e.target.value })}
                        />
                      </div>
                      <div className="admin-section-row-actions">
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => removeContactItem(i)}
                        >
                          {t('admin.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <button className="btn btn-primary btn-sm" onClick={handleSaveSettings} disabled={settingsSaving}>
                  {settingsSaving ? t('admin.site.saving') : t('admin.save')}
                </button>
                {settingsSaved && <div className="profile-success">&#10003; {t('admin.site.saved')}</div>}
              </div>
              <p className="admin-settings-hint">{t('admin.site.hint')}</p>
            </div>
          </div>
        )}

        {/* LeetCode 调试模式 */}
        {tab === 'leetcode' && !loading && (
          <div className="admin-section">
            <div className="admin-section-head">
              <h2>{t('admin.leetcode.title')}</h2>
            </div>
            <div className="admin-settings-form">
              {!lcDebug || !lcDebug.bound ? (
                <div className="admin-empty">{t('admin.leetcode.notBound')}</div>
              ) : (
                <>
                  <p className="admin-settings-hint">
                    {t('admin.leetcode.hint')}
                  </p>
                  <div className="admin-settings-row">
                    <span className="admin-settings-label">{t('admin.leetcode.mode', { name: lcDebug.leetcode_username })}</span>
                    <button
                      className={`btn btn-sm ${lcDebug.debug_mode ? 'btn-danger' : 'btn-primary'}`}
                      onClick={() => handleLcDebugToggle(!lcDebug.debug_mode)}
                      disabled={lcDebugBusy}
                    >
                      {lcDebug.debug_mode ? t('admin.leetcode.off') : t('admin.leetcode.on')}
                    </button>
                  </div>
                  {lcDebug.debug_mode && (
                    <div className="admin-leetcode-debug">
                      <p className="admin-settings-hint">{t('admin.leetcode.amountHint')}</p>
                      <div className="admin-leetcode-debug-inputs">
                        {[['easy', t('admin.leetcode.easy')], ['medium', t('admin.leetcode.medium')], ['hard', t('admin.leetcode.hard')]].map(([k, label]) => (
                          <label key={k} className="admin-leetcode-debug-field">
                            <span>{label}</span>
                            <input
                              type="number"
                              min="0"
                              className="admin-link-input"
                              value={lcDebugInput[k]}
                              onChange={e => setLcDebugInput(prev => ({ ...prev, [k]: e.target.value }))}
                            />
                          </label>
                        ))}
                      </div>
                      <button className="btn btn-primary btn-sm" onClick={handleLcDebugSet} disabled={lcDebugBusy}>
                        {t('admin.leetcode.apply')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 绑定应用（第三方项目绑定白名单） */}
        {tab === 'bindApps' && <BindAppsPanel />}

        {/* 文件下载（上传文件生成公开下载链接） */}
        {tab === 'downloads' && <AdminDownloadsPanel />}
      </div>

      <Modal
        open={!!modal}
        title={modal?.title || ''}
        message={modal?.message || ''}
        confirmText={modal?.confirmText || t('admin.modal.confirm')}
        danger
        onConfirm={() => modal?.onConfirm?.()}
        onCancel={() => setModal(null)}
      />
    </div>
  )
}

export default AdminPage
