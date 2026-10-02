// api.js — fetch 封装：统一携带 Bearer 鉴权头；401 自动清凭证并回登录页
// 登录 / 注册 / 重置密码等 401 属正常业务响应的公开接口不要走 apiFetch。

// token 剩余有效期低于该阈值时静默换新（后端有效期 30 天，活跃用户永远遇不到 401）
const REFRESH_REMAIN_MS = 15 * 24 * 3600 * 1000

let refreshing = null

export function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` }
}

/** 临近过期的 token 静默换新（fire-and-forget）；失败不打扰用户，下次请求再试 */
function maybeRefresh() {
  const token = localStorage.getItem('token')
  if (!token || refreshing) return
  let exp = 0
  try {
    exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000
  } catch {
    return
  }
  if (exp - Date.now() > REFRESH_REMAIN_MS) return
  refreshing = fetch('/api/refresh', { headers: { Authorization: `Bearer ${token}` } })
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data?.access_token) {
        localStorage.setItem('token', data.access_token)
        if (data.user) localStorage.setItem('user', JSON.stringify(data.user))
      }
    })
    .catch(() => {})
    .finally(() => { refreshing = null })
}

export async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (localStorage.getItem('token')) Object.assign(headers, authHeaders())
  const res = await fetch(url, { ...opts, headers })
  if (res.status === 401) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.location.href = '/auth'
    throw new Error('未登录或登录已过期')
  }
  maybeRefresh()
  return res
}
