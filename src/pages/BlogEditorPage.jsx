import { useState, useEffect, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import CategoryDropdown from '../components/CategoryDropdown'
import { renderMd } from '../utils/markdown'
import { apiFetch } from '../utils/api'
import CodeEditor from '../components/CodeEditor'
import Modal from '../components/Modal'
import { UiIcon } from '../components/Icons'
import { BLOG_CATEGORIES } from '../constants'
import { t } from '../i18n'
import './Blog.css'

function BlogEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isEdit = Boolean(id)
  const textareaRef = useRef(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [content, setContent] = useState('')
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [user, setUser] = useState(null)
  const [imageModalOpen, setImageModalOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) navigate('/login')
    const raw = localStorage.getItem('user')
    if (raw) {
      try { setUser(JSON.parse(raw)) } catch { setUser(null) }
    }
  }, [navigate])

  useEffect(() => {
    if (!isEdit) return
    fetch(`/api/blogs/${id}`)
      .then(r => r.json())
      .then(data => {
        setTitle(data.title)
        setCategory(data.category || '')
        setContent(data.content_md)
        setProjectId(data.project_id || '')
      })
      .catch(() => setError(t('blogEditor.loadFailed')))
      .finally(() => setLoading(false))
  }, [id, isEdit])

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => {})
  }, [])

  const handleInsertImage = () => {
    setImageUrl('')
    setImageModalOpen(true)
  }

  const confirmInsertImage = () => {
    const url = imageUrl.trim()
    if (!url) return
    const ta = textareaRef.current
    const imgTag = `\n![图片](${url})\n`
    if (!ta) {
      setContent(c => c + imgTag)
      setImageModalOpen(false)
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const newContent = content.slice(0, start) + imgTag + content.slice(end)
    setContent(newContent)
    setImageModalOpen(false)
    setTimeout(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = start + imgTag.length
    }, 0)
  }

  const handleSave = async () => {
    if (!title.trim()) { setError(t('blogEditor.titleRequired')); return }
    if (!content.trim()) { setError(t('blogEditor.contentRequired')); return }
    setSaving(true)
    setError('')

    try {
      const url = isEdit ? `/api/blogs/${id}` : '/api/blogs'
      const method = isEdit ? 'PUT' : 'POST'
      const res = await apiFetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          category: category || '',
          content_md: content,
          project_id: projectId === '' ? null : projectId,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.detail || t('blogEditor.saveFailed')); return }
      navigate(isEdit ? `/blogs/${id}` : `/blogs/${data.id}`)
    } catch {
      setError(t('blogEditor.networkError'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="blog-page">
        <div className="blog-main"><div className="blog-loading">{t('blogEditor.loading')}</div></div>
      </div>
    )
  }

  return (
    <div className="blog-page">
      <Navbar activePage="blog" />

      <div className="blog-main">
          <div className="blog-editor">
            <div className="editor-header">
              <Link to="/blogs" className="blog-back-link">&larr; {t('blogEditor.backToList')}</Link>
            </div>
            <h1 className="editor-title">{isEdit ? t('blogEditor.editTitle') : t('blogEditor.newTitle')}</h1>

          {error && <div className="form-server-error">{error}</div>}

          <div className="editor-field">
            <input
              type="text"
              className="editor-title-input"
              placeholder={t('blogEditor.titlePlaceholder')}
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>

          <div className="editor-toolbar">
            <button type="button" className="toolbar-btn" onClick={handleInsertImage} title={t('blogEditor.insertImage')}>
              <UiIcon name="image" size={15} /> {t('blogEditor.imageBed')}
            </button>
            <span className="toolbar-hint">{t('blogEditor.markdownHint')}</span>
          </div>

          <div className="editor-split">
            <div className="editor-pane">
              <CodeEditor
                textareaRef={textareaRef}
                value={content}
                onChange={setContent}
                placeholder={t('blogEditor.contentPlaceholder')}
              />
            </div>
            <div className="editor-pane preview-pane">
              <div className="preview-label">{t('blogEditor.preview')}</div>
              <div
                className="markdown-body preview-content"
                dangerouslySetInnerHTML={{ __html: renderMd(content) || `<p style="color:var(--text-muted)">${t('blogEditor.previewEmpty')}</p>` }}
              />
            </div>
          </div>

          <div className="editor-actions">
            <CategoryDropdown
              value={category}
              onChange={setCategory}
              options={BLOG_CATEGORIES.map(c => ({ value: c, label: c }))}
              placeholder={t('blogEditor.noCategory')}
            />
            <CategoryDropdown
              value={projects.find(p => p.id === projectId)?.name || ''}
              onChange={(v) => setProjectId(v === '' ? '' : Number(v))}
              options={projects.map(p => ({ value: String(p.id), label: p.name }))}
              placeholder={t('blogEditor.noProject')}
            />
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t('blogEditor.saving') : (isEdit ? t('blogEditor.saveChanges') : t('blogEditor.publish'))}
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={imageModalOpen}
        title={t('blogEditor.imageBed')}
        confirmText={t('blogEditor.insertImage')}
        onCancel={() => setImageModalOpen(false)}
        onConfirm={confirmInsertImage}
        confirmDisabled={!imageUrl.trim()}
      >
        <p className="modal-hint">{t('blogEditor.imagePrompt')}</p>
        <input
          type="text"
          className="modal-input"
          placeholder="https://"
          value={imageUrl}
          onChange={e => setImageUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirmInsertImage() }}
          autoFocus
        />
      </Modal>
    </div>
  )
}

export default BlogEditorPage
