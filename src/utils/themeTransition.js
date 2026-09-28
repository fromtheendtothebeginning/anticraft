// utils/themeTransition.js — 通用主题渐变引擎
// 任何主题色变化（切换 / 换肤 / 新主题）都会从当前值逐帧线性插值到目标值，
// 自动产生平滑渐变动画。主题定义见 themes.js。

import { THEMES, detectThemeMode, modeIsDark, parseColor } from './themes'

let rafId = null

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function readCurrentValues(keys) {
  const cs = getComputedStyle(document.documentElement)
  const out = {}
  for (const key of keys) out[key] = parseColor(cs.getPropertyValue(key))
  return out
}

function formatRgba([r, g, b, a]) {
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')})`
}

function applyThemeVars(target, duration = 800, keepInline = false, from = null) {
  if (!target) return
  if (rafId) cancelAnimationFrame(rafId)
  const keys = Object.keys(target)
  if (!from) from = readCurrentValues(keys) // 未传快照时现场读取（此时 data-theme 必须尚未翻转）
  const to = {}
  const direct = {}
  for (const key of keys) {
    const parsed = parseColor(target[key])
    if (parsed) to[key] = parsed
    else direct[key] = target[key] // 非颜色值（渐变等）：直接赋值，不参与插值
  }
  const root = document.documentElement
  // 非插值变量（如 --progress-gradient 渐变）立即应用
  for (const key of Object.keys(direct)) root.style.setProperty(key, direct[key])
  const start = performance.now()

  const step = (now) => {
    const t = Math.min(1, (now - start) / duration)
    // easeInOutCubic：慢起慢收——暗→亮时亮度缓升，避免前段骤亮刺眼
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    for (const key of Object.keys(to)) {
      const f = from[key] || [0, 0, 0, 1]
      const g = to[key] || [0, 0, 0, 1]
      root.style.setProperty(key, formatRgba([
        lerp(f[0], g[0], ease),
        lerp(f[1], g[1], ease),
        lerp(f[2], g[2], ease),
        f[3] + (g[3] - f[3]) * ease,
      ]))
    }
    if (t < 1) {
      rafId = requestAnimationFrame(step)
    } else {
      rafId = null
      if (!keepInline) for (const key of keys) root.style.removeProperty(key)
    }
  }
  // 同步写起始帧：属性翻转后、首个 RAF 前的空窗会渲染目标主题（1-2 帧闪光），先写回起始值堵住
  step(start)
}

/**
 * 将当前主题渐变过渡到目标主题（自动对 target 中定义的变量插值）。
 * @param {string} name - THEMES 中的主题名（light / dark / gold / 未来新主题）
 * @param {number} [duration=800] - 动画时长 ms
 * @param {boolean} [keepInline=false] - 完成后保留内联变量（如黄金主题需保留金色）
 */
export function applyTheme(name, duration = 800, keepInline = false) {
  const target = THEMES[name]
  if (!target) return
  // 起始值快照必须先于 data-theme 翻转读取：上次过渡结束时会清掉内联值，
  // 若先翻属性再读，读到的是目标主题，「从=到」，渐变退化为瞬时跳变
  const from = readCurrentValues(Object.keys(target))
  if (name !== 'gold') document.documentElement.setAttribute('data-theme', name)
  applyThemeVars(target, duration, keepInline, from)
}

/**
 * 浅色 ↔ 深色主题渐变切换（兼容旧调用，system 模式自动判断）。
 * 黄金模式激活时：背景随主题切换、文字/按钮保持金色（一次渐变，避免闪烁）。
 * @param {'light'|'dark'|'system'} mode - 目标主题模式
 * @param {number} [duration=800] - 动画时长 ms
 */
export function changeThemeWithTransition(mode, duration = 800) {
  const isDark = mode === 'system' ? modeIsDark('system') : mode === 'dark'
  const name = isDark ? 'dark' : 'light'
  const root = document.documentElement
  const goldenActive = root.getAttribute('data-golden') === '1'
  const target = goldenActive ? { ...THEMES[name], ...THEMES.gold } : THEMES[name]
  // 快照同样必须先于属性翻转（理由同 applyTheme）
  const from = readCurrentValues(Object.keys(target))
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', name)
  if (goldenActive) {
    // 黄金保持：背景/中性用目标主题，文字/按钮用金色
    root.setAttribute('data-golden', '1')
    applyThemeVars(target, duration, true, from)
  } else {
    applyThemeVars(target, duration, false, from)
  }
}

/**
 * 黄金模式：进入时字体/按钮变金色（背景不变，保留内联金色并标记 data-golden）；
 * 退出时恢复原主题。
 * @param {boolean} golden - true 进入黄金 / false 恢复
 * @param {number} [duration=900] - 动画时长 ms
 */
export function applyGolden(golden, duration = 900) {
  const root = document.documentElement
  if (golden) {
    root.setAttribute('data-golden', '1')
    applyTheme('gold', duration, true)
  } else {
    root.removeAttribute('data-golden')
    const mode = detectThemeMode()
    applyTheme(mode === 'system' ? (modeIsDark('system') ? 'dark' : 'light') : (mode === 'dark' ? 'dark' : 'light'), duration)
  }
}

// 保留检测工具，供其它模块引用
export { modeIsDark, detectThemeMode }
