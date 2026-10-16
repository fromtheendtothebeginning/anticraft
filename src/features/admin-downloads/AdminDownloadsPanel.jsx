import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '../../components/Modal'
import ActionButton from '../../components/ActionButton'
import { t } from '../../i18n'
import { apiFetch } from '../../utils/api'
import { fmtDateTimeMinute } from '../../utils/format'
import './AdminDownloadsPanel.css'

/**
 * 「管理后台 → 文件下载」面板：上传文件到服务器，生成公开下载链接。
 * POST/GET /api/admin/downloads · PUT/DELETE /api/admin/downloads/{id}（均需管理员）
 * 公开下载走 GET /api/dl/{token}（无需登录，token 即凭据）。
 */

const MAX_MB = 10

function fmtSize(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const fullUrl = (path) => `${window.location.origin}${path}`

export default function AdminDownloadsPanel() {
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(false)
  const [files, setFiles] = useState([])
  const [uploadFile, setUploadFile] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [created, setCreated] = useState(null)     // 上传成功后的链接弹窗
  const [editing, setEditing] = useState(null)     // { id, name, note, file }
  const [confirm, setConfirm] = useState(null)     // 删除确认
  const [copied, setCopied] = useState('')         // 正在显示「已复制」的 key
  const uploadInput = useRef(null)
  const editInput = useRef(null)
  const copiedTimer = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(false)
    try {
      const res = await apiFetch('/api/admin/downloads')
      const body = await res.json().catch(() => null)
      if (!res.ok || !body) { setLoadErr(true); return }
      setFiles(body.files || [])
    } catch {
      setLoadErr(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyText = (text, key) => {
    const done = () => {
      setCopied(key)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(''), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => done())
    } else {
      done()
    }
  }

  const pickUpload = (e) => {
    setErr('')
    const f = e.target.files?.[0] || null
    if (f && f.size > MAX_MB * 1024 * 1024) {
      setErr(t('adminDownloads.err.tooLarge', { size: MAX_MB }))
      e.target.value = ''
      setUploadFile(null)
      return
    }
    setUploadFile(f)
  }

  const handleUpload = async () => {
    setErr('')
    if (!uploadFile) { setErr(t('adminDownloads.err.pickFile')); return }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      if (note.trim()) fd.append('note', note.trim())
      const res = await apiFetch('/api/admin/downloads', { method: 'POST', body: fd })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setErr(t('adminDownloads.err.uploadFailed', { error: body?.detail || t('adminDownloads.err.network') }))
        return
      }
      setUploadFile(null)
      setNote('')
      if (uploadInput.current) uploadInput.current.value = ''
      setCreated(body)
      load()
    } catch {
      setErr(t('adminDownloads.err.uploadFailed', { error: t('adminDownloads.err.network') }))
    } finally {
      setBusy(false)
    }
  }

  const openEdit = (f) => {
    setErr('')
    setEditing({ id: f.id, name: f.filename, note: f.note || '', file: null })
    if (editInput.current) editInput.current.value = ''
  }

  const pickEditFile = (e) => {
    setErr('')
    const f = e.target.files?.[0] || null
    if (f && f.size > MAX_MB * 1024 * 1024) {
      setErr(t('adminDownloads.err.tooLarge', { size: MAX_MB }))
      e.target.value = ''
      setEditing(prev => (prev ? { ...prev, file: null } : prev))
      return
    }
    setEditing(prev => (prev ? { ...prev, file: f } : prev))
  }

  const handleUpdate = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setErr(t('adminDownloads.err.nameRequired')); return }
    setBusy(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('name', editing.name.trim())
      fd.append('note', editing.note.trim())
      if (editing.file) fd.append('file', editing.file)
      const res = await apiFetch(`/api/admin/downloads/${editing.id}`, { method: 'PUT', body: fd })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setErr(t('adminDownloads.err.saveFailed', { error: body?.detail || t('adminDownloads.err.network') }))
        return
      }
      setEditing(null)
      load()
    } catch {
      setErr(t('adminDownloads.err.saveFailed', { error: t('adminDownloads.err.network') }))
    } finally {
      setBusy(false)
    }
  }

  const removeFile = async (f) => {
    setConfirm(null)
    setErr('')
    try {
      const res = await apiFetch(`/api/admin/downloads/${f.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setErr(t('adminDownloads.err.deleteFailed', { error: body?.detail || t('adminDownloads.err.network') }))
        return
      }
      load()
    } catch {
      setErr(t('adminDownloads.err.deleteFailed', { error: t('adminDownloads.err.network') }))
    }
  }

  return (
    <section className="adl-panel">
      <div className="adl-head">
        <h2>{t('adminDownloads.title')}</h2>
        <p className="adl-sub">{t('adminDownloads.subtitle')}</p>
      </div>

      <div className="adl-form">
        <label className="adl-pick">
          <input ref={uploadInput} type="file" onChange={pickUpload} />
          <span className="adl-pick-btn">{t('adminDownloads.pickFile')}</span>
          <span className={`adl-pick-name${uploadFile ? '' : ' is-empty'}`}>
            {uploadFile
              ? `${uploadFile.name} · ${fmtSize(uploadFile.size)}`
              : t('adminDownloads.noFile')}
          </span>
        </label>
        <input
          className="adl-note-input"
          type="text"
          maxLength={200}
          placeholder={t('adminDownloads.notePlaceholder')}
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <ActionButton onClick={handleUpload} disabled={busy}>
          {busy ? t('adminDownloads.uploading') : t('adminDownloads.upload')}
        </ActionButton>
        <p className="adl-hint">{t('adminDownloads.hint', { size: MAX_MB })}</p>
      </div>

      {err && <div className="adl-err">{err}</div>}

      {loading ? (
        <div className="adl-loading">{t('adminDownloads.loading')}</div>
      ) : loadErr ? (
        <div className="adl-err">
          {t('adminDownloads.loadFailed')}
          <div className="adl-err-ops">
            <ActionButton size="sm" onClick={load}>{t('adminDownloads.retry')}</ActionButton>
          </div>
        </div>
      ) : files.length === 0 ? (
        <div className="adl-empty">{t('adminDownloads.empty')}</div>
      ) : (
        <div className="adl-table">
          <div className="adl-row adl-row-head">
            <span>{t('adminDownloads.colFile')}</span>
            <span>{t('adminDownloads.colSize')}</span>
            <span>{t('adminDownloads.colDownloads')}</span>
            <span>{t('adminDownloads.colUploaded')}</span>
            <span>{t('adminDownloads.colActions')}</span>
          </div>
          {files.map(f => (
            <div key={f.id} className="adl-row">
              <span className="adl-cell-file">
                <strong>{f.filename}</strong>
                {f.note && <em className="adl-note">{f.note}</em>}
                <em className="adl-mono">{f.url}</em>
              </span>
              <span className="adl-num">{fmtSize(f.size)}</span>
              <span className="adl-num">{f.downloads}</span>
              <span className="adl-cell-time">
                {fmtDateTimeMinute(f.created_at)}
                {f.uploader && <em className="adl-note">{f.uploader}</em>}
              </span>
              <span className="adl-actions">
                <ActionButton
                  size="sm"
                  disabled={copied === `c${f.id}`}
                  onClick={() => copyText(fullUrl(f.url), `c${f.id}`)}
                >
                  {copied === `c${f.id}` ? t('adminDownloads.copied') : t('adminDownloads.copy')}
                </ActionButton>
                <ActionButton variant="secondary" size="sm" onClick={() => openEdit(f)}>
                  {t('adminDownloads.edit')}
                </ActionButton>
                <ActionButton
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirm(f)}
                >
                  {t('adminDownloads.delete')}
                </ActionButton>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 上传成功：链接已生成 */}
      <Modal
        open={!!created}
        title={t('adminDownloads.createdTitle')}
        showConfirm={false}
        cancelText={t('adminDownloads.close')}
        onCancel={() => { setCreated(null); setCopied('') }}
      >
        {created && (
          <>
            <p className="adl-modal-hint">{t('adminDownloads.createdHint')}</p>
            <div className="adl-link-box">
              <input className="adl-link-input" readOnly value={fullUrl(created.url)} onFocus={e => e.target.select()} />
              <ActionButton size="sm" onClick={() => copyText(fullUrl(created.url), 'new')}>
                {copied === 'new' ? t('adminDownloads.copied') : t('adminDownloads.copy')}
              </ActionButton>
            </div>
            <p className="adl-modal-hint">
              <a href={created.url} target="_blank" rel="noreferrer">{t('adminDownloads.openLink')}</a>
            </p>
          </>
        )}
      </Modal>

      {/* 编辑：改展示名 / 备注 / 替换文件 */}
      <Modal
        open={!!editing}
        title={t('adminDownloads.editTitle')}
        confirmText={busy ? t('adminDownloads.saving') : t('adminDownloads.save')}
        confirmDisabled={busy}
        onConfirm={handleUpdate}
        onCancel={() => { setEditing(null); setErr('') }}
      >
        {editing && (
          <>
            <div className="adl-field">
              <label htmlFor="adl-edit-name">{t('adminDownloads.editName')}</label>
              <input
                id="adl-edit-name"
                type="text"
                maxLength={200}
                value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div className="adl-field">
              <label htmlFor="adl-edit-note">{t('adminDownloads.editNote')}</label>
              <input
                id="adl-edit-note"
                type="text"
                maxLength={200}
                value={editing.note}
                onChange={e => setEditing({ ...editing, note: e.target.value })}
              />
            </div>
            <div className="adl-field">
              <label htmlFor="adl-edit-file">{t('adminDownloads.replaceFile')}</label>
              <input id="adl-edit-file" ref={editInput} type="file" onChange={pickEditFile} />
              {editing.file && <em className="adl-note">{editing.file.name} · {fmtSize(editing.file.size)}</em>}
            </div>
            <p className="adl-modal-hint">{t('adminDownloads.replaceHint')}</p>
          </>
        )}
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={!!confirm}
        danger
        title={t('adminDownloads.deleteTitle')}
        message={confirm ? t('adminDownloads.deleteConfirm', { name: confirm.filename }) : ''}
        confirmText={t('adminDownloads.delete')}
        onConfirm={() => removeFile(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </section>
  )
}
