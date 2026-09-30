import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import Modal from '../../components/Modal'
import CategoryDropdown from '../../components/CategoryDropdown'
import { t } from '../../i18n'
import { apiFetch } from '../../utils/api'
import { getUserData, putUserData } from '../../utils/userData'
import '../../pages/ToolParsePage.css'
import './CampusServicePage.css'

const STUDENT_LABELS = [
  ['xh', 'campusService.score.student.xh'],
  ['xm', 'campusService.score.student.xm'],
  ['nj', 'campusService.score.student.nj'],
  ['bmmc', 'campusService.score.student.bmmc'],
  ['zymc', 'campusService.score.student.zymc'],
  ['bjmc', 'campusService.score.student.bjmc'],
]

const VALID_FEATURES = ['score', 'grades', 'ecard', 'electricity', 'activities']

const KIND_LABELS = {
  score: 'campusService.query.score',
  grades: 'campusService.query.grades',
  ecard: 'campusService.query.ecard',
  electricity: 'campusService.electricity.name',
  activities: 'campusService.query.activities',
}

// 第二课堂达标分数（2025 级）
const TOTAL_TARGET = 8
// 一级板块达标：美育 / 健康教育只看总分，不展开
const SCORE_TARGETS = [
  { keywords: ['德育'], target: 3.0 },
  { keywords: ['劳育'], target: 3.0 },
  { keywords: ['美育'], target: 1.0, noExpand: true },
  { keywords: ['健康'], target: 1.0, noExpand: true },
]
// 二级板块达标（仅德育 / 劳育有）
const SUB_TARGETS = [
  { keywords: ['讲座', '报告', '讲坛', '沙龙', '主题教育', '团日'], target: 1.8 },
  { keywords: ['安全教育', '安全'], target: 0.2 },
  { keywords: ['志愿', '公益'], target: 1.0 },
  { keywords: ['三创', '竞赛', '论文', '专利', '技能证书', '社团活动'], target: 1.5 },
  { keywords: ['社会实践', '挂职', '学长导航', '境外交流'], target: 1.0 },
  { keywords: ['劳动教育', '劳动课堂'], target: null },
  { keywords: ['校园文明', '文明寝室'], target: null },
]

function matchScoreTarget(groupName) {
  if (!groupName) return null
  for (const t of SCORE_TARGETS) {
    if (t.keywords.some(kw => groupName.includes(kw))) return t
  }
  return null
}

function matchSubTarget(rowName) {
  if (!rowName) return null
  for (const t of SUB_TARGETS) {
    if (t.keywords.some(kw => rowName.includes(kw))) return t
  }
  return null
}

// ── 电费历史曲线：按视图聚合成点 ──
const DAY_MS = 86400000

// 日视图：某一天 0-23 时每小时的余额（元），该小时没查询就沿用上一小时的值（前值填充）
// 取 balance 非空的记录（充值后复查余额失败的记录跳过），换算成本机时间戳后升序
function hourlyBalanceSeries(records) {
  const pts = (records || [])
    .filter(r => r && r.time && r.balance != null)
    .map(r => ({ ts: new Date(r.time).getTime(), v: Number(r.balance) }))
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts)
  if (pts.length === 0) return { series: [], date: '' }

  // 目标日 = 最后一条有效记录所在的本机自然日 00:00–24:00
  const last = new Date(pts[pts.length - 1].ts)
  const dayStart = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime()
  const date = `${last.getMonth() + 1}月${last.getDate()}日`

  // 游标沿升序记录推进：cursor = 已进入当前小时的最后一条记录，i = 尚未排入的第一条记录。
  // 当天之前的记录先全部排入 cursor，于是「昨天下班查的余额」会自然延续到今天首次查询（跨天继承）
  let cursor = -1
  let i = 0
  for (; i < pts.length && pts[i].ts < dayStart; i++) cursor = i

  const series = []
  for (let h = 0; h < 24; h++) {
    const he = dayStart + (h + 1) * 3600000 // 该小时结束时刻
    while (i < pts.length && pts[i].ts < he) { cursor = i; i++ }
    // cursor 仍为 -1（该小时之前一条记录都没有）时用最早那条的余额兜底
    series.push({ label: `${h}时`, v: pts[cursor >= 0 ? cursor : 0].v })
  }
  return { series, date }
}

// 周 / 月视图：最近 days 天，每天的值 = 当天所有有效记录里余额的最小值（元），label 为 M/D
// 结束日 = 最后一条有效记录所在的本机自然日，向前推 days-1 天；某天没记录沿用前一天的值，
// 窗口开头几天没记录时用「窗口内最早有数据那天」的值兜底（等价于把最早已知余额向前平推）
function dailyMinSeries(records, days) {
  const pts = (records || [])
    .filter(r => r && r.time && r.balance != null)
    .map(r => ({ ts: new Date(r.time).getTime(), v: Number(r.balance) }))
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts)
  if (pts.length === 0) return { series: [], note: '' }

  const dayKey = ts => {
    const d = new Date(ts)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const minOfDay = new Map()
  for (const p of pts) {
    const k = dayKey(p.ts)
    minOfDay.set(k, Math.min(minOfDay.has(k) ? minOfDay.get(k) : Infinity, p.v))
  }

  const last = new Date(pts[pts.length - 1].ts)
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate())
  const values = []
  const labels = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)
    const k = d.getTime()
    values.push(minOfDay.has(k) ? minOfDay.get(k) : null)
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
  }

  const firstIdx = values.findIndex(v => v != null)
  let prev = values[firstIdx] // 窗口开头兜底值 = 最早有数据那天的值
  const series = values.map((v, i) => {
    if (v != null) prev = v
    return { label: labels[i], v: prev }
  })
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1))
  const note = `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`
  return { series, note }
}

// 日 = 当天 0-23 时每小时余额（前值填充）；周 = 最近 7 天每天最低余额；月 = 最近 30 天每天最低余额
// 返回 { series, note }：note 为标题小字所需说明（日视图 =「M月D日」，周 / 月 = 窗口起止），无数据时为空串
// balance 为空的记录（充值后复查余额失败）跳过，避免被当成 0 拉低曲线
function buildSeries(records, view) {
  if (view === 'day') {
    const { series, date } = hourlyBalanceSeries(records)
    return { series, note: date }
  }
  return dailyMinSeries(records, view === 'week' ? 7 : 30)
}

// ── 周期平均每天耗电（本周 / 本月 / 近 7 天） ──
// 周期起点用本地时间：本周 = 本周一 00:00:00；本月 = 本月 1 日 00:00:00；近 7 天 = 含今天往前推 6 天 00:00
function periodStart(view) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (view === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // 周一为一周起点
  else if (view === 'last7') d.setDate(d.getDate() - 6)
  else d.setDate(1)
  return d.getTime()
}

// 耗电 = (首条余额 - 末条余额) + 首条之后所有记录的充值额（充值让余额变大，不算消耗）
// 不参与首末条的记录（balance 为空 / 充值记录）其充值额仍计入；周期内比较点不足 2 个返回 null
function avgDailyUsage(records, view) {
  const start = periodStart(view)
  const pts = (records || [])
    .filter(r => r && r.time)
    .map(r => ({
      ts: new Date(r.time).getTime(),
      balance: r.balance != null ? Number(r.balance) : null,
      recharge: Number(r.recharge) || 0,
    }))
    .filter(p => Number.isFinite(p.ts) && p.ts >= start)
    .sort((a, b) => a.ts - b.ts)

  // 比较点：余额有效且本条不是充值记录。充值记录里的余额可能是学校系统还没入账时
  // 复查到的旧值（实测充值 50 元后复查仍返回充值前余额），拿它当基准会把充值额当成耗电。
  const isPoint = p => p.balance != null && Number.isFinite(p.balance) && p.recharge <= 0
  const valid = pts.filter(isPoint)
  if (valid.length < 2) return null

  // 耗电按相邻两个「有效余额点」之间的余额变化累计，并把区间内的充值额算进来：
  //   下降段：耗电 = 下降幅度 + 区间充值（充值花掉的也要算）
  //   上升段：耗电 = 充值额 - 上升幅度（被充值掩盖的净耗电）；充值额未知（学校 App 充的）时按 0 计
  // 但充值额只有在余额真涨过充值前水平后才计入：没涨说明系统尚未入账，计入会把充值当成耗电。
  let used = 0
  let prev = null
  let pending = 0 // 已记录、但还没在余额里体现出来的充值额
  let pendingBase = null // 充值前的余额水平，用来判断是否已入账
  for (const p of pts) {
    if (p.recharge > 0) {
      if (prev == null) continue // 前面没有余额基准，这笔充值归属不到任何区间
      if (pending === 0) pendingBase = prev.balance
      pending += p.recharge
      continue
    }
    if (!isPoint(p)) continue
    if (prev != null) {
      const credited = pending > 0 && p.balance > pendingBase ? pending : 0
      const delta = prev.balance - p.balance
      used += delta > 0 ? delta + credited : Math.max(0, credited + delta)
      if (credited > 0) { pending = 0; pendingBase = null }
    }
    prev = p
  }
  const days = Math.max(1, (valid[valid.length - 1].ts - valid[0].ts) / DAY_MS) // 不足一天算 1 天
  return used / days
}

// ── 简易 SVG 折线图 ──
function MiniLineChart({ data, view }) {
  const { series } = buildSeries(data, view)
  // 减弱动效偏好：不做入场动画，直接显示最终状态
  const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (series.length === 0) return null

  const W = 560, H = 180, PAD = { t: 20, r: 20, b: 30, l: 50 }
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b

  const vals = series.map(s => s.v)
  const minV = Math.min(...vals), maxV = Math.max(...vals)
  const range = maxV - minV || 1

  const points = series.map((s, i) => ({
    x: PAD.l + (i / Math.max(series.length - 1, 1)) * cw,
    y: PAD.t + ch - ((s.v - minV) / range) * ch,
    label: s.label,
  }))

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')

  // Y 轴刻度（4 条）
  const yTicks = [0, 0.33, 0.67, 1].map(f => ({
    v: Math.round((minV + f * range) * 10) / 10,
    y: PAD.t + ch - f * ch,
  }))

  // X 轴标签（均匀取样，始终保留最后一个点）
  const step = Math.max(1, Math.floor(points.length / 5))
  const xLabels = points.filter((_, i) => i % step === 0 || i === points.length - 1)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cs-elec-svg" preserveAspectRatio="xMidYMid meet">
      {yTicks.map((tk, i) => (
        <g key={i}>
          <line x1={PAD.l} y1={tk.y} x2={W - PAD.r} y2={tk.y} stroke="var(--border-color)" strokeDasharray="3,3" />
          <text x={PAD.l - 6} y={tk.y + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">{tk.v}</text>
        </g>
      ))}
      {xLabels.map((p, i) => (
        <text key={i} x={p.x} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{p.label}</text>
      ))}
      {/* pathLength=1：用 CSS 的 dasharray/dashoffset 做自绘动画，无需测量真实路径长度 */}
      <path
        d={pathD}
        fill="none"
        stroke="var(--accent-1)"
        strokeWidth="2"
        strokeLinejoin="round"
        pathLength={reduceMotion ? undefined : 1}
        className={reduceMotion ? undefined : 'cs-elec-line'}
      />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill="var(--accent-1)"
          className={reduceMotion ? undefined : 'cs-elec-dot'}
          style={reduceMotion ? undefined : { animationDelay: `${Math.round((i / Math.max(points.length - 1, 1)) * 350)}ms` }}
        />
      ))}
    </svg>
  )
}

// 减弱动效偏好（判定同 MiniLineChart）：为真时 toast 不做入场动画
function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {})
  }
}

// ── 第二课堂活动：报名状态（学校时间为北京时间，按本机时间比较） ──
// open=报名中 / soon=即将报名 / closed=报名已结束 / none=无需报名（无报名窗口）
function bmStateOf(a) {
  if (!a.bm_start || !a.bm_end) return 'none'
  const s = new Date(String(a.bm_start).replace(' ', 'T'))
  const e = new Date(String(a.bm_end).replace(' ', 'T'))
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 'none'
  const now = new Date()
  if (now < s) return 'soon'
  if (now <= e) return 'open'
  return 'closed'
}

// 学校时间 "2026-09-17 00:00:00" → "09-17 00:00"（年份固定当年，省略）
function fmtDt(s) {
  if (!s) return ''
  return String(s).slice(5, 16)
}

// ── 上次查询结果缓存（云端 /api/user-data，按账号隔离，换设备也在） ──
const CACHE_KEYS = { score: 'campus_cache_score', grades: 'campus_cache_grades', activities: 'campus_cache_activities' }

// 一次性清理旧版按 user.id 拼 key 的 localStorage 缓存（数据已迁云端）
let _legacySwept = false
function sweepLegacyCache() {
  if (_legacySwept) return
  _legacySwept = true
  try {
    const stale = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('campus_cache_')) stale.push(k)
    }
    stale.forEach(k => localStorage.removeItem(k))
  } catch { /* 忽略 */ }
}

// ── 实践学分：数字增长动画（0 → 终值，约 700ms 缓出；值变化时重播）──
function CountUp({ value, duration = 700 }) {
  const raw = value != null ? value : '—'
  const target = Number(value)
  const [progress, setProgress] = useState(
    () => (Number.isFinite(target) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1)
  )

  useEffect(() => {
    if (!Number.isFinite(target) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(1)
      return
    }
    setProgress(0)
    let raf = 0
    const t0 = performance.now()
    const tick = now => {
      const p = Math.max(0, Math.min(1, (now - t0) / duration)) // rAF 时间戳可能早于 t0，需夹紧
      setProgress(p)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  if (!Number.isFinite(target) || progress >= 1) return raw
  return (target * (1 - Math.pow(1 - progress, 3))).toFixed(1)
}

// ── 第二课堂分组：受控手风琴（展开状态各自独立，动画见 .cs-group-body）──
function ScoreGroup({ group, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const target = matchScoreTarget(group.name)
  const actual = group.subtotal != null ? Number(group.subtotal) : null
  const targetVal = target ? target.target : null
  const reached = actual != null && targetVal != null && actual >= targetVal
  const subCls = targetVal != null ? (reached ? 'cs-group-ok' : 'cs-group-warn') : ''
  return (
    <div className={`cs-group${open ? ' is-open' : ''}`}>
      <button type="button" className="cs-group-summary" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="cs-group-name">{group.name}</span>
        {group.subtotal != null && (
          <span className={`cs-group-sub ${subCls}`}>{actual} / {targetVal != null ? targetVal : '—'}</span>
        )}
      </button>
      <div className={`cs-group-body${open ? ' is-open' : ''}`}>
        <div className="cs-group-body-inner">
          {group.rows.length === 0 ? (
            <p className="cs-empty">{t('campusService.score.empty')}</p>
          ) : (
            <table className="cs-mini-table">
              <tbody>
                {group.rows.map((r, ri) => {
                  const sub = matchSubTarget(r.name)
                  return (
                    <tr key={ri}>
                      <td>{r.name}</td>
                      {sub && sub.target != null ? (
                        <td className={`cs-mini-val ${Number(r.value) >= sub.target ? 'cs-sub-ok' : 'cs-sub-warn'}`}>
                          {r.value != null && r.value !== '' ? r.value : '—'} / {sub.target}
                        </td>
                      ) : (
                        <td className="cs-mini-val">{r.value != null && r.value !== '' ? r.value : '—'}</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 第二课堂活动卡片：报名状态标签 + 展开说明/报名方式 ──
function ActivityCard({ a, detail, onExpand }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const st = bmStateOf(a)
  const stMeta = {
    open: { key: 'campusService.activities.bmOpen', cls: 'cs-badge-ok' },
    soon: { key: 'campusService.activities.bmSoon', cls: 'cs-badge-busy' },
    closed: { key: 'campusService.activities.bmClosed', cls: 'cs-badge-muted' },
    none: { key: 'campusService.activities.bmNone', cls: 'cs-badge-muted' },
  }[st]
  const d = detail && detail.data
  const hdms = (d && d.hdms) || a.hdms || ''
  const quota = (d && d.quota) || a.quota
  const signup = (d && d.signup) || a.signup || {}
  const hasSignup = (signup.qq || []).length > 0 || (signup.phone || []).length > 0
    || (signup.tips || []).length > 0 || (signup.contact_lines || []).length > 0

  const handleToggle = () => {
    setOpen(v => !v)
    // 展开且说明还没拿到（列表接口没带 hdms）→ 拉取详情
    if (!open && !hdms && !(detail && (detail.loading || detail.data))) onExpand(a.id)
  }

  const handleCopy = (text) => {
    copyText(text)
    setCopied(text)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="cs-act-card">
      <button type="button" className="cs-act-head" aria-expanded={open} onClick={handleToggle}>
        <span className="cs-act-tags">
          <span className={`cs-badge ${stMeta.cls}`}>{t(stMeta.key)}</span>
          {a.dlmc && <span className="cs-badge cs-badge-muted">{a.dlmc}</span>}
          {a.lbmc && <span className="cs-badge cs-badge-muted">{a.lbmc}</span>}
          {a.campus && a.campus !== '未标注' && <span className="cs-badge cs-badge-muted">{a.campus}</span>}
          {a.backfill && <span className="cs-badge cs-act-backfill">{t('campusService.activities.backfill')}</span>}
        </span>
        <span className="cs-act-name">{a.name}</span>
        <span className="cs-act-meta">
          {a.host && <span>{t('campusService.activities.host')}{a.host}</span>}
          {quota && <span>{t('campusService.activities.quota')}{quota}</span>}
        </span>
        <span className="cs-act-times">
          {a.start && <span>{t('campusService.activities.time')}{fmtDt(a.start)} ~ {fmtDt(a.end) || '…'}</span>}
          {(a.bm_start || a.bm_end) && (
            <span>{t('campusService.activities.bmWindow')}{fmtDt(a.bm_start) || '…'} ~ {fmtDt(a.bm_end) || '…'}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="cs-act-body">
          {hasSignup && (
            <div className="cs-act-signup">
              <span className="cs-act-signup-label">{t('campusService.activities.signup')}</span>
              {(signup.qq || []).map(q => (
                <span key={q} className="cs-act-signup-row">
                  QQ{t('campusService.activities.group')}{q}
                  <button type="button" className="cs-act-copy" onClick={() => handleCopy(q)}>
                    {copied === q ? t('campusService.proxy.copied') : t('campusService.proxy.copy')}
                  </button>
                </span>
              ))}
              {(signup.phone || []).length > 0 && (
                <span className="cs-act-signup-row">{signup.phone.join(' / ')}</span>
              )}
              {(signup.contact_lines || []).map(l => (
                <span key={l} className="cs-act-signup-row">{l}</span>
              ))}
              {(signup.tips || []).length > 0 && (
                <span className="cs-act-signup-row">{signup.tips.join(' · ')}</span>
              )}
            </div>
          )}
          {detail && detail.loading ? (
            <p className="cs-empty">{t('campusService.activities.detailLoad')}</p>
          ) : hdms ? (
            <p className="cs-act-hdms">{hdms}</p>
          ) : (
            <p className="cs-empty">{(detail && detail.err) || t('campusService.activities.hdmsEmpty')}</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function CampusServicePage() {
  const { feature } = useParams()
  const isSubPage = VALID_FEATURES.includes(feature)
  const navigate = useNavigate()
  const token = localStorage.getItem('token')

  // ── VPN 连接状态 ──
  const [status, setStatus] = useState(null)
  const [unavailable, setUnavailable] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [credBanner, setCredBanner] = useState(false)
  const [copyLabel, setCopyLabel] = useState('') // 显示「已复制」的 key

  // ── 查询结果 ──
  const [scoreData, setScoreData] = useState(null)
  const [gradeData, setGradeData] = useState(null)
  const [gradeTerms, setGradeTerms] = useState([])
  const [gradeTerm, setGradeTerm] = useState('')
  const [ecardData, setEcardData] = useState(null)
  const [ecardCount, setEcardCount] = useState(0)
  const [qBusy, setQBusy] = useState(null)
  const [errMsg, setErrMsg] = useState('')
  const [cacheFeature, setCacheFeature] = useState('') // 已恢复过缓存的子页面

  // ── 第二课堂活动 ──
  const [actData, setActData] = useState(null)
  const [actViaPool, setActViaPool] = useState(false) // 本次数据来自共享会话池
  const [actFilter, setActFilter] = useState('all') // all | open | soon | closed
  const [actSearch, setActSearch] = useState('')
  const [actDetails, setActDetails] = useState({}) // 活动id -> { loading | data | err }
  const [vpnConnecting, setVpnConnecting] = useState(false) // 后端自动连接 VPN / 等待共享会话（值为触发查询的 kind）

  // ── 电费 ──
  const [elecData, setElecData] = useState(null)
  const [elecHistory, setElecHistory] = useState([])
  const [elecHistSeq, setElecHistSeq] = useState(0) // 每次拿到新历史数据 +1（折线图入场动画的重播信号）
  const [elecView, setElecView] = useState('day') // day | week | month
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [rechargeAmt, setRechargeAmt] = useState('')
  const [rechargeBusy, setRechargeBusy] = useState(false)
  const [rechargeMsg, setRechargeMsg] = useState('')
  const [rechargeToast, setRechargeToast] = useState('') // 充值成功后的页面级提示
  const toastTimerRef = useRef(null)

  // ── 验证码两段式 ──
  const [captcha, setCaptcha] = useState(null)
  const [capInput, setCapInput] = useState('')
  const [autoCaptchaUsed, setAutoCaptchaUsed] = useState(false)

  // 派生状态（useEffect 依赖用，必须在 useEffect 之前声明）
  const connected = !!(status && !unavailable && status.status === 'connected')

  // 请求竞态防护
  const epochRef = useRef(0)
  const busyRef = useRef(false)

  // 页面级 toast：显示 3 秒后自动消失；新提示覆盖旧提示或组件卸载时清掉上一个计时器
  const showToast = useCallback((msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setRechargeToast(msg)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setRechargeToast('')
    }, 3000)
  }, [])

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }, [])

  // ── 状态获取 / 轮询 ──
  const fetchStatus = useCallback(async () => {
    if (!token) return null
    const ep = epochRef.current
    try {
      const res = await apiFetch('/api/campus/status')
      if (res.status === 503) {
        const b = await res.json().catch(() => null)
        if (ep === epochRef.current) setUnavailable((b && b.detail) ? String(b.detail) : t('campusService.serverUnavailable'))
        return null
      }
      if (!res.ok) return null
      const j = await res.json()
      if (ep === epochRef.current) {
        setStatus(j)
        setUnavailable('')
      }
      return j
    } catch {
      return null
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    fetchStatus()
  }, [token, fetchStatus])

  const shouldPoll = !!(status && !unavailable && (status.status === 'creating' || status.status === 'connecting'))
  useEffect(() => {
    if (!token || !shouldPoll) return
    const timer = setInterval(fetchStatus, 3000)
    return () => clearInterval(timer)
  }, [token, shouldPoll, unavailable, fetchStatus])

  // VPN 自动连接有了结论（连上 / 失败）后清除「自动连接中」提示，让位给状态卡或错误信息
  useEffect(() => {
    if (connected || (status && status.status === 'failed')) setVpnConnecting(false)
  }, [connected, status])

  // 等共享会话时自己的会话状态不会变化（可能根本没有个人会话），靠定时重试查询：
  // 池就绪/借道成功后自动出结果；约 2 分钟仍不可用则放弃并提示
  useEffect(() => {
    if (!vpnConnecting) return
    let n = 0
    const timer = setInterval(() => {
      n += 1
      if (n > 20) {
        setVpnConnecting(false)
        setErrMsg(t('campusService.sharedSessionUnavailable'))
        return
      }
      doQuery(vpnConnecting)
    }, 6000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpnConnecting])

  // ── 电费历史（电费走公网接口，不依赖 VPN 隧道） ──
  const fetchElecHistory = useCallback(async () => {
    if (!token) return
    try {
      const res = await apiFetch('/api/campus/electricity/history?days=90')
      if (!res.ok) return
      const b = await res.json().catch(() => null)
      if (b && Array.isArray(b.records)) {
        setElecHistory(b.records)
        setElecHistSeq(s => s + 1)
      }
    } catch { /* 忽略 */ }
  }, [token])

  // ── 子页面进入时先取上次查询结果渲染（云端按账号隔离，换设备也在） ──
  useEffect(() => {
    if (!token || !isSubPage || cacheFeature === feature) return
    setCacheFeature(feature)
    const key = CACHE_KEYS[feature]
    if (!key) return // 校园卡动态码 / 电费不做缓存
    sweepLegacyCache()
    let alive = true
    getUserData(key).then(c => {
      if (!alive || !c) return
      if (feature === 'score') {
        setScoreData(c)
      } else if (feature === 'grades') {
        setGradeData(c)
        if (Array.isArray(c.terms) && c.terms.length > 0) setGradeTerms(c.terms)
      } else if (feature === 'activities') {
        setActData(c)
      }
    })
    return () => { alive = false }
  }, [token, isSubPage, feature, cacheFeature])

  // 电费子页面进入时拉取历史曲线
  useEffect(() => {
    if (isSubPage && feature === 'electricity') fetchElecHistory()
  }, [isSubPage, feature, fetchElecHistory])

  // ── 连接 / 断开 ──
  const handleConnect = async () => {
    if (!token || statusBusy || busyRef.current) return
    const ep = epochRef.current
    setStatusBusy(true)
    setErrMsg('')
    setCredBanner(false)
    try {
      const res = await apiFetch('/api/campus/connect', { method: 'POST' })
      const b = await res.json().catch(() => null)
      if (ep !== epochRef.current) return
      if (res.status === 503) {
        setUnavailable((b && b.detail) ? String(b.detail) : t('campusService.serverUnavailable'))
        return
      }
      if (!res.ok) {
        setCredBanner(true)
        return
      }
      setStatus(b)
      setUnavailable('')
    } catch {
      if (ep === epochRef.current) setErrMsg(t('campusService.error'))
    } finally {
      setStatusBusy(false)
    }
  }

  const handleDisconnect = async () => {
    if (!token || statusBusy || busyRef.current) return
    setStatusBusy(true)
    try {
      await apiFetch('/api/campus/disconnect', { method: 'POST' })
    } catch { /* 忽略 */ }
    epochRef.current += 1
    setStatusBusy(false)
    setQBusy(null)
    setScoreData(null)
    setGradeData(null)
    setGradeTerms([])
    setGradeTerm('')
    setEcardData(null)
    setEcardCount(0)
    setActData(null)
    setActDetails({})
    setActViaPool(false)
    setVpnConnecting(false)
    setCaptcha(null)
    setCapInput('')
    setErrMsg('')
    setAutoCaptchaUsed(false)
    fetchStatus()
    // 断开后回到主页
    if (isSubPage) navigate('/tools/campus-service')
  }

  // ── 结果写入 ──
  const applyResult = (kind, data, autoCaptcha) => {
    if (autoCaptcha) setAutoCaptchaUsed(true)
    if (kind === 'score') {
      const scoreResult = (data && data.score) || data || null
      setScoreData(scoreResult)
      if (scoreResult) putUserData(CACHE_KEYS.score, scoreResult)
    } else if (kind === 'grades') {
      setGradeData(data || null)
      if (data) putUserData(CACHE_KEYS.grades, data)
      if (data && Array.isArray(data.terms) && data.terms.length > 0) {
        setGradeTerms(data.terms)
        setGradeTerm('')
      }
    } else if (kind === 'ecard') {
      setEcardData(data || null)
    } else if (kind === 'activities') {
      setActData(data || null)
      if (data) putUserData(CACHE_KEYS.activities, data)
    } else if (kind === 'electricity') {
      setElecData(data || null)
    }
  }

  // ── 统一查询 ──
  const doQuery = async (kind, params = {}) => {
    if (!token || busyRef.current) return
    busyRef.current = true
    const ep = epochRef.current
    setQBusy(kind)
    setErrMsg('')
    setAutoCaptchaUsed(false)
    if (captcha) { setCaptcha(null); setCapInput('') }

    // 电费走独立端点（不经过 query/{kind}，也不需要 VPN 隧道）
    if (kind === 'electricity') {
      try {
        const res = await apiFetch('/api/campus/electricity/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const b = await res.json().catch(() => null)
        if (ep !== epochRef.current) return
        if (!res.ok) {
          setErrMsg((b && b.detail) ? String(b.detail) : t('campusService.error'))
          return
        }
        if (b && b.data) applyResult('electricity', b.data)
        fetchElecHistory()
      } catch {
        if (ep === epochRef.current) setErrMsg(t('campusService.error'))
      } finally {
        busyRef.current = false
        if (ep === epochRef.current) setQBusy(null)
      }
      return
    }

    // 校园码走独立端点（校付宝公网接口，不需要 VPN 隧道、不弹验证码）
    if (kind === 'ecard') {
      try {
        const res = await apiFetch('/api/campus/ecard/qrcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const b = await res.json().catch(() => null)
        if (ep !== epochRef.current) return
        if (!res.ok) {
          setErrMsg((b && b.detail) ? String(b.detail) : t('campusService.error'))
          return
        }
        if (b && b.data) applyResult('ecard', b.data)
      } catch {
        if (ep === epochRef.current) setErrMsg(t('campusService.error'))
      } finally {
        busyRef.current = false
        if (ep === epochRef.current) setQBusy(null)
      }
      return
    }

    // 第二课堂活动走独立端点（/api/campus/activities，需 VPN 隧道）
    if (kind === 'activities') {
      try {
        const res = await apiFetch('/api/campus/activities', { method: 'POST' })
        const b = await res.json().catch(() => null)
        if (ep !== epochRef.current) return
        if (res.status === 503) {
          setVpnConnecting(false)
          setUnavailable((b && b.detail) ? String(b.detail) : t('campusService.serverUnavailable'))
          return
        }
        if (!res.ok) {
          setVpnConnecting(false)
          setErrMsg(b && b.detail ? String(b.detail) : t('campusService.error'))
          return
        }
        if (b && b.vpn_connecting) {
          setVpnConnecting('activities')
          fetchStatus()
          return
        }
        if (b && b.auto_captcha_used) {
          setVpnConnecting(false)
          setActViaPool(false)
          if (b.data) applyResult('activities', b.data, true)
          return
        }
        if (b && b.need_captcha) {
          setVpnConnecting(false)
          setCaptcha({ kind, xnm: '', xqm: '', image: b.captcha_base64 || '', err: '', submitting: false })
          setCapInput('')
          return
        }
        if (b && b.data) {
          setVpnConnecting(false)
          setActViaPool(!!b.via_pool)
          applyResult('activities', b.data)
        }
      } catch {
        if (ep === epochRef.current) setErrMsg(t('campusService.error'))
      } finally {
        busyRef.current = false
        if (ep === epochRef.current) setQBusy(null)
      }
      return
    }

    try {
      const res = await apiFetch(`/api/campus/query/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xnm: params.xnm || '', xqm: params.xqm || '' }),
      })
      const b = await res.json().catch(() => null)
      if (ep !== epochRef.current) return
      if (res.status === 503) {
        setUnavailable((b && b.detail) ? String(b.detail) : t('campusService.serverUnavailable'))
        return
      }
      // vpn_connecting：后端正在用已存凭据自动连接 VPN，轮询状态、连上后自动补查
      if (b && b.vpn_connecting) {
        setVpnConnecting(kind)
        fetchStatus()
        return
      }
      if (!res.ok) {
        setVpnConnecting(false)
        setErrMsg(b && b.detail ? String(b.detail) : t('campusService.error'))
        return
      }
      // auto_captcha_used：AI 自动识别验证码，直接展示结果
      if (b && b.auto_captcha_used) {
        setVpnConnecting(false)
        if (b.data) applyResult(kind, b.data, true)
        return
      }
      if (b && b.need_captcha) {
        setVpnConnecting(false)
        setCaptcha({
          kind,
          xnm: params.xnm || '',
          xqm: params.xqm || '',
          image: b.captcha_base64 || '',
          err: '',
          submitting: false,
        })
        setCapInput('')
        return
      }
      if (b && b.data) {
        setVpnConnecting(false)
        applyResult(kind, b.data)
      }
    } catch {
      if (ep === epochRef.current) setErrMsg(t('campusService.error'))
    } finally {
      busyRef.current = false
      if (ep === epochRef.current) setQBusy(null)
    }
  }

  // ── 第二课堂活动：展开卡片时拉取活动说明详情 ──
  const fetchActDetail = async (aid) => {
    const ep = epochRef.current
    setActDetails(prev => ({ ...prev, [aid]: { loading: true } }))
    try {
      const res = await apiFetch(`/api/campus/activities/${aid}/detail`)
      const b = await res.json().catch(() => null)
      if (ep !== epochRef.current) return
      if (b && b.vpn_connecting) {
        setVpnConnecting('activities')
        fetchStatus()
        setActDetails(prev => ({ ...prev, [aid]: { err: t('campusService.vpnAutoConnecting') } }))
        return
      }
      if (res.ok && b && b.data) {
        setVpnConnecting(false)
        setActDetails(prev => ({ ...prev, [aid]: { data: b.data } }))
      } else {
        const msg = (b && b.detail) ? String(b.detail) : t('campusService.activities.detailFail')
        setActDetails(prev => ({ ...prev, [aid]: { err: msg } }))
      }
    } catch {
      if (ep === epochRef.current) {
        setActDetails(prev => ({ ...prev, [aid]: { err: t('campusService.activities.detailFail') } }))
      }
    }
  }

  // ── 验证码提交 ──
  const submitCaptcha = async () => {
    const c = captcha
    if (!c || c.submitting || !capInput.trim()) return
    const ep = epochRef.current
    setCaptcha({ ...c, submitting: true, err: '' })
    try {
      const res = await apiFetch('/api/campus/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: c.kind, captcha: capInput.trim(), xnm: c.xnm, xqm: c.xqm }),
      })
      const b = await res.json().catch(() => null)
      if (ep !== epochRef.current) { setCaptcha(null); return }
      if (res.status === 503) {
        setCaptcha(null)
        setCapInput('')
        setUnavailable((b && b.detail) ? String(b.detail) : t('campusService.serverUnavailable'))
        return
      }
      // 提交时 VPN 恰好断了：关掉弹窗走自动连接，连上后自动补查会重新弹验证码
      if (b && b.vpn_connecting) {
        setCaptcha(null)
        setCapInput('')
        setVpnConnecting(c.kind)
        fetchStatus()
        return
      }
      if (!res.ok) {
        setCaptcha({ ...c, submitting: false, err: b && b.detail ? String(b.detail) : t('campusService.error') })
        return
      }
      setCaptcha(null)
      setCapInput('')
      if (b && b.data) applyResult(c.kind, b.data)
    } catch {
      setCaptcha({ ...c, submitting: false, err: t('campusService.error') })
    }
  }

  // ── 校园卡动态码自动刷新（走公网接口，不依赖 VPN 连接状态） ──
  useEffect(() => {
    if (!token || !ecardData || !ecardData.refresh) {
      setEcardCount(0)
      return
    }
    if (captcha) return
    let n = ecardData.refresh
    setEcardCount(n)
    const timer = setInterval(() => {
      n -= 1
      if (n <= 0) {
        n = ecardData.refresh
        doQuery('ecard')
      }
      setEcardCount(n)
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ecardData, captcha])

  // 子页面进入时自动查询（有缓存则先展示缓存，等用户点「刷新」）
  // VPN 未连接时也直接查询：后端会用已存凭据自动连接并返回 vpn_connecting，
  // 前端轮询状态、连上后 connected 变化重新触发本 effect 补查
  useEffect(() => {
    if (isSubPage && cacheFeature === feature && !qBusy && !captcha) {
      if (feature === 'score' && !scoreData) doQuery('score')
      else if (feature === 'grades' && !gradeData) doQuery('grades')
      else if (feature === 'ecard' && !ecardData) doQuery('ecard')
      else if (feature === 'electricity' && !elecData) doQuery('electricity')
      else if (feature === 'activities' && !actData) doQuery('activities')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubPage, feature, connected, cacheFeature])

  const goFillCreds = () => {
    localStorage.setItem('my_tab', 'campus')
    navigate('/my')
  }

  const handleCopyProxy = (kind) => {
    if (!status || !status.host) return
    const port = kind === 'socks' ? status.socks_port : status.http_port
    const addr = `${status.host}:${port}`
    copyText(addr)
    setCopyLabel(kind)
    setTimeout(() => setCopyLabel(''), 1500)
  }

  // ── 渲染：状态卡（仅主页展示，含连接 / 断开操作） ──
  const renderStatusCard = () => {
    if (unavailable) {
      return (
        <div className="cs-status-card cs-status-down">
          <div className="cs-status-row">
            <span className="cs-badge cs-badge-danger">{t('campusService.serverUnavailable')}</span>
            <button className="btn btn-secondary" onClick={fetchStatus}>{t('campusService.retry')}</button>
          </div>
          {unavailable && <p className="cs-status-err">{unavailable}</p>}
        </div>
      )
    }
    if (!status) {
      return (
        <div className="cs-status-card">
          <span className="cs-badge cs-badge-muted">{t('campusService.loading')}</span>
        </div>
      )
    }
    const st = status.status
    const connected = st === 'connected'
    const inFlight = st === 'creating' || st === 'connecting'
    return (
      <div className="cs-status-card">
        <div className="cs-status-row">
          {connected ? (
            <>
              <span className="cs-badge cs-badge-ok">{t('campusService.connected')}</span>
              {status.student_id_masked && <span className="cs-status-sid">{t('campusService.studentId', { sid: status.student_id_masked })}</span>}
              <button className="btn btn-secondary" onClick={handleDisconnect} disabled={statusBusy || !!qBusy}>
                {statusBusy ? t('campusService.disconnecting') : t('campusService.disconnect')}
              </button>
            </>
          ) : inFlight ? (
            <>
              <span className="cs-badge cs-badge-busy">
                <span className="cs-spinner" />{t('campusService.connecting')}
              </span>
            </>
          ) : (
            <>
              <span className={`cs-badge ${st === 'failed' ? 'cs-badge-danger' : 'cs-badge-muted'}`}>{st === 'failed' ? t('campusService.failed') : t('campusService.notConnected')}</span>
              <button className="btn btn-primary" onClick={handleConnect} disabled={statusBusy || !!qBusy}>
                {statusBusy ? t('campusService.connecting') : t('campusService.connect')}
              </button>
            </>
          )}
        </div>
        {st === 'failed' && status.error && <p className="cs-status-err">{status.error}</p>}
        {connected && status.host && (
          <div className="cs-proxy-info">
            <div className="cs-proxy-row">
              <span className="cs-proxy-label">{t('campusService.proxy.socks')}</span>
              <span className="cs-proxy-addr">{status.host}:{status.socks_port}</span>
              <button type="button" className="cs-proxy-copy" onClick={() => handleCopyProxy('socks')}>
                {copyLabel === 'socks' ? t('campusService.proxy.copied') : t('campusService.proxy.copy')}
              </button>
            </div>
            <div className="cs-proxy-row">
              <span className="cs-proxy-label">{t('campusService.proxy.http')}</span>
              <span className="cs-proxy-addr">{status.host}:{status.http_port}</span>
              <button type="button" className="cs-proxy-copy" onClick={() => handleCopyProxy('http')}>
                {copyLabel === 'http' ? t('campusService.proxy.copied') : t('campusService.proxy.copy')}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── 渲染：auto_captcha_used 提示 ──
  const renderAutoCaptchaBanner = () => {
    if (!autoCaptchaUsed) return null
    return (
      <div className="cs-auto-banner">
        {t('campusService.captcha.autoSolved')}
      </div>
    )
  }

  // ── 渲染：第二课堂分 ──
  const renderScore = () => {
    if (!scoreData) return null
    const total = scoreData.total
    if (total == null && !(scoreData.groups || []).length) {
      return <div className="cs-panel"><p className="cs-empty">{t('campusService.score.empty')}</p></div>
    }
    const student = scoreData.student || {}
    const infos = STUDENT_LABELS.filter(([k]) => student[k] != null && student[k] !== '')
    return (
      <div className="cs-panel">
        {infos.length > 0 && (
          <div className="cs-student-line">
            {infos.map(([k, labelKey], i) => (
              <span key={k}>
                {i > 0 && <em className="cs-sep">·</em>}
                {t(labelKey)} {student[k]}
              </span>
            ))}
          </div>
        )}
        <div className="cs-stats">
          <div className="cs-stat">
            <span className="cs-stat-label">{t('campusService.score.total')}</span>
            <b>{total != null ? total : '—'}</b>
          </div>
          <div className="cs-stat">
            <span className="cs-stat-label">{t('campusService.score.credit')}</span>
            <div className="cs-stat-row">
              <b className={scoreData.credit != null ? (Number(scoreData.credit) >= TOTAL_TARGET ? 'cs-score-ok' : 'cs-score-warn') : ''}>
                <CountUp value={scoreData.credit} />
              </b>
              {scoreData.credit != null && <span className="cs-stat-target">/ {TOTAL_TARGET}</span>}
            </div>
          </div>
        </div>
        <div className="cs-groups">
          {(scoreData.groups || []).map((g, gi) => {
            const target = matchScoreTarget(g.name)
            const actual = g.subtotal != null ? Number(g.subtotal) : null
            const targetVal = target ? target.target : null
            const reached = actual != null && targetVal != null && actual >= targetVal
            const subCls = targetVal != null ? (reached ? 'cs-group-ok' : 'cs-group-warn') : ''

            // 美育 / 健康教育：只看总分，不展开
            if (target && target.noExpand) {
              return (
                <div key={gi} className="cs-group cs-group-flat">
                  <div className="cs-group-flat-row">
                    <span className="cs-group-name">{g.name}</span>
                    {g.subtotal != null && (
                      <span className={`cs-group-sub ${subCls}`}>{actual} / {targetVal != null ? targetVal : '—'}</span>
                    )}
                  </div>
                </div>
              )
            }

            // 德育 / 劳育：可展开，二级项显示达标分
            return (
              <ScoreGroup
                key={gi}
                group={g}
                defaultOpen={gi < (scoreData.groups || []).length - 2 && g.rows.length <= 4}
              />
            )
          })}
        </div>
      </div>
    )
  }

  // ── 渲染：成绩 ──
  const renderGrades = () => {
    if (!gradeData) return null
    const rows = gradeData.grades || []
    return (
      <div className="cs-panel">
        <div className="cs-grades-hero">
          <div className="cs-stat cs-gpa">
            <span className="cs-stat-label">{t('campusService.grades.gpa')}</span>
            <b>{gradeData.gpa != null ? Number(gradeData.gpa).toFixed(1) : '0'}</b>
          </div>
          <span className="cs-grade-count">{t('campusService.grades.count', { n: gradeData.count != null ? gradeData.count : rows.length })}</span>
          <div className="cs-term-select">
            <CategoryDropdown
              value={gradeTerm}
              onChange={handleTermChange}
              options={[{ value: '', label: t('campusService.grades.allTerms') }, ...gradeTerms.map(tm => ({ value: `${tm.xnm}|${tm.xqm}`, label: `${tm.xnmmc || tm.xnm} · ${tm.xqmmc || tm.xqm}` }))]}
              placeholder={t('campusService.grades.selectTerm')}
              size="sm"
              hideClear
              closeOnSelect
            />
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="cs-empty">{t('campusService.grades.empty')}</p>
        ) : (
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr>
                  <th>{t('campusService.grades.col.course')}</th>
                  <th>{t('campusService.grades.col.score')}</th>
                  <th>{t('campusService.grades.col.credit')}</th>
                  <th>{t('campusService.grades.col.gpa')}</th>
                  <th>{t('campusService.grades.col.method')}</th>
                  <th>{t('campusService.grades.col.year')}</th>
                  <th>{t('campusService.grades.col.term')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g, i) => (
                  <tr key={i}>
                    <td className="cs-cell-course">{g.kcmc}</td>
                    <td>{g.cj != null && g.cj !== '' ? g.cj : '—'}</td>
                    <td>{g.xf != null && g.xf !== '' ? g.xf : '—'}</td>
                    <td>{g.jd != null && g.jd !== '' ? g.jd : '—'}</td>
                    <td>{g.khfsmc || '—'}</td>
                    <td>{g.xnmmc || '—'}</td>
                    <td>{g.xqmmc || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  const handleTermChange = (v) => {
    setGradeTerm(v)
    if (v) {
      const idx = v.indexOf('|')
      doQuery('grades', { xnm: v.slice(0, idx), xqm: v.slice(idx + 1) })
    } else {
      doQuery('grades', {})
    }
  }

  // ── 渲染：校园卡动态码（二维码居中在上，余额/倒计时/刷新在码下方） ──
  const renderEcard = () => {
    if (!ecardData) return null
    return (
      <div className="cs-panel cs-ecard-panel">
        <span className="cs-badge cs-badge-ok">{t('campusService.query.ecard')}</span>
        {ecardData.image ? (
          <img className="cs-ecard-img" src={`data:${ecardData.type || 'image/png'};base64,${ecardData.image}`} alt="dynamic-code" />
        ) : ecardData.code ? (
          <p className="cs-ecard-code">{ecardData.code}</p>
        ) : null}
        <div className="cs-ecard-foot">
          <span className="cs-ecard-balance">
            {t('campusService.ecard.balance')}
            <b>{ecardData.card_balance != null ? `¥${Number(ecardData.card_balance).toFixed(2)}` : '—'}</b>
          </span>
          {ecardData.refresh > 0 && (
            <span className="cs-ecard-countdown">{t('campusService.ecard.countdown', { n: ecardCount })}</span>
          )}
          <button className="btn btn-secondary" onClick={() => doQuery('ecard')} disabled={!!qBusy}>
            {qBusy === 'ecard' ? t('campusService.ecard.refreshing') : t('campusService.ecard.refresh')}
          </button>
        </div>
        <p className="cs-ecard-tip">{t('campusService.ecard.tip')}</p>
      </div>
    )
  }

  // ── 电费充值 ──
  const handleRecharge = async () => {
    const amt = parseFloat(rechargeAmt)
    if (!amt || amt <= 0 || amt > 500) {
      setRechargeMsg(t('campusService.electricity.rechargeRange'))
      return
    }
    setRechargeBusy(true)
    setRechargeMsg('')
    try {
      const res = await apiFetch('/api/campus/electricity/recharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amt }),
      })
      const b = await res.json().catch(() => null)
      if (!res.ok) {
        // 失败不关弹窗，保留金额与错误信息
        setRechargeMsg(t('campusService.electricity.rechargeFailed', {
          error: (b && b.detail) ? String(b.detail) : t('campusService.error'),
        }))
        return
      }
      // 成功即关弹窗并清空弹窗内状态，改用页面级 toast 反馈
      setRechargeOpen(false)
      setRechargeMsg('')
      setRechargeAmt('')
      showToast(t('campusService.electricity.rechargeSuccess'))
      // 用返回的新余额就地更新面板，并刷新历史曲线
      if (b && b.data) {
        setElecData(prev => (prev ? {
          ...prev,
          balance: b.data.balance != null ? b.data.balance : prev.balance,
          card_balance: b.data.card_balance != null ? b.data.card_balance : prev.card_balance,
        } : prev))
      }
      fetchElecHistory()
    } catch {
      setRechargeMsg(t('campusService.electricity.rechargeFailed', { error: t('campusService.error') }))
    } finally {
      setRechargeBusy(false)
    }
  }

  // ── 渲染：电费查询 ──
  const renderElectricity = () => {
    const avgs = [
      ['campusService.electricity.avgWeek', avgDailyUsage(elecHistory, 'week')],
      ['campusService.electricity.avgMonth', avgDailyUsage(elecHistory, 'month')],
    ]
    // 预计可用天数 = 当前余额 ÷ 最近 7 天日均耗电。用滚动 7 天而非本周/本月：周一、月初刚开头时
    // 自然周期内记录还不够算日均，而「余额还能撑几天」恰恰是那时候最该看的。
    const rate7 = avgDailyUsage(elecHistory, 'last7')
    const lastRecord = [...elecHistory].reverse().find(r => r && r.balance != null)
    const curBalance = elecData?.balance != null
      ? Number(elecData.balance)
      : (lastRecord ? Number(lastRecord.balance) : null)
    const daysLeft = rate7 > 0 && curBalance != null && Number.isFinite(curBalance)
      ? curBalance / rate7
      : null
    // 折线图小字说明：与折线图共用同一套推导（该视图无数据时 note 为空串，小字隐藏）
    const elecNote = buildSeries(elecHistory, elecView).note
    return (
    <div className="cs-panel cs-elec-panel">
      {elecData ? (
        <>
          <div className="cs-elec-head">
            <div className="cs-elec-stats">
              <div className="cs-stat">
                <span className="cs-stat-label">{t('campusService.electricity.balance')}</span>
                <b className={elecData.balance != null && Number(elecData.balance) < 10 ? 'cs-score-warn' : ''}>
                  {elecData.balance != null ? `¥${Number(elecData.balance).toFixed(2)}` : '—'}
                </b>
              </div>
              <div className="cs-stat">
                <span className="cs-stat-label">{t('campusService.electricity.cardBalance')}</span>
                <b>{elecData.card_balance != null ? `¥${Number(elecData.card_balance).toFixed(2)}` : '—'}</b>
              </div>
            </div>
            <div className="cs-elec-btns">
              <button
                className="btn btn-primary"
                onClick={() => { setRechargeOpen(true); setRechargeMsg(''); setRechargeAmt('') }}
              >
                {t('campusService.electricity.recharge')}
              </button>
              <button className="btn btn-secondary" onClick={() => doQuery('electricity')} disabled={!!qBusy}>
                {qBusy === 'electricity' ? t('campusService.refreshing') : t('campusService.refresh')}
              </button>
            </div>
          </div>
          <p className="cs-elec-dorm">{elecData.dorm || t('campusService.electricity.noDorm')}</p>
        </>
      ) : (
        <div className="cs-elec-empty">
          <p className="cs-empty">{t('campusService.electricity.empty')}</p>
          <button className="btn btn-primary" onClick={() => doQuery('electricity')} disabled={!!qBusy}>
            {qBusy === 'electricity' ? t('campusService.refreshing') : t('campusService.refresh')}
          </button>
        </div>
      )}

      {/* 本周 / 本月日均耗电 + 预计可用天数：只依赖历史记录（充值额已剔除），与本次查询是否成功无关 */}
      {elecHistory.length > 0 && (
        <div className="cs-elec-avgs">
          {avgs.map(([labelKey, v]) => (
            <span key={labelKey} className="cs-elec-avg" title={v == null ? t('campusService.electricity.avgInsufficient') : undefined}>
              <span className="cs-elec-avg-label">{t(labelKey)}</span>
              <b>{v != null ? `${v.toFixed(2)} ${t('campusService.electricity.avgUnit')}` : '—'}</b>
            </span>
          ))}
          <span className="cs-elec-avg" title={daysLeft != null
            ? t('campusService.electricity.daysLeftTip', { rate: rate7.toFixed(2) })
            : t('campusService.electricity.avgInsufficient')}>
            <span className="cs-elec-avg-label">{t('campusService.electricity.daysLeft')}</span>
            <b className={daysLeft != null && daysLeft < 5 ? 'cs-score-warn' : ''}>
              {daysLeft != null ? `${daysLeft.toFixed(1)} ${t('campusService.electricity.daysLeftUnit')}` : '—'}
            </b>
          </span>
        </div>
      )}

      {/* 历史用量折线图 */}
      {elecHistory.length > 0 && (
        <div className="cs-elec-chart">
          <div className="cs-elec-chart-head">
            <div className="cs-elec-chart-title">
              <span>{t('campusService.electricity.history')}</span>
              {/* 小字说明：看的是什么 + 单位（日 = 某天每小时余额，周 / 月 = 每天最低余额） */}
              {elecView === 'day' ? (
                elecNote && (
                  <span className="cs-elec-chart-sub">
                    {t('campusService.electricity.hourlyCaption', { date: elecNote })}
                  </span>
                )
              ) : (
                <span className="cs-elec-chart-sub">
                  {t(elecView === 'week'
                    ? 'campusService.electricity.weekCaption'
                    : 'campusService.electricity.monthCaption')}
                </span>
              )}
            </div>
            <div className="cs-elec-view-btns">
              {['day', 'week', 'month'].map(v => (
                <button
                  key={v}
                  className={`cs-elec-view-btn ${elecView === v ? 'active' : ''}`}
                  onClick={() => setElecView(v)}
                >
                  {t(`campusService.electricity.view${v.charAt(0).toUpperCase() + v.slice(1)}`)}
                </button>
              ))}
            </div>
          </div>
          {/* key 随视图/新数据变化 → 组件重挂载，重放入场动画（切换视图、刷新拿到新数据都会重播） */}
          <MiniLineChart key={`${elecView}-${elecHistSeq}`} data={elecHistory} view={elecView} />
        </div>
      )}
      <p className="cs-elec-auto">{t('campusService.electricity.autoQueried')}</p>
    </div>
    )
  }

  // ── 渲染：第二课堂活动看板 ──
  const renderActivities = () => {
    const acts = (actData && actData.activities) || []
    const kw = actSearch.trim().toLowerCase()
    // 各报名状态的计数（不受筛选影响，便于判断要不要点）
    const counts = { open: 0, soon: 0, closed: 0 }
    for (const a of acts) {
      const st = bmStateOf(a)
      if (counts[st] != null) counts[st] += 1
    }
    const rank = { open: 0, soon: 1, closed: 2, none: 2 }
    const filtered = acts
      .filter(a => {
        if (actFilter !== 'all' && bmStateOf(a) !== actFilter) return false
        if (kw) {
          const blob = [a.name, a.host, a.lbmc, a.dlmc].join(' ').toLowerCase()
          if (!blob.includes(kw)) return false
        }
        return true
      })
      .sort((x, y) => {
        const rx = rank[bmStateOf(x)] - rank[bmStateOf(y)]
        if (rx !== 0) return rx
        if (bmStateOf(x) === 'open') return String(x.bm_end || '').localeCompare(String(y.bm_end || ''))
        return String(y.bm_start || '').localeCompare(String(x.bm_start || ''))
      })

    return (
      <div className="cs-panel cs-act-panel">
        <div className="cs-act-toolbar">
          <input
            className="tool-input cs-act-search"
            placeholder={t('campusService.activities.searchPlaceholder')}
            value={actSearch}
            onChange={e => setActSearch(e.target.value)}
          />
          <div className="cs-elec-view-btns">
            {['all', 'open', 'soon', 'closed'].map(v => (
              <button
                key={v}
                className={`cs-elec-view-btn ${actFilter === v ? 'active' : ''}`}
                onClick={() => setActFilter(v)}
              >
                {t(`campusService.activities.filter_${v}`)}
                {counts[v] != null && v !== 'all' ? ` (${counts[v]})` : ''}
              </button>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className="cs-empty">{t('campusService.activities.empty')}</p>
        ) : (
          <>
            <p className="cs-act-count">
              {t('campusService.activities.count', { n: filtered.length })}
              {actViaPool && <span className="cs-badge cs-badge-muted cs-act-via">{t('campusService.activities.viaPool')}</span>}
            </p>
            <div className="cs-act-list">
              {filtered.map(a => (
                <ActivityCard key={a.id} a={a} detail={actDetails[a.id]} onExpand={fetchActDetail} />
              ))}
            </div>
          </>
        )}
      </div>
    )
  }

  // ── 渲染：充值弹窗 ──
  const renderRechargeModal = () => {
    if (!rechargeOpen) return null
    return (
      <Modal
        open
        title={t('campusService.electricity.rechargeTitle')}
        confirmText={t('campusService.electricity.rechargeConfirm')}
        cancelText={t('modal.cancel')}
        confirmDisabled={rechargeBusy || !rechargeAmt}
        onConfirm={handleRecharge}
        onCancel={() => { setRechargeOpen(false); setRechargeMsg('') }}
      >
        <div className="cs-recharge">
          <div className="cs-recharge-current">
            {t('campusService.electricity.balance')}：
            <b>{elecData && elecData.balance != null ? `¥${Number(elecData.balance).toFixed(2)}` : '—'}</b>
          </div>
          <div className="ccp-field">
            <label className="ccp-label">{t('campusService.electricity.rechargeAmount')}</label>
            <input
              className="ccp-input"
              type="number"
              min="0.01"
              max="500"
              step="0.01"
              value={rechargeAmt}
              placeholder={t('campusService.electricity.rechargePlaceholder')}
              autoFocus
              onChange={e => setRechargeAmt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRecharge() }}
            />
          </div>
          {rechargeMsg && (
            <p className="cs-recharge-msg err">{rechargeMsg}</p>
          )}
        </div>
      </Modal>
    )
  }

  // ── 渲染：验证码弹窗 ──
  const renderCaptchaModal = () => {
    if (!captcha) return null
    return (
      <Modal
        open
        title={t('campusService.captcha.title')}
        confirmText={t('campusService.captcha.confirm')}
        cancelText={t('modal.cancel')}
        confirmDisabled={captcha.submitting || !capInput.trim()}
        onConfirm={submitCaptcha}
        onCancel={() => { setCaptcha(null); setCapInput('') }}
      >
        <div className="cs-captcha">
          <p className="cs-captcha-prompt">{t('campusService.captcha.prompt')}</p>
          <div className="cs-captcha-row">
            {captcha.image ? (
              <img className="cs-captcha-img" src={`data:image/png;base64,${captcha.image}`} alt="captcha" />
            ) : (
              <span className="cs-captcha-noimg">{t('campusService.captcha.noImage')}</span>
            )}
            <input
              className="tool-input cs-captcha-input"
              placeholder={t('campusService.captcha.placeholder')}
              value={capInput}
              maxLength={10}
              autoFocus
              onChange={e => setCapInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCaptcha() }}
            />
          </div>
          {captcha.err && <p className="cs-captcha-err">{captcha.err}</p>}
          <button type="button" className="btn btn-secondary" onClick={() => doQuery(captcha.kind, { xnm: captcha.xnm, xqm: captcha.xqm })} disabled={captcha.submitting}>
            {t('campusService.captcha.refetch')}
          </button>
        </div>
      </Modal>
    )
  }

  // ── 渲染：主页（电费走公网、活动可走共享会话池，均不依赖自身 VPN；登录后即可进入） ──
  const renderMainPage = () => {
    const user = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}') } catch { return {} } })()
    return (
    <>
      {token && renderStatusCard()}

      {token && (
        <>
          <h2 className="cs-queries-title">{t('campusService.queriesTitle')}</h2>
          <div className={`cs-queries ${connected ? '' : 'cs-queries-single'}`}>
            {connected && (
              <>
                <Link to="/tools/campus-service/score" className="cs-qcard">
                  <span className="cs-qcard-name">{t('campusService.query.score')}</span>
                  <span className="cs-qcard-desc">{t('campusService.query.scoreDesc')}</span>
                  <span className="cs-qcard-state">{'›'}</span>
                </Link>
                <Link to="/tools/campus-service/grades" className="cs-qcard">
                  <span className="cs-qcard-name">{t('campusService.query.grades')}</span>
                  <span className="cs-qcard-desc">{t('campusService.query.gradesDesc')}</span>
                  <span className="cs-qcard-state">{'›'}</span>
                </Link>
              </>
            )}
            <Link to="/tools/campus-service/ecard" className="cs-qcard">
              <span className="cs-qcard-name">{t('campusService.query.ecard')}</span>
              <span className="cs-qcard-desc">{t('campusService.query.ecardDesc')}</span>
              <span className="cs-qcard-state">{'›'}</span>
            </Link>
            <Link to="/tools/campus-service/activities" className="cs-qcard">
              <span className="cs-qcard-name">{t('campusService.query.activities')}</span>
              <span className="cs-qcard-desc">{t('campusService.query.activitiesDesc')}</span>
              <span className="cs-qcard-state">{'›'}</span>
            </Link>
            <Link to="/tools/campus-service/electricity" className="cs-qcard">
              <span className="cs-qcard-name">{t('campusService.electricity.name')}</span>
              <span className="cs-qcard-desc">{t('campusService.electricity.desc')}</span>
              <span className="cs-qcard-state">{'›'}</span>
            </Link>
            <Link to="/tools/campus-service/timetable" className="cs-qcard">
              <span className="cs-qcard-name">{t('campusService.query.timetable')}</span>
              <span className="cs-qcard-desc">{t('campusService.query.timetableDesc')}</span>
              <span className="cs-qcard-state">{'›'}</span>
            </Link>
          </div>
          {user.role === 'admin' && (
            <Link to="/tools/campus-service/pool" className="cs-pool-link">
              {t('campusService.pool.link')} <span className="cs-qcard-state">{'›'}</span>
            </Link>
          )}
        </>
      )}
    </>
    )
  }

  // ── 渲染：子页面（电费/校园码走公网、活动可走共享会话池，均不依赖自身 VPN；未连接时只给一行提示） ──
  const needsVpn = feature !== 'electricity' && feature !== 'activities' && feature !== 'ecard'
  const renderSubPage = () => (
    <>
      <Link to="/tools/campus-service" className="tool-back">{t('campusService.backToCampus')}</Link>
      <div className="cs-sub-header">
        <h2 className="cs-sub-title">{t(KIND_LABELS[feature])}</h2>
        {(feature === 'score' || feature === 'grades' || feature === 'activities') && (
          <button className="btn btn-secondary cs-refresh-btn" onClick={() => doQuery(feature)} disabled={!!qBusy}>
            {qBusy === feature ? t('campusService.refreshing') : t('campusService.refresh')}
          </button>
        )}
      </div>

      {token && !connected && (needsVpn || vpnConnecting) && (
        <p className="cs-vpn-hint">
          {vpnConnecting && <span className="cs-spinner" />}
          {vpnConnecting
            ? t('campusService.vpnAutoConnecting')
            : unavailable || ((status && status.status === 'failed' && status.error) ? status.error : t('campusService.vpnHint'))}
          {!vpnConnecting && !unavailable && (
            <Link to="/tools/campus-service" className="cs-vpn-hint-link">{t('campusService.goConnect')}</Link>
          )}
        </p>
      )}

      {token && (connected || !needsVpn) && (
        <>
          {renderAutoCaptchaBanner()}
          {feature === 'score' && renderScore()}
          {feature === 'grades' && renderGrades()}
          {feature === 'ecard' && renderEcard()}
          {feature === 'electricity' && renderElectricity()}
          {feature === 'activities' && renderActivities()}
        </>
      )}
    </>
  )

  return (
    <div className="tool-page">
      <Navbar activePage="tools" />
      <div className="tool-main">
        <header className="tool-header">
          <Link to="/tools" className="tool-back">{t('campusService.backToTools')}</Link>
          {/* 二级页有自己的标题，不再重复展示「校园服务」与介绍 */}
          {!isSubPage && (
            <>
              <h1 className="tool-title">{t('campusService.title')}</h1>
              <p className="tool-subtitle">{t('campusService.subtitle')}</p>
            </>
          )}
        </header>

        {!token && (
          <div className="tool-login-hint">
            {t('campusService.needLogin')}<Link to="/auth">{t('campusService.goAuth')}</Link>
          </div>
        )}

        {credBanner && (
          <div className="cs-banner">
            <div className="cs-banner-main">
              <p className="cs-banner-title">{t('campusService.notConfigured')}</p>
              <p className="cs-banner-hint">{t('campusService.notConfiguredHint')}</p>
            </div>
            <button className="btn btn-primary" onClick={goFillCreds}>{t('campusService.goFill')}</button>
          </div>
        )}

        {errMsg && <div className="tool-error">{errMsg}</div>}

        {isSubPage ? renderSubPage() : renderMainPage()}
      </div>

      {renderCaptchaModal()}
      {renderRechargeModal()}

      {/* 页面级 toast：固定视口居中，不受页面布局影响 */}
      {rechargeToast && (
        <div className={`cs-toast${prefersReducedMotion() ? '' : ' cs-toast-in'}`} role="status" aria-live="polite">
          <span className="cs-toast-check" aria-hidden="true">&#10003;</span>
          <span>{rechargeToast}</span>
        </div>
      )}
    </div>
  )
}
