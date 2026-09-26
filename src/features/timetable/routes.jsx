import TimetablePage from './TimetablePage'

// 静态段优先于 CampusServicePage 的 /tools/campus-service/:feature 动态段，
// 无需改动校园服务页的 VALID_FEATURES；课程表不依赖 VPN，由校园服务主页入口卡进入
export default [
  { path: '/tools/campus-service/timetable', element: <TimetablePage /> },
]
