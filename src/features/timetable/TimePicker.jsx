// TimePicker.jsx — 时间选择器（Corporate Clean：输入框触发 + 白面板双列时/分，blue-600 选中态）
// 分钟 5 分钟步进，与 SIT 作息粒度一致（08:20/09:05/10:10…）；「此刻」快捷回填当前时间。
// 弹层定位与 CategoryDropdown popover 同源：fixed 贴触发钮、按最近 .modal-sheet 钳制、
// 下方放不下向上翻、点击外部/Escape 收起（capture 阶段拦下 Escape，只关面板不关弹窗）。

import { useEffect, useRef, useState } from 'react'
import { UiIcon } from '../../components/Icons'
import { t } from '../../i18n'

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const btnRef = useRef(null)

  const [rawH, rawM] = (value || '').split(':')
  const hh = /^\d{2}$/.test(rawH) ? rawH : '08'
  const mm = /^\d{2}$/.test(rawM) ? rawM : '00'

  const close = () => {
    setOpen(false)
    setPos(null)
  }

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const sheet = btnRef.current.closest('.modal-sheet')
      const sRect = sheet ? sheet.getBoundingClientRect() : { top: 8, bottom: window.innerHeight - 8 }
      const below = sRect.bottom - r.bottom - 10
      const above = r.top - sRect.top - 10
      let openUp = false
      let space = below
      if (below < 240 && above > below) {
        openUp = true
        space = above
      }
      const maxH = Math.max(170, Math.min(280, space))
      setPos({
        left: Math.max(6, Math.min(r.left, window.innerWidth - 190)),
        width: Math.max(r.width, 172),
        maxH,
        up: openUp,
        ...(openUp ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      })
    }
    setOpen(o => !o)
  }

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation() // 只关面板，不触发弹窗的 Escape 关闭
        close()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // 展开时把选中项滚进可视区
  useEffect(() => {
    if (!open) return
    for (const col of rootRef.current?.querySelectorAll('.tt-time-col') || []) {
      const el = col.querySelector('.active')
      if (el) el.scrollIntoView({ block: 'nearest' })
    }
  }, [open])

  const setPart = (part, v) => {
    onChange(part === 'h' ? `${v}:${mm}` : `${hh}:${v}`)
    if (part === 'm') close()
  }

  const now = () => {
    const d = new Date()
    onChange(`${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0')}`)
    close()
  }

  return (
    <div ref={rootRef} className="tt-time" onClick={e => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={`tt-time-trigger${open ? ' open' : ''}`}
        onClick={toggle}
      >
        <span>{value || '--:--'}</span>
        <UiIcon name="clock" size={14} className="tt-time-icon" />
      </button>
      {open && pos && (
        <div
          className="tt-time-panel"
          style={{
            position: 'fixed',
            top: pos.up ? 'auto' : pos.top,
            bottom: pos.up ? pos.bottom : 'auto',
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            zIndex: 1100,
          }}
        >
          <div className="tt-time-head">
            <span>{t('timetable.timeHour')}</span>
            <span>{t('timetable.timeMinute')}</span>
          </div>
          <div className="tt-time-cols">
            <div className="tt-time-col">
              {HOURS.map(h => (
                <button
                  key={h}
                  type="button"
                  className={`tt-time-cell${h === hh ? ' active' : ''}`}
                  onClick={() => setPart('h', h)}
                >{h}</button>
              ))}
            </div>
            <div className="tt-time-col">
              {MINUTES.map(m => (
                <button
                  key={m}
                  type="button"
                  className={`tt-time-cell${m === mm ? ' active' : ''}`}
                  onClick={() => setPart('m', m)}
                >{m}</button>
              ))}
            </div>
          </div>
          <button type="button" className="tt-time-now" onClick={now}>{t('timetable.timeNow')}</button>
        </div>
      )}
    </div>
  )
}

export default TimePicker
