import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import Modal from '../components/Modal'
import { UiIcon } from '../components/Icons'
import { t } from '../i18n'
import { apiFetch } from '../utils/api'
import { fmtDateTime } from '../utils/format'
import './LeetCodePage.css'

const MEDAL_COLORS = { 0: 'lc-medal-gold', 1: 'lc-medal-silver', 2: 'lc-medal-bronze' }

const Avatar = ({ user, size = 28 }) => {
  if (user.avatar_url) {
    return <img src={user.avatar_url} alt="" className="lc-avatar" style={{ width: size, height: size }} />
  }
  const name = user.nickname || user.username || '?'
  return (
    <span className="lc-avatar lc-avatar-letter" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/* 模式标签：placeholder=true 时未开启渲染灰色占位（我的排名卡片用，切模式不跳版）；
   否则未开启不渲染（排行榜行用，不留空） */
const ModeTagSlot = ({ label, hint, active, className, activeClassName, placeholder = false }) => {
  if (active) {
    return (
      <span className={activeClassName || className} title={hint}>{label}</span>
    )
  }
  if (!placeholder) return null
  return (
    <span
      className={`lc-tag-slot ${className}`}
      title={t('leetcode.mode.slotOffHint', { mode: label })}
    >{label}</span>
  )
}

function LeetCodePage() {
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [me, setMe] = useState(null)
  const [lcUsername, setLcUsername] = useState('')
  const [lcSaving, setLcSaving] = useState(false)
  const [lcError, setLcError] = useState('')
  const [unbindOpen, setUnbindOpen] = useState(false)
  const [unbindText, setUnbindText] = useState('')
  const [unbinding, setUnbinding] = useState(false)
  const [boostConfirm, setBoostConfirm] = useState(false)
  const [boostExitConfirm, setBoostExitConfirm] = useState(false)
  const [boostExitTarget, setBoostExitTarget] = useState(null)

const loadLc = (quick) => {
  apiFetch(`/api/leetcode/me${quick ? '?quick=1' : ''}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d) return
      setMe(d)
    })
    .catch(() => {})
}

const load = () => {
  fetch('/api/leetcode/leaderboard')
    .then(r => r.json())
    .then(d => setBoard(d))
    .catch(() => {})
    .finally(() => setLoading(false))
}

  const loggedIn = !!localStorage.getItem('token')

  useEffect(() => {
    if (!loggedIn) return
    // 榜单首拉由下方轮询 effect 的立即 poll() 承担，避免挂载时重复请求两次
    // 先渲染库内绑定状态（quick 只读库，毫秒级），避免切换页面时闪出绑定表单（实时同步 LeetCode 需 1-3s）
    loadLc(true)
    loadLc()
  }, [])

  // 后台心跳自动同步：前端轮询榜单，发现数据变化时用滚榜动画刷新
  const [refreshKey, setRefreshKey] = useState(0)
  const [updatedTip, setUpdatedTip] = useState(false)
  const prevBoardRef = useRef(null)
  const updatedTimerRef = useRef(null)
  useEffect(() => {
    const poll = () => {
      fetch('/api/leetcode/leaderboard')
        .then(r => r.json())
        .then(d => {
          const key = JSON.stringify(d.users || [])
          if (prevBoardRef.current !== null && prevBoardRef.current !== key) {
            // 数据变化：滚榜动画刷新 + 提示
            setBoard(d)
            setRefreshKey(k => k + 1)
            setUpdatedTip(true)
            clearTimeout(updatedTimerRef.current)
            updatedTimerRef.current = setTimeout(() => setUpdatedTip(false), 4000)
          } else {
            setBoard(d)
          }
          prevBoardRef.current = key
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    poll()
    const timer = setInterval(poll, 30000)
    return () => { clearInterval(timer); clearTimeout(updatedTimerRef.current) }
  }, [])

  const handleBind = async () => {
    const name = lcUsername.trim()
    if (!name) { setLcError(t('leetcode.bind.usernameRequired')); return }
    setLcSaving(true)
    setLcError('')
    try {
      const res = await apiFetch('/api/leetcode/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leetcode_username: name }),
      })
      const d = await res.json()
      if (!res.ok) { setLcError(d.detail || t('leetcode.bind.failed')); return }
      setMe(d)
      setLcUsername('')
      load()
    } catch { setLcError(t('leetcode.networkError')) }
    finally { setLcSaving(false) }
  }

  const handleUnbind = async () => {
    if (unbindText.trim() !== t('leetcode.unbind.confirmText')) return
    setUnbinding(true)
    try {
      const res = await apiFetch('/api/leetcode/me', { method: 'DELETE' })
      if (res.ok) {
        setMe(null)
        localStorage.removeItem(CACHE_KEY)
        setUnbindOpen(false)
        setUnbindText('')
        load()
      }
    } catch {}
    finally { setUnbinding(false) }
  }

  const handleMode = async (patch) => {
    try {
      const res = await apiFetch('/api/leetcode/me/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await res.json()
      if (res.ok && d) { setMe(d); load() }
    } catch {}
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await apiFetch('/api/leetcode/refresh', { method: 'POST' })
    } catch {}
    load()
    setRefreshing(false)
  }

  const users = board?.users || []
  const localUser = (() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null }
  })()
  const myRow = me && me.bound && localUser ? users.find(u => u.user_id === localUser.id) : null
  const myRank = myRow ? users.findIndex(u => u.user_id === myRow.user_id) : -1

  const meCard = (
    <div className={`lc-mine ${me && me.bound ? 'lc-mine-ranked' : ''}`}>
      {!me || !me.bound ? (
        <div className="lc-bind-box">
          <div className="lc-bind-head">
            <span className="lc-mine-label">{t('leetcode.bind.title')}</span>
            {lcError && <span className="lc-bind-error">{lcError}</span>}
          </div>
          <p className="lc-bind-hint">
            {t('leetcode.bind.hint')}
          </p>
          <div className="lc-bind-row">
            <input
              type="text"
              className="lc-bind-input"
              placeholder={t('leetcode.bind.usernamePlaceholder')}
              value={lcUsername}
              onChange={e => setLcUsername(e.target.value)}
              maxLength={100}
            />
            <button className="btn btn-primary lc-bind-btn" onClick={handleBind} disabled={lcSaving}>
              {lcSaving ? t('leetcode.bind.binding') : t('leetcode.bind.bind')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="lc-mine-label">{t('leetcode.mine.myRank')}</span>
          <span className="lc-mine-rank">#{myRank >= 0 ? myRank + 1 : '-'}</span>
          <span className="lc-mine-user">
            <Avatar user={{ avatar_url: myRow ? myRow.avatar_url : null, nickname: myRow ? myRow.nickname : null, username: myRow ? myRow.username : null }} />
            <span className="lc-nickname">{myRow ? (myRow.nickname || myRow.username) : me.leetcode_username}</span>
            <a
              className="lc-username lc-username-link"
              href={`https://leetcode.cn/u/${encodeURIComponent(me.leetcode_username)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('leetcode.link.viewProfile')}
              onClick={e => e.stopPropagation()}
            >@{me.leetcode_username}</a>
            <ModeTagSlot
              active={!!me.difficulty_mode}
              label={t('leetcode.mode.difficulty')}
              hint={t('leetcode.mode.difficultyHint')}
              className="lc-tag-hard"
              activeClassName="lc-hard-tag"
              placeholder
            />
            <ModeTagSlot
              active={!!me.serious_mode}
              label={t('leetcode.mode.serious')}
              hint={t('leetcode.mode.seriousHint')}
              className="lc-tag-serious"
              activeClassName="lc-serious-tag"
              placeholder
            />
            <ModeTagSlot
              active={!!me.boost_mode}
              label={t('leetcode.mode.boost')}
              hint={t('leetcode.mode.boostHint')}
              className="lc-tag-boost"
              activeClassName={`lc-boost-tag ${me.score > 0 ? 'lc-boost-tag-gold' : ''}`}
              placeholder
            />
            {me.debug_mode && (
              <span className="lc-debug-tag" title={t('leetcode.mode.debugHint')}>{t('leetcode.mode.debug')}</span>
            )}
          </span>
          <span className="lc-mine-stats">
            {t('leetcode.mine.statsIncrement', { easy: me.inc.easy, medium: me.inc.medium, hard: me.inc.hard, total: me.total_inc })}
            <br />
            {t('leetcode.mine.statsCumulative', { easy: me.cur.easy, medium: me.cur.medium, hard: me.cur.hard })}
            <b>{t('leetcode.mine.statsTotal', { total: me.cur.easy + me.cur.medium + me.cur.hard })}</b>
          </span>
          <span className="lc-mine-score">{t('leetcode.mine.score', { score: me.score })}</span>
          <div className="lc-mine-actions">
            <label className="lc-mode-toggle" title={t('leetcode.mode.difficultyHint')}>
              <input
                type="checkbox"
                checked={!!me.difficulty_mode}
                onChange={e => {
                  if (e.target.checked && me.boost_mode) {
                    setBoostExitTarget('difficulty')
                    setBoostExitConfirm(true)
                    return
                  }
                  handleMode({ difficulty_mode: e.target.checked })
                }}
              />
              {t('leetcode.mode.difficulty')}
            </label>
            <label className="lc-mode-toggle" title={t('leetcode.mode.seriousHint')}>
              <input
                type="checkbox"
                checked={!!me.serious_mode}
                onChange={e => {
                  if (e.target.checked && me.boost_mode) {
                    setBoostExitTarget('serious')
                    setBoostExitConfirm(true)
                    return
                  }
                  handleMode({ serious_mode: e.target.checked })
                }}
              />
              {t('leetcode.mode.serious')}
            </label>
            <label className="lc-mode-toggle" title={t('leetcode.mode.boostToggleHint')}>
              <input
                type="checkbox"
                checked={!!me.boost_mode}
                onChange={e => {
                  if (e.target.checked) setBoostConfirm(true)
                  else setBoostExitConfirm(true)
                }}
              />
              {t('leetcode.mode.boost')}
            </label>
            <button className="lc-unbind-btn" onClick={() => setUnbindOpen(true)}>{t('leetcode.unbind.title')}</button>
          </div>
          {unbindOpen && (
            <div className="lc-unbind-confirm">
              <p className="lc-unbind-tip">{t('leetcode.unbind.tip')}</p>
              <div className="lc-unbind-row">
                <input
                  type="text"
                  className="lc-bind-input"
                  placeholder={t('leetcode.unbind.confirmText')}
                  value={unbindText}
                  onChange={e => setUnbindText(e.target.value)}
                />
                <button
                  className="btn btn-danger lc-unbind-confirm-btn"
                  disabled={unbindText.trim() !== t('leetcode.unbind.confirmText') || unbinding}
                  onClick={handleUnbind}
                >
                  {unbinding ? t('leetcode.unbind.unbinding') : t('leetcode.unbind.confirmText')}
                </button>
                <button
                  className="lc-unbind-cancel"
                  onClick={() => { setUnbindOpen(false); setUnbindText('') }}
                >
                  {t('leetcode.unbind.cancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className="lc-page">
      <Navbar activePage="leetcode" />
      <div className="lc-main">
        {!loggedIn ? (
          <div className="lc-login-hint">
            <p>{t('leetcode.loginHint')}</p>
            <Link to="/login" className="btn btn-primary">{t('leetcode.goLogin')}</Link>
          </div>
        ) : (
        <>
        <div className="lc-header">
          <h1 className="lc-title">{t('leetcode.title')}</h1>
          <p className="lc-subtitle">
            {t('leetcode.subtitle')}
          </p>
        </div>

        <div className="lc-toolbar">
          <button className="btn btn-primary lc-refresh-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? t('leetcode.refresh.syncing') : t('leetcode.refresh.label')}
          </button>
          <span className="lc-updated">
            {board ? t('leetcode.updatedAt', { time: fmtDateTime(board.generated_at) }) : ''}
          </span>
          {updatedTip && <span className="lc-updated-tip">{t('leetcode.updated')}</span>}
          <span className="lc-heartbeat-hint" title={t('leetcode.heartbeatHint')}>{t('leetcode.heartbeat')}</span>
        </div>

        {meCard}

        {loading ? (
          <div className="lc-loading">{t('leetcode.loading')}</div>
        ) : users.length === 0 ? (
          <div className="lc-empty">
            <p>{t('leetcode.empty')}</p>
          </div>
        ) : (
          <div key={refreshKey} className="lc-board">
            <div className="lc-row lc-row-head">
              <span className="lc-col-rank">{t('leetcode.col.rank')}</span>
              <span className="lc-col-user">{t('leetcode.col.user')}</span>
              <span className="lc-col-stat">{t('leetcode.col.easy')}</span>
              <span className="lc-col-stat">{t('leetcode.col.medium')}</span>
              <span className="lc-col-stat">{t('leetcode.col.hard')}</span>
              <span className="lc-col-stat">{t('leetcode.col.total')}</span>
              <span className="lc-col-score">{t('leetcode.col.score')}</span>
            </div>
            {users.map((u, i) => (
              <div
                key={u.user_id}
                className={`lc-row ${me && me.bound && localUser && u.user_id === localUser.id ? 'lc-row-self' : ''}`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="lc-col-rank">
                  {i < 3 ? (
                    <span className={`lc-medal ${MEDAL_COLORS[i]}`} title={t('leetcode.rank', { n: i + 1 })}>
                      <UiIcon name="medal" size={20} />
                    </span>
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="lc-col-user">
                  <Avatar user={u} />
                  <span className="lc-user-info">
                    <span className="lc-user-line">
                      <span className="lc-nickname">{u.nickname || u.username}</span>
                      <a
                        className="lc-username lc-username-link"
                        href={`https://leetcode.cn/u/${encodeURIComponent(u.leetcode_username)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('leetcode.link.viewProfile')}
                        onClick={e => e.stopPropagation()}
                      >@{u.leetcode_username}</a>
                    </span>
                    <span className="lc-user-tags">
                      <ModeTagSlot
                        active={!!u.difficulty_mode}
                        label={t('leetcode.mode.difficulty')}
                        hint={t('leetcode.mode.difficultyHint')}
                        className="lc-tag-hard"
                        activeClassName="lc-hard-tag"
                      />
                      <ModeTagSlot
                        active={!!u.serious_mode}
                        label={t('leetcode.mode.serious')}
                        hint={t('leetcode.mode.seriousHint')}
                        className="lc-tag-serious"
                        activeClassName="lc-serious-tag"
                      />
                      <ModeTagSlot
                        active={!!u.boost_mode}
                        label={t('leetcode.mode.boost')}
                        hint={t('leetcode.mode.boostHint')}
                        className="lc-tag-boost"
                        activeClassName={`lc-boost-tag ${u.score > 0 ? 'lc-boost-tag-gold' : ''}`}
                      />
                      {u.debug_mode && (
                        <span className="lc-debug-tag" title={t('leetcode.mode.debugHint')}>{t('leetcode.mode.debug')}</span>
                      )}
                    </span>
                  </span>
                </span>
                <span className="lc-col-stat"><span className="lc-stat-label">{t('leetcode.col.easy')} </span>{u.easy}</span>
                <span className="lc-col-stat"><span className="lc-stat-label">{t('leetcode.col.medium')} </span>{u.medium}</span>
                <span className="lc-col-stat"><span className="lc-stat-label">{t('leetcode.col.hard')} </span>{u.hard}</span>
                <span className="lc-col-stat lc-col-total"><span className="lc-stat-label">{t('leetcode.col.total')} </span>{u.total}</span>
                <span className="lc-col-score"><span className="lc-stat-label">{t('leetcode.col.score')} </span>{u.score}</span>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      <Modal
        open={boostConfirm}
        title={t('leetcode.boost.title')}
        message={t('leetcode.boost.message')}
        confirmText={t('leetcode.boost.confirm')}
        danger
        onConfirm={() => {
          setBoostConfirm(false)
          handleMode({ boost_mode: true })
        }}
        onCancel={() => setBoostConfirm(false)}
      />
      <Modal
        open={boostExitConfirm}
        title={t('leetcode.boostExit.title')}
        message={boostExitTarget
          ? t('leetcode.boostExit.messageWithTarget', { mode: boostExitTarget === 'difficulty' ? t('leetcode.mode.difficulty') : t('leetcode.mode.serious'), targetDesc: boostExitTarget === 'difficulty' ? t('leetcode.boostExit.targetDifficulty') : t('leetcode.boostExit.targetSerious') })
          : t('leetcode.boostExit.messageDefault')}
        confirmText={t('leetcode.boostExit.confirm')}
        danger
        onConfirm={() => {
          setBoostExitConfirm(false)
          const target = boostExitTarget
          setBoostExitTarget(null)
          if (target === 'difficulty') handleMode({ difficulty_mode: true })
          else if (target === 'serious') handleMode({ serious_mode: true })
          else handleMode({ boost_mode: false })
        }}
        onCancel={() => { setBoostExitConfirm(false); setBoostExitTarget(null) }}
      />
    </div>
  )
}

export default LeetCodePage
