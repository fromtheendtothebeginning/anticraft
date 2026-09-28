import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { changeThemeWithTransition } from '../utils/themeTransition'
import { apiFetch } from '../utils/api'
import { t } from '../i18n'
import './ProfileEdit.css'

function ProfileEdit() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [nickname, setNickname] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'system')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteForm, setDeleteForm] = useState({ username: '', password: '' })
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userStr = localStorage.getItem('user')
    if (!token || !userStr) {
      navigate('/auth')
      return
    }
    // 校验账户是否仍在数据库中存在，不存在则退出登录（401 由 apiFetch 统一处理）
    apiFetch('/api/user/me')
      .then(r => {
        if (r.status === 404) {
          localStorage.removeItem('token')
          localStorage.removeItem('user')
          navigate('/auth')
          return null
        }
        return r.ok ? r.json() : null
      })
      .then(data => {
        if (!data) return
        localStorage.setItem('user', JSON.stringify(data))
        setUser(data)
        setNickname(data.nickname || '')
        setAvatarUrl(data.avatar_url || '')
      })
      .catch(() => {
        // 网络错误时回退到 localStorage
        try {
          const u = JSON.parse(userStr)
          setUser(u)
          setNickname(u.nickname || '')
          setAvatarUrl(u.avatar_url || '')
        } catch { /* localStorage 用户信息损坏时忽略 */ }
      })
  }, [navigate])

  const getInitial = (name) => {
    return name ? name.charAt(0).toUpperCase() : '?'
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSaved(false)

    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nickname: nickname.trim() || null,
          avatar_url: avatarUrl.trim() || null,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || t('profile.saveFailed'))
        return
      }

      // 更新本地存储
      localStorage.setItem('user', JSON.stringify(data))
      setUser(data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      setError(t('profile.networkError'))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (!deleteForm.username.trim() || !deleteForm.password) { alert(t('profile.enterAccountPassword')); return }
    setDeleting(true)
    try {
      const res = await apiFetch('/api/user/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: deleteForm.username.trim(),
          password: deleteForm.password,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || t('profile.deleteFailed')); return }
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      navigate('/')
    } catch {
      alert(t('profile.networkError'))
    } finally {
      setDeleting(false)
    }
  }

  if (!user) return null

  // 返回来源页面（点击头像进入时由 Navbar 记录）；无记录则回首页
  const backTarget = sessionStorage.getItem('profile_redirect') || '/'
  const backLabel = backTarget.startsWith('/blogs')
    ? t('profile.backBlogs')
    : backTarget.startsWith('/projects')
      ? t('profile.backProjects')
      : backTarget !== '/'
        ? t('profile.back')
        : t('profile.backHome')
  const handleBack = () => {
    sessionStorage.removeItem('profile_redirect')
  }

  // 主题模式切换（浅色 ↔ 深色 渐变）
  const handleChangeTheme = (next) => {
    localStorage.setItem('theme', next)
    // 过渡引擎只调用一次；不能派发合成 storage 事件——main.jsx 的监听会再调一次
    // 过渡引擎，彼时 data-theme 已翻转、内联值未写入，快照会读到目标主题导致瞬时跳变
    changeThemeWithTransition(next)
    setTheme(next)
  }

  return (
    <div className="profile-page">
      <div className="profile-grid" />
      <div className="profile-glow pg-1" />
      <div className="profile-glow pg-2" />

      <div className="profile-container">
        {/* 头部 */}
        <div className="profile-header">
          <h1 className="profile-title">{t('profile.title')}</h1>
          <Link to={backTarget} className="profile-back" onClick={handleBack}>&larr; {backLabel}</Link>
        </div>

        {/* 主题模式（浅色 / 深色 / 跟随系统，渐变切换） */}
        <div className="profile-theme">
          <span className="profile-theme-label">{t('profile.theme.label')}</span>
          <div className="profile-theme-toggle">
            {[
              ['system', t('profile.theme.system')],
              ['light', t('profile.theme.light')],
              ['dark', t('profile.theme.dark')],
            ].map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`profile-theme-option ${theme === v ? 'active' : ''}`}
                onClick={() => handleChangeTheme(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 头像预览 */}
        <div className="profile-avatar-section">
          <div className="profile-avatar-preview">
            {avatarUrl ? (
              <img src={avatarUrl} alt="avatar" className="avatar-img" />
            ) : (
              <span className="avatar-letter">{getInitial(nickname || user.username)}</span>
            )}
          </div>
          <div className="profile-avatar-info">
            <p className="avatar-name">{nickname || user.username}</p>
            <p className="avatar-username">@{user.username}</p>
          </div>
        </div>

        {/* 表单 */}
        <div className="profile-form">
          {error && <div className="profile-error">{error}</div>}

          <div className="profile-field">
            <label className="profile-label">{t('profile.nickname')}</label>
            <input
              type="text"
              className="profile-input"
              placeholder={t('profile.nicknamePlaceholder')}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={50}
            />
          </div>

          <div className="profile-field">
            <label className="profile-label">{t('profile.avatarUrl')}</label>
            <input
              type="text"
              className="profile-input"
              placeholder={t('profile.avatarUrlPlaceholder')}
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              maxLength={500}
            />
            <p className="profile-field-hint">{t('profile.avatarHint')}</p>
          </div>

          <button
            className="btn btn-primary profile-save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t('profile.saving') : t('profile.save')}
          </button>

          {saved && <div className="profile-success">&#10003; {t('profile.saveSuccess')}</div>}

          {user.role === 'admin' && (
            <Link to="/admin" className="btn btn-primary profile-admin-btn">
              {t('profile.admin')}
            </Link>
          )}

          <hr className="profile-divider" />

          <button
            className="btn btn-danger profile-logout-btn"
            onClick={() => {
              localStorage.removeItem('token')
              localStorage.removeItem('user')
              navigate('/')
            }}
          >
            {t('profile.logout')}
          </button>

          <button
            className="btn btn-danger profile-delete-btn"
            onClick={() => {
              setDeleteOpen(prev => !prev)
              setDeleteForm({ username: '', password: '' })
            }}
          >
            {t('profile.deleteAccount')}
          </button>

          {deleteOpen && (
            <div className="profile-delete-form">
              <p className="profile-delete-tip">{t('profile.deleteTip')}</p>
              <input
                type="text"
                className="profile-input"
                placeholder={t('profile.username')}
                value={deleteForm.username}
                onChange={e => setDeleteForm({ ...deleteForm, username: e.target.value })}
                maxLength={50}
              />
              <input
                type="password"
                className="profile-input"
                placeholder={t('profile.password')}
                value={deleteForm.password}
                onChange={e => setDeleteForm({ ...deleteForm, password: e.target.value })}
              />
              <div className="profile-delete-actions">
                <button className="btn btn-danger" onClick={handleDeleteAccount} disabled={deleting}>
                  {deleting ? t('profile.deleting') : t('profile.confirmDelete')}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setDeleteOpen(false)
                    setDeleteForm({ username: '', password: '' })
                  }}
                >
                  {t('profile.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ProfileEdit
