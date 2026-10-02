import { useState, useRef, useEffect } from 'react'
import { t } from '../i18n'

/**
 * 统一分类/选项下拉选择器（复用 App.css 的 .nav-dropdown / .category-btn 体系）。
 * 所有分类/选项选择场景统一使用本组件，避免各处手写重复结构。
 * 默认：桌面端悬停展开（CSS :hover），移动端（≤768px）点击展开（.mobile-open 控制显隐）。
 *
 * @param {string} value - 当前选中值（显示在按钮上）
 * @param {function(string)} onChange - 选择回调（参数为选项 value，清空时传 ''）
 * @param {Array<{value: string, label: string}>} options - 选项列表
 * @param {string} [placeholder='未分类'] - 未选中时按钮显示文案（也是菜单第一项「清除」的文案）
 * @param {'default'|'sm'} [size='default'] - 尺寸：default 常规 / sm 小号（卡片等紧凑场景）
 * @param {boolean} [hideClear=false] - 为 true 时不显示菜单第一项「清除」入口（如必须选其一且不可清空的场景）
 * @param {boolean} [closeOnSelect=false] - 为 true 时选中后立即收起菜单（鼠标离开后恢复 hover）
 * @param {boolean} [popover=false] - 受限容器（弹窗表单等）内使用：菜单改为 fixed 定位贴着触发按钮弹出，
 *   按最近 .modal-sheet 钳制边界（下方放不下自动向上翻、限高滚动），点击组件外部收起；
 *   菜单 DOM 与默认模式同源复用，只是定位/开合策略不同
 *
 * 用法示例：
 *   <CategoryDropdown
 *     value={category}
 *     onChange={setCategory}
 *     options={[{ value: '技术讨论', label: '技术讨论' }, { value: '更新日志', label: '更新日志' }]}
 *     placeholder="无"
 *   />
 */
function CategoryDropdown({ value, onChange, options = [], placeholder = t('categoryDropdown.placeholder'), size = 'default', hideClear = false, closeOnSelect = false, popover = false }) {
  // 选项列表开合（popover 模式下全端点击开合；默认模式桌面端走 CSS hover）
  const [open, setOpen] = useState(false)
  // 选中后收起：桌面端 hover 菜单在选中后临时隐藏，鼠标离开后恢复可 hover
  const [justPicked, setJustPicked] = useState(false)
  // popover 模式：按触发按钮位置计算的 fixed 菜单定位参数
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const btnRef = useRef(null)

  const pick = (v) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    onChange(v)
    setOpen(false)
    setPos(null)
    // popover 模式靠点击开合、没有 hover 冲突，进入 just-picked 反而会压住重开的菜单
    //（触摸/程序化移动鼠标时 mouseleave 不触发，菜单一直隐形）
    if (closeOnSelect && !popover) setJustPicked(true)
  }

  const close = () => {
    setOpen(false)
    setPos(null)
  }

  const toggle = () => {
    if (popover) {
      if (!open && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect()
        // 有底板容器（如 .modal-sheet）时菜单被钳制在底板内，否则以视口为界
        const sheet = btnRef.current.closest('.modal-sheet')
        const sRect = sheet ? sheet.getBoundingClientRect() : { top: 8, bottom: window.innerHeight - 8 }
        const below = sRect.bottom - r.bottom - 10
        const above = r.top - sRect.top - 10
        let openUp = false
        let space = below
        if (below < 140 && above > below) {
          openUp = true
          space = above
        }
        const maxH = Math.max(120, Math.min(264, space))
        setPos({
          left: Math.max(6, Math.min(r.left, window.innerWidth - 150)),
          minWidth: Math.max(r.width, 130),
          maxH,
          up: openUp,
          ...(openUp ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
        })
      }
      setOpen(o => !o)
      return
    }
    if (window.innerWidth < 768) setOpen(o => !o)
  }

  // popover 模式：mousedown 在组件外即收起（不用透明垫层拦截点击，
  // 这样点其他触发钮时本次点击正常送达，不会「点一下只收起、再点才展开」）
  useEffect(() => {
    if (!popover || !open) return
    const onDocMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [popover, open])

  const menuItems = (
    <>
      {!hideClear && <a href="#" onClick={pick('')}>{placeholder}</a>}
      {options.map(opt => (
        <a key={opt.value} href="#" onClick={pick(opt.value)}>{opt.label}</a>
      ))}
    </>
  )

  // 菜单 DOM 唯一一份；popover 展开时仅叠加 fixed 定位/显隐的内联样式
  const menuStyle = popover && open && pos
    ? {
      position: 'fixed',
      // 全局 .nav-dropdown-menu 有 top:100%，向上弹出时必须显式置 auto，否则过度约束把菜单顶出视口
      top: pos.up ? 'auto' : pos.top,
      bottom: pos.up ? pos.bottom : 'auto',
      left: pos.left,
      minWidth: pos.minWidth,
      maxHeight: pos.maxH,
      overflowY: 'auto',
      opacity: 1,
      visibility: 'visible',
      transform: 'none',
      display: 'block',
      zIndex: 1100,
    }
    : undefined

  return (
    <div
      ref={rootRef}
      className={`nav-dropdown category-dropdown ${open ? 'mobile-open' : ''} ${justPicked ? 'just-picked' : ''}`}
      onClick={e => e.stopPropagation()}
      onMouseLeave={() => setJustPicked(false)}
    >
      <button ref={btnRef} type="button" className={`category-btn${size === 'sm' ? ' category-btn-sm' : ''}`} onClick={toggle}>
        {options.find(o => o.value === value)?.label || value || placeholder}
        <span className="arrow-down">▾</span>
      </button>
      {/* popover 模式关闭时不渲染菜单：全局 .nav-dropdown:hover 会把隐藏菜单显形，
          导致悬停一个触发钮时其他（或自身的）幽灵菜单闪现 */}
      {(popover ? open : true) && (
        <div className="nav-dropdown-menu" style={menuStyle}>{menuItems}</div>
      )}
    </div>
  )
}

export default CategoryDropdown
