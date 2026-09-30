// userData.js — 按用户隔离的小型数据云端存储客户端（后端 /api/user-data）
// 用途：「上次查询结果缓存 / 用户偏好 / 进度」等跟随账号的数据 —— 换设备/换浏览器都在，
//       替代按 user.id 拼 key 的 localStorage 缓存（启动时 user 对象被异步改写，拼 key 有竞态）。
// 内存做 L1：本会话内重复读取不打网络；写为 best-effort，失败静默（缓存不阻塞主流程）。
// 注意：值须为 JSON 对象、≤64KB；大型/需结构化查询的数据建专用表，不要塞进这里。

import { apiFetch } from './api'

const BASE = '/api/user-data'
const mem = new Map()

export async function getUserData(key) {
  if (mem.has(key)) return mem.get(key)
  try {
    const res = await apiFetch(`${BASE}/${key}`)
    if (!res.ok) return null
    const b = await res.json()
    mem.set(key, b.data || null)
    return b.data || null
  } catch {
    return null
  }
}

export function putUserData(key, data) {
  mem.set(key, data)
  return apiFetch(`${BASE}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  }).catch(() => {})
}

export function delUserData(key) {
  mem.delete(key)
  return apiFetch(`${BASE}/${key}`, { method: 'DELETE' }).catch(() => {})
}
