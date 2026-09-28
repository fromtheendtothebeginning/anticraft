import { useEffect } from 'react'
import { t } from '../i18n'

/**
 * 统一弹窗组件 —— 复用 App.css 中的 .modal-overlay / .modal-sheet 样式（全局共享）。
 * 支持两种用法：
 *  1) 简单确认：只传 title + message + onConfirm/onCancel
 *  2) 自定义表单（二级界面）：传 children（替代 message），通过 showCancel/showConfirm 控制按钮
 *
 * @param {object} props
 * @param {boolean} props.open - 是否显示
 * @param {string} props.title - 标题
 * @param {string} [props.message] - 描述（无 children 时显示）
 * @param {ReactNode} [props.children] - 自定义内容（表单等），显示在标题下
 * @param {string} [props.confirmText='确认'] - 确认按钮文案
 * @param {string} [props.cancelText='取消'] - 取消按钮文案
 * @param {boolean} [props.danger=false] - 是否危险操作（红色按钮）
 * @param {boolean} [props.showConfirm=true] - 是否显示确认按钮
 * @param {boolean} [props.showCancel=true] - 是否显示取消按钮
 * @param {boolean} [props.confirmDisabled=false] - 确认按钮禁用
 * @param {boolean} [props.scrollBody=false] - 内容超高时限制弹窗高度并让内容区滚动（表单类弹窗用）
 * @param {function} props.onConfirm - 确认回调
 * @param {function} props.onCancel - 取消回调
 */
function Modal({
  open,
  title,
  message,
  children,
  confirmText = t('modal.confirm'),
  cancelText = t('modal.cancel'),
  danger = false,
  showConfirm = true,
  showCancel = true,
  confirmDisabled = false,
  scrollBody = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && onCancel) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className={`modal-sheet${scrollBody ? ' modal-sheet-scroll' : ''}`} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children != null ? (
          <div className="modal-body">{children}</div>
        ) : (
          <p>{message}</p>
        )}
        {(showConfirm || showCancel) && (
          <div className="modal-actions">
            {showCancel && (
              <button className="btn btn-secondary" onClick={onCancel}>{cancelText}</button>
            )}
            {showConfirm && (
              <button
                className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={onConfirm}
                disabled={confirmDisabled}
              >
                {confirmText}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default Modal
