// themes.js — 主题定义（唯一权威来源）
// 所有主题色变量集中于此；新增主题只需在此追加一组变量，切换即自动渐变。
// index.css 中 :root / data-theme / @media 的静态定义与本文件同步维护，仅作无 JS 时的兜底。
// Corporate Clean（企业简洁风）：浅色 slate/白 + blue-600 主色；深色 slate + blue-500。

export const THEMES = {
  light: {
    '--bg-primary': '#f8fafc',
    '--bg-card': '#ffffff',
    '--bg-elevated': '#f1f5f9',
    '--text-primary': '#111827',
    '--text-secondary': '#4b5563',
    '--text-muted': '#6b7280',
    '--accent-1': '#2563eb',
    '--accent-1-light': '#3b82f6',
    '--accent-1-hover': '#1d4ed8',
    '--accent-1-soft': 'rgba(37, 99, 235, 0.08)',
    '--accent-1-soft-strong': 'rgba(37, 99, 235, 0.12)',
    '--accent-1-border': 'rgba(37, 99, 235, 0.35)',
    '--accent-2': '#0284c7',
    '--accent-2-hover': '#0369a1',
    '--accent-2-soft': 'rgba(2, 132, 199, 0.10)',
    '--danger': '#dc2626',
    '--danger-hover': '#b91c1c',
    '--danger-soft': 'rgba(220, 38, 38, 0.08)',
    '--danger-soft-strong': 'rgba(220, 38, 38, 0.12)',
    '--danger-border': 'rgba(220, 38, 38, 0.3)',
    '--info': '#2563eb',
    '--bg-dot-color': 'rgba(15, 23, 42, 0.07)',
    '--bg-halo-color': 'rgba(37, 99, 235, 0.10)',
    '--white': '#ffffff',
    '--border-color': '#e5e7eb',
    '--neutral-soft': '#f3f4f6',
    '--neutral-soft-hover': '#e5e7eb',
    '--overlay': 'rgba(15, 23, 42, 0.5)',
    '--glow-accent': 'rgba(37, 99, 235, 0.10)',
    '--glow-accent-strong': 'rgba(37, 99, 235, 0.25)',
    '--glow-cyan': 'rgba(2, 132, 199, 0.08)',
    '--glow-cyan-strong': 'rgba(2, 132, 199, 0.25)',
    '--progress-gradient': 'linear-gradient(90deg, #2563eb, #3b82f6)',
  },
  dark: {
    '--bg-primary': '#0f172a',
    '--bg-card': '#1e293b',
    '--bg-elevated': '#243244',
    '--text-primary': '#f1f5f9',
    '--text-secondary': '#cbd5e1',
    '--text-muted': '#94a3b8',
    '--accent-1': '#3b82f6',
    '--accent-1-light': '#60a5fa',
    '--accent-1-hover': '#2563eb',
    '--accent-1-soft': 'rgba(59, 130, 246, 0.16)',
    '--accent-1-soft-strong': 'rgba(59, 130, 246, 0.24)',
    '--accent-1-border': 'rgba(59, 130, 246, 0.45)',
    '--accent-2': '#0ea5e9',
    '--accent-2-hover': '#38bdf8',
    '--accent-2-soft': 'rgba(14, 165, 233, 0.18)',
    '--danger': '#ef4444',
    '--danger-hover': '#f87171',
    '--danger-soft': 'rgba(248, 113, 113, 0.14)',
    '--danger-soft-strong': 'rgba(248, 113, 113, 0.22)',
    '--danger-border': 'rgba(248, 113, 113, 0.4)',
    '--info': '#60a5fa',
    '--bg-dot-color': 'rgba(148, 163, 184, 0.07)',
    '--bg-halo-color': 'rgba(59, 130, 246, 0.12)',
    '--white': '#ffffff',
    '--border-color': '#334155',
    '--neutral-soft': '#334155',
    '--neutral-soft-hover': '#46536b',
    '--overlay': 'rgba(2, 6, 23, 0.6)',
    '--glow-accent': 'rgba(59, 130, 246, 0.16)',
    '--glow-accent-strong': 'rgba(59, 130, 246, 0.4)',
    '--glow-cyan': 'rgba(14, 165, 233, 0.12)',
    '--glow-cyan-strong': 'rgba(14, 165, 233, 0.4)',
    '--progress-gradient': 'linear-gradient(90deg, #3b82f6, #0ea5e9)',
  },
  // 黄金主题：字体/按钮变金色（背景保持当前主题不变，故不定义背景键）——彩蛋保留，不受 Corporate Clean 约束
  gold: {
    '--text-primary': '#b8860b',
    '--text-secondary': '#c9a45a',
    '--text-muted': '#a0863a',
    '--border-color': '#e8d28a',
    '--neutral-soft': '#f5e6b0',
    '--neutral-soft-hover': '#ecd89a',
    '--accent-1': '#d4a400',
    '--accent-1-light': '#f0c23a',
    '--accent-1-hover': '#b89100',
    '--accent-1-soft': 'rgba(212, 164, 0, 0.15)',
    '--accent-1-soft-strong': 'rgba(212, 164, 0, 0.22)',
    '--accent-1-border': 'rgba(212, 164, 0, 0.45)',
    '--accent-2': '#c99600',
    '--accent-2-hover': '#b88100',
    '--accent-2-soft': 'rgba(201, 150, 0, 0.18)',
    '--glow-accent': 'rgba(212, 164, 0, 0.12)',
    '--glow-accent-strong': 'rgba(212, 164, 0, 0.45)',
    '--glow-cyan': 'rgba(201, 150, 0, 0.08)',
    '--glow-cyan-strong': 'rgba(201, 150, 0, 0.4)',
    '--progress-gradient': 'linear-gradient(90deg, #d4a400, #f0c23a)',
  },
}

// 主题键集合（供插值引擎使用）
export const THEME_KEYS = Object.keys(THEMES.light)

// 解析当前主题模式（localStorage theme: light/dark/system）
export function detectThemeMode() {
  return localStorage.getItem('theme') || 'system'
}

// 判断某模式是否实际为深色
export function modeIsDark(mode) {
  return mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

// 解析颜色为 [r,g,b,a]，支持 hex / rgb / rgba
export function parseColor(str) {
  const s = (str || '').trim()
  const hex = s.match(/^#([0-9a-fA-F]{6})$/)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const rgba = s.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?/)
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] !== undefined ? Number(rgba[4]) : 1]
  return null
}
