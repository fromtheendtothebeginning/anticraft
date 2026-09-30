import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import Modal from '../components/Modal'
import ProjectCover from '../components/ProjectCover'
import Reveal from '../components/Reveal'
import CommentSection from '../components/CommentSection'
import { renderMd, sanitizeUrl } from '../utils/markdown'
import { apiFetch } from '../utils/api'
import { fmtDate, fmtDateLong } from '../utils/format'
import { UiIcon } from '../components/Icons'
import { t } from '../i18n'
import './Project.css'

function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [user, setUser] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  // 点赞 / 关注
  const [projectLikePending, setProjectLikePending] = useState(false)
  const [projectFollowPending, setProjectFollowPending] = useState(false)

  useEffect(() => {
    const raw = localStorage.getItem('user')
    if (raw) {
      try { setUser(JSON.parse(raw)) } catch { setUser(null) }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/api/projects/${id}`)
      .then(r => {
        if (!r.ok) throw new Error(t('projectDetail.notFound'))
        return r.json()
      })
      .then(data => { if (!cancelled) setProject(data) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/projects/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.detail || t('projectDetail.deleteFailed'))
        return
      }
      navigate('/projects')
    } catch {
      alert(t('projectDetail.networkError'))
    } finally {
      setDeleting(false)
    }
  }

  const handleProjectLike = async () => {
    if (!user) {
      navigate('/auth')
      return
    }
    if (projectLikePending || !project) return
    setProjectLikePending(true)
    // 乐观更新
    const prevLiked = project.liked_by_me
    const prevCount = project.like_count
    setProject({
      ...project,
      liked_by_me: !prevLiked,
      like_count: prevLiked ? prevCount - 1 : prevCount + 1,
    })
    try {
      const res = await apiFetch(`/api/projects/${id}/like`, {
        method: 'POST',
      })
      if (!res.ok) {
        setProject({ ...project, liked_by_me: prevLiked, like_count: prevCount })
        const data = await res.json().catch(() => ({}))
        alert(data.detail || t('projectDetail.operationFailed'))
        return
      }
      const data = await res.json()
      setProject(p => p ? { ...p, liked_by_me: data.liked, like_count: data.like_count } : p)
    } catch {
      setProject({ ...project, liked_by_me: prevLiked, like_count: prevCount })
      alert(t('projectDetail.networkError'))
    } finally {
      setProjectLikePending(false)
    }
  }

  const handleProjectFollow = async () => {
    if (!user) {
      navigate('/auth')
      return
    }
    if (projectFollowPending || !project) return
    setProjectFollowPending(true)
    // 乐观更新
    const prevFollowed = project.followed_by_me
    const prevCount = project.follow_count
    setProject({
      ...project,
      followed_by_me: !prevFollowed,
      follow_count: prevFollowed ? prevCount - 1 : prevCount + 1,
    })
    try {
      const res = await apiFetch(`/api/projects/${id}/follow`, {
        method: 'POST',
      })
      if (!res.ok) {
        setProject({ ...project, followed_by_me: prevFollowed, follow_count: prevCount })
        const data = await res.json().catch(() => ({}))
        alert(data.detail || t('projectDetail.operationFailed'))
        return
      }
      const data = await res.json()
      setProject(p => p ? { ...p, followed_by_me: data.followed, follow_count: data.follow_count } : p)
    } catch {
      setProject({ ...project, followed_by_me: prevFollowed, follow_count: prevCount })
      alert(t('projectDetail.networkError'))
    } finally {
      setProjectFollowPending(false)
    }
  }

  const isAuthor = user && project && user.id === project.author_id
  const isAdmin = user && user.role === 'admin'

  if (loading) {
    return (
      <div className="project-page">
        <div className="project-main"><div className="blog-loading">{t('projectDetail.loading')}</div></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="project-page">
        <div className="project-main">
          <div className="blog-error">
            <h2>{error}</h2>
            <Link to="/projects" className="btn btn-primary">{t('projectDetail.backToList')}</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="project-page">
      <Navbar activePage="project" />
      <div className="project-main">
        <div className="project-detail">
          <div className="blog-detail-nav">
            <Link to="/projects" className="blog-back-link">{t('projectDetail.backToList')}</Link>
          </div>

          <Reveal>
            {project.cover_url ? (
              <ProjectCover src={project.cover_url} alt={project.name} className="project-detail-cover" bgColor={project.bg_color} />
            ) : (
              <div className="project-detail-cover project-cover-placeholder">
                {project.name.charAt(0)}
              </div>
            )}
          </Reveal>

          <Reveal as="h1" className="project-detail-title">{project.name}</Reveal>
          {project.tags && project.tags.length > 0 && (
            <Reveal className="project-detail-tags">
              {project.tags.map(t => <span key={t} className="tag">{t}</span>)}
            </Reveal>
          )}
          <Reveal className="blog-detail-meta">
            <span className="blog-detail-author">
              {t('projectDetail.authorLabel', { name: project.author?.nickname || project.author?.username || t('projectDetail.anonymous') })}
            </span>
            <span className="blog-detail-date">
              {fmtDateLong(project.created_at)}
            </span>
          </Reveal>

          {(isAuthor || isAdmin) && (
            <div className="project-actions">
              <Link to={`/projects/${project.id}/edit`} className="btn-edit">{t('projectDetail.edit')}</Link>
              <button className="btn-delete" onClick={() => setShowDeleteModal(true)} disabled={deleting}>
                {deleting ? t('projectDetail.deleting') : t('projectDetail.delete')}
              </button>
            </div>
          )}

          {(project.links && project.links.length > 0) && (
            <div className="project-actions project-link-actions">
              {project.links.filter(l => sanitizeUrl(l.url)).map((l, i) => (
                <a
                  key={i}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="project-link-btn"
                >
                  {/github\.com/i.test(l.url) ? t('projectDetail.linkGithub') : `${l.name} ↗`}
                </a>
              ))}
            </div>
          )}
          {(!(project.links && project.links.length > 0) && sanitizeUrl(project.link_url)) && (
            <div className="project-actions">
              <a
                href={project.link_url}
                target="_blank"
                rel="noopener noreferrer"
                className="project-link-btn"
              >
                {/github\.com/i.test(project.link_url) ? t('projectDetail.linkGithub') : t('projectDetail.linkDefault')}
              </a>
            </div>
          )}

          {project.description && (
            <div
              className="markdown-body project-description"
              dangerouslySetInnerHTML={{ __html: renderMd(project.description) }}
            />
          )}

          <section className="project-blogs">
            <h3 className="project-blogs-title">{t('projectDetail.relatedBlogs')}</h3>
            {project.blogs && project.blogs.length === 0 ? (
              <div className="project-blogs-empty">{t('projectDetail.noRelatedBlogs')}</div>
            ) : (
              <div className="project-blogs-list">
                {project.blogs.map(blog => (
                  <Link key={blog.id} to={`/blogs/${blog.id}`} className="project-blog-item">
                    <span className="project-blog-title">{blog.title}</span>
                    {blog.category && <span className="project-blog-category">{blog.category}</span>}
                    <span className="project-blog-date">
                      {fmtDate(blog.created_at)}
                    </span>
                    <span className="project-blog-stats">
                      <UiIcon name="heart" size={13} /> {blog.like_count || 0} · <UiIcon name="message" size={13} /> {blog.comment_count || 0}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <div className="project-actions">
            <button
              className={`project-like-btn ${project.liked_by_me ? 'liked' : ''}`}
              onClick={handleProjectLike}
              disabled={projectLikePending}
            >
              <span><UiIcon name="heart" filled={project.liked_by_me} size={14} /></span>
              <span>{project.like_count || 0}</span>
            </button>
            {user && project && user.id !== project.author_id && (
              <button
                className={`project-follow-btn ${project.followed_by_me ? 'followed' : ''}`}
                onClick={handleProjectFollow}
                disabled={projectFollowPending}
              >
                {project.followed_by_me ? t('projectDetail.followed') : t('projectDetail.follow')} {project.follow_count > 0 ? `(${project.follow_count})` : ''}
              </button>
            )}
          </div>

          {/* 评论区（共享组件） */}
          <CommentSection
            commentsUrl={`/api/projects/${id}/comments`}
            currentUser={user}
            i18nPrefix="projectDetail"
            sectionClassName="project-comments comments-section"
          />
        </div>
      </div>

      <Modal
        open={showDeleteModal}
        title={t('projectDetail.confirmDelete')}
        message={t('projectDetail.deleteConfirmMessage')}
        confirmText={deleting ? t('projectDetail.deleting') : t('projectDetail.confirmDelete')}
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteModal(false)}
      />
    </div>
  )
}

export default ProjectDetailPage
