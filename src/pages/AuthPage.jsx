import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import { UiIcon } from '../components/Icons'
import './Auth.css'

function AuthPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({ username: '', password: '', confirm: '', inviteCode: '' })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value })
    if (errors[e.target.name]) setErrors({ ...errors, [e.target.name]: '' })
    if (serverError) setServerError('')
  }

  const validate = () => {
    const errs = {}
    if (!form.username.trim()) errs.username = t('auth.validate.usernameRequired')
    if (!form.password) errs.password = t('auth.validate.passwordRequired')
    if (form.password && form.password.length < 6) errs.password = t('auth.validate.passwordMin')
    if (mode === 'register' && form.password !== form.confirm) errs.confirm = t('auth.validate.confirmMismatch')
    if (mode === 'register' && !form.inviteCode.trim()) errs.inviteCode = t('auth.validate.inviteRequired')
    return errs
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setLoading(true)
    setServerError('')

    try {
      const endpoint = mode === 'login' ? '/api/login' : '/api/register'
      const body = {
        username: form.username,
        password: form.password,
        ...(mode === 'register' ? { invite_code: form.inviteCode.trim() } : {}),
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json()

      if (!res.ok) {
        setServerError(data.detail || t('auth.error.requestFailed'))
        return
      }

      localStorage.setItem('token', data.access_token)
      localStorage.setItem('user', JSON.stringify(data.user))
      setSubmitted(true)

      // 注册成功后同样直接跳转首页（后端已返回 token）
      setTimeout(() => navigate('/'), 1500)
    } catch (err) {
      setServerError(t('auth.error.networkError'))
    } finally {
      setLoading(false)
    }
  }

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login')
    setErrors({})
    setServerError('')
    setSubmitted(false)
  }

  return (
    <div className="auth-page">
      <div className="auth-grid" />
      <div className="auth-glow ag-1" />
      <div className="auth-glow ag-2" />

      <div className="auth-container">
        <div className="auth-brand">
          <div className="auth-brand-content">
            <Link to="/" className="auth-brand-logo">
              <img src="/favicon.svg" alt="anticraft" className="brand-logo-img" />
            </Link>
            <h1 className="auth-brand-title">
              <span className="brand-title-en">anticraft</span>
              <span className="brand-title-cn">anticraft</span>
            </h1>
            <p className="auth-brand-desc">
              {t('auth.brand.desc')}
            </p>
            <blockquote className="auth-brand-quote">
              &ldquo;{t('auth.brand.quote1')}<br />{t('auth.brand.quote2')}&rdquo;
            </blockquote>
            <Link to="/" className="auth-back-link">
              &larr; {t('auth.brand.backHome')}
            </Link>
          </div>
        </div>

        <div className="auth-form-wrap">
          <div className="auth-form-card">
            <div className="auth-form-header">
              <div className="auth-tabs">
                <button
                  className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
                  onClick={() => switchMode()}
                  disabled={mode === 'login'}
                >
                  {t('auth.tab.login')}
                </button>
                <button
                  className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
                  onClick={() => switchMode()}
                  disabled={mode === 'register'}
                >
                  {t('auth.tab.register')}
                </button>
              </div>
              <p className="auth-form-hint">
                {mode === 'login'
                  ? t('auth.form.hintLogin')
                  : t('auth.form.hintRegister')}
              </p>
            </div>

            {submitted ? (
              <div className="auth-success">
                <div className="success-icon">&#10003;</div>
                <h3>{mode === 'login' ? t('auth.success.login') : t('auth.success.register')}</h3>
                <p>{t('auth.success.redirecting')}</p>
              </div>
            ) : (
              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                {serverError && (
                  <div className="form-server-error">{serverError}</div>
                )}

                <div className="form-group">
                  <label className="form-label">{t('auth.form.usernameLabel')}</label>
                  <div className="form-input-wrap">
                    <span className="form-input-icon"><UiIcon name="user" size={16} /></span>
                    <input
                      type="text"
                      name="username"
                      className={`form-input ${errors.username ? 'error' : ''}`}
                      placeholder={t('auth.form.usernamePlaceholder')}
                      value={form.username}
                      onChange={handleChange}
                      autoFocus
                    />
                  </div>
                  {errors.username && <span className="form-error">{errors.username}</span>}
                </div>

                <div className="form-group">
                  <label className="form-label">{t('auth.form.passwordLabel')}</label>
                  <div className="form-input-wrap">
                    <span className="form-input-icon"><UiIcon name="lock" size={16} /></span>
                    <input
                      type={showPwd ? 'text' : 'password'}
                      name="password"
                      className={`form-input ${errors.password ? 'error' : ''}`}
                      placeholder={t('auth.form.passwordPlaceholder')}
                      value={form.password}
                      onChange={handleChange}
                    />
                    <button
                      type="button"
                      className="pwd-toggle"
                      onClick={() => setShowPwd(!showPwd)}
                      tabIndex={-1}
                      aria-label={showPwd ? t('auth.form.hidePwd') : t('auth.form.showPwd')}
                    >
                      {showPwd ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </button>
                  </div>
                  {errors.password && <span className="form-error">{errors.password}</span>}
                </div>

                {mode === 'login' && (
                  <div className="form-group form-forgot">
                    <Link to="/reset-password" className="forgot-password-link">{t('auth.form.forgotPassword')}</Link>
                  </div>
                )}

                {mode === 'register' && (
                  <div className="form-group">
                    <label className="form-label">{t('auth.form.confirmLabel')}</label>
                    <div className="form-input-wrap">
                      <span className="form-input-icon"><UiIcon name="lock" size={16} /></span>
                      <input
                        type={showConfirm ? 'text' : 'password'}
                        name="confirm"
                        className={`form-input ${errors.confirm ? 'error' : ''}`}
                        placeholder={t('auth.form.confirmPlaceholder')}
                        value={form.confirm}
                        onChange={handleChange}
                      />
                      <button
                        type="button"
                        className="pwd-toggle"
                        onClick={() => setShowConfirm(!showConfirm)}
                        tabIndex={-1}
                        aria-label={showConfirm ? t('auth.form.hidePwd') : t('auth.form.showPwd')}
                      >
                        {showConfirm ? (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
                          </svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    </div>
                    {errors.confirm && <span className="form-error">{errors.confirm}</span>}
                  </div>
                )}

                {mode === 'register' && (
                  <div className="form-group">
                    <label className="form-label">{t('auth.form.inviteLabel')}</label>
                    <div className="form-input-wrap">
                      <span className="form-input-icon"><UiIcon name="gift" size={16} /></span>
                      <input
                        type="text"
                        name="inviteCode"
                        className={`form-input ${errors.inviteCode ? 'error' : ''}`}
                        placeholder={t('auth.form.invitePlaceholder')}
                        value={form.inviteCode}
                        onChange={handleChange}
                      />
                    </div>
                    {errors.inviteCode && <span className="form-error">{errors.inviteCode}</span>}
                  </div>
                )}

                <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
                  {loading ? t('auth.form.processing') : (mode === 'login' ? t('auth.tab.login') : t('auth.tab.register'))}
                  {!loading && <span className="btn-arrow">&rarr;</span>}
                </button>

                <p className="auth-switch">
                  {mode === 'login' ? (
                    <>{t('auth.switch.noAccount')}
                      <button type="button" className="auth-switch-btn" onClick={switchMode}>{t('auth.switch.toRegister')}</button>
                    </>
                  ) : (
                    <>{t('auth.switch.hasAccount')}
                      <button type="button" className="auth-switch-btn" onClick={switchMode}>{t('auth.switch.toLogin')}</button>
                    </>
                  )}
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default AuthPage
