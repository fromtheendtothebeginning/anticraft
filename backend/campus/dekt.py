# campus/dekt.py — 校园数据 HTTP 客户端（第二课堂分 / 成绩 / 校园卡动态码）
# 移植自 SCHOOLALY（server/app/dekt.py），裁剪：移除电费(openservice/SM4)相关全部逻辑。
# 域名走 campus.config.Config（默认 SIT），便于迁移他校。

import base64
import random
import re
import threading
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# 32 位十六进制 GUID：部分课程的 kcb_id 是内部 ID（如毛概），不能当课程代码展示
_GUID_RE = re.compile(r"^[0-9A-Fa-f]{32}$")


def readable_course_code(*candidates):
    """课程代码取人类可读的课程号：跳过 GUID 形态的 kcb_id，全部无效时返回空串"""
    for v in candidates:
        v = (v or "").strip()
        if v and not _GUID_RE.fullmatch(v):
            return v
    return ""


class DektError(Exception):
    pass


class PendingLogin:
    def __init__(self, http, login_url, fields, salt):
        self.http = http
        self.login_url = login_url
        self.fields = fields
        self.salt = salt
        self.captcha = None
        self.created_at = time.time()


class PendingJwxtLogin:
    def __init__(self, http, csrftoken, mm, captcha):
        self.http = http
        self.csrftoken = csrftoken
        self.mm = mm
        self.captcha = captcha
        self.created_at = time.time()


class DektClient:
    def __init__(self, user_id, socks_port, cfg, proxy_host="127.0.0.1"):
        self.user_id = user_id
        self.socks_port = socks_port
        self.proxy_host = proxy_host
        self.cfg = cfg
        self.aes_key = cfg.dekt_aes_key
        # 域名
        self.xg_base = cfg.xg_base
        self.xg_api = cfg.xg_base + "/zftal-xgxt-web"
        self.check_url = self.xg_api + "/teacher/xtgl/index/check.zf"
        self.current_user = self.xg_api + "/teacher/xtgl/login/getCurrentUser.zf"
        self.auth_base = cfg.auth_base
        self.score_url = self.xg_api + "/xsrdtjcx/getAllXslbTjcx.zf"
        self.jxw_base = cfg.jxw_base
        self.grades_url = self.jxw_base + "/jwglxt/cjcx/cjcx_cxXsgrcj.html"
        self.ecard_qr_url = cfg.ecard_base + "/epay/h5/v5qrcode"
        self.ecard_cas_service = cfg.ecard_base + "/epay/j_spring_cas_security_check"
        # 登录态（内存）
        self.session = None
        self.student_id = None
        self._password = ""
        self._hdms_cache = {}   # 活动说明缓存（详情接口写入，列表接口回填）
        self.pending = None
        self.jwxt_session = None
        self.jwxt_pending = None
        self.pending_kind = None
        self.lock = threading.Lock()

    def _http(self):
        s = requests.Session()
        s.verify = False
        s.headers["User-Agent"] = UA
        s.proxies = {
            "http": "socks5h://%s:%d" % (self.proxy_host, self.socks_port),
            "https": "socks5h://%s:%d" % (self.proxy_host, self.socks_port),
        }
        return s

    @staticmethod
    def _hidden_fields(html):
        fields = {}
        for name in ["execution", "_eventId", "lt", "rmShown", "dllt", "geolocation"]:
            m = re.search(r'name="%s"[^>]*value="([^"]*)"' % re.escape(name), html)
            if m:
                fields[name] = m.group(1)
        return fields

    @staticmethod
    def _find_salt(html):
        m = re.search(r'id="pwdDefaultEncryptSalt"[^>]*value="([^"]+)"', html)
        if m:
            return m.group(1)
        m = re.search(r'pwdDefaultEncryptSalt\s*=\s*["\']([^"\']+)["\']', html)
        return m.group(1) if m else ""

    @staticmethod
    def _wisedu_aes(text, salt):
        """金智 wisedu CAS 密码加密: AES-CBC-Pkcs7, key=salt, iv=随机16字符,
        明文=随机64字符前缀+密码, 输出 base64。"""
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import pad

        chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
        rds = lambda n: "".join(random.choice(chars) for _ in range(n))
        key = salt.strip().encode()[:16]
        iv = rds(16).encode()
        data = (rds(64) + text).encode()
        cipher = AES.new(key, AES.MODE_CBC, iv)
        return base64.b64encode(cipher.encrypt(pad(data, 16))).decode()

    @staticmethod
    def _decrypt_data(value, aes_key):
        if not aes_key:
            return value
        try:
            from Crypto.Cipher import AES

            key = iv = aes_key.encode()[:16]
            raw = base64.b64decode(value)
            text = AES.new(key, AES.MODE_CBC, iv).decrypt(raw)
            return text.rstrip(b"\x00").decode("utf-8")
        except Exception:
            return value

    def _parse_response(self, resp):
        try:
            obj = resp.json()
        except Exception:
            return resp.text
        if isinstance(obj, dict) and obj.get("isEncrypt"):
            key = obj.get("key") or "data"
            if isinstance(obj.get(key), str):
                obj[key] = self._decrypt_data(obj[key], self.aes_key)
        return obj

    # ==================== 统一认证 CAS（学工/校园卡共用） ====================

    def prepare_login(self, student_id, password):
        """开始 CAS 登录，返回待完成状态（含验证码图片 bytes）或 None(已登录)。"""
        with self.lock:
            self.student_id = student_id
            self._password = password
            if self.session is not None:
                return None
            s = self._http()
            try:
                r = s.get(self.check_url, timeout=30, allow_redirects=False)
            except requests.exceptions.RequestException:
                r = None
            if r is None:
                return self._prepare_direct(s)
            loc = r.headers.get("Location")
            if not loc:
                cu = s.get(self.current_user, timeout=30)
                if '"code":0' in cu.text:
                    self.session = s
                    return None
                return self._prepare_direct(s)
            r = s.get(loc, timeout=30)
            html = r.text
            fields = self._hidden_fields(html)
            salt = self._find_salt(html)
            fields.setdefault("dllt", "userNamePasswordLogin")
            fields.setdefault("_eventId", "submit")
            pending = PendingLogin(s, loc, fields, salt)
            try:
                cap = s.get(self.auth_base + "/captcha.html?ts=%d" % int(time.time() * 1000), timeout=20)
                pending.captcha = cap.content
            except Exception:
                pending.captcha = None
            self.pending = pending
            return pending

    def _prepare_direct(self, s):
        """直连 authserver 登录（service 指向 ecard SSO）"""
        url = self.auth_base + "/login?service=" + requests.utils.quote(self.ecard_cas_service, safe="")
        r = s.get(url, timeout=30)
        fields = self._hidden_fields(r.text)
        salt = self._find_salt(r.text)
        fields.setdefault("dllt", "userNamePasswordLogin")
        fields.setdefault("_eventId", "submit")
        pending = PendingLogin(s, url, fields, salt)
        try:
            cap = s.get(self.auth_base + "/captcha.html?ts=%d" % int(time.time() * 1000), timeout=20)
            pending.captcha = cap.content
        except Exception:
            pending.captcha = None
        self.pending = pending
        return pending

    def complete_login(self, student_id, captcha):
        """用验证码完成 CAS 登录"""
        with self.lock:
            pending = self.pending
            if pending is None:
                raise DektError("登录会话已过期，请重新查询")
            if time.time() - pending.created_at > 300:
                self.pending = None
                raise DektError("验证码已过期，请重新查询")
            s = pending.http
            pwd = self._wisedu_aes(self._password, pending.salt)
            data = {"username": student_id, "password": pwd, "captchaResponse": captcha or ""}
            data.update(pending.fields)
            post_url = pending.login_url.split("?")[0]
            resp = s.post(post_url, data=data, timeout=30, allow_redirects=True,
                          headers={"Referer": pending.login_url})
            self.pending = None
            cu = s.get(self.current_user, timeout=30)
            if '"code":0' not in cu.text:
                err = ""
                m = re.search(r'id="msg"[^>]*>(.*?)</(?:span|div)>', resp.text, re.S)
                if m:
                    err = m.group(1).strip()
                raise DektError(err or "统一认证登录失败（验证码错误或账号密码错误）")
            self.session = s
            self.student_id = student_id

    # ==================== 第二课堂分 ====================

    def fetch_score(self, student_id):
        """查询第二课堂得分（德智体美劳细分），返回结构化视图"""
        if not self.session:
            raise DektError("未登录")
        body = {"currentPage": "1", "pageSize": "15", "showCount": "10", "xh": student_id}
        # 不跟随跳转：会话失效时学工 302 到统一认证登录页，跟下去只会拿到那页 HTML
        resp = self.session.post(self.score_url, data=body, timeout=30, allow_redirects=False, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": self.xg_base + "/dektxf/xfqktj",
        })
        if resp.status_code in (301, 302, 303, 307, 308):
            self.session = None
            raise DektError("登录态失效，请重新查询")
        j = self._parse_response(resp)
        if not isinstance(j, dict):
            # 落到登录页等 HTML：会话已失效，清掉让下次查询重新登录，否则一直拿死会话重试
            self.session = None
            raise DektError("登录态失效，请重新查询")
        if j.get("code") != 0:
            raise DektError(j.get("msg") or "查询失败")
        return self._build_score_view(j)

    @staticmethod
    def _build_score_view(j):
        items = (j.get("queryModel") or {}).get("items") or []
        header = j.get("tableHeader") or []
        if not items:
            return {"student": {}, "total": None, "credit": None, "groups": []}
        it = items[0]
        groups = {}
        for h in header:
            fc = h.get("fieldCode") or ""
            name = h.get("fieldName") or fc
            grp = h.get("fieldTh") or "其他"
            if fc in ("xh", "xm", "nj", "bmmc", "zymc", "bjmc", "zxs", "sjxf", "sjxs"):
                continue
            g = groups.setdefault(grp, {"subtotal": None, "rows": []})
            if fc.startswith("dlxs"):
                g["subtotal"] = it.get(fc)
            elif fc.startswith("rdxs"):
                g["rows"].append({"name": name, "value": it.get(fc)})
        return {
            "student": {
                "xh": it.get("xh"), "xm": it.get("xm"), "nj": it.get("nj"),
                "bmmc": it.get("bmmc"), "zymc": it.get("zymc"), "bjmc": it.get("bjmc"),
            },
            "total": it.get("zxs"),
            "credit": it.get("sjxf"),
            "groups": [{"name": k, "subtotal": v["subtotal"], "rows": v["rows"]}
                       for k, v in groups.items()],
        }

    # ==================== 第二课堂活动（学工「活动报名」引导页） ====================
    # 适配自 Second_Class_Notification/sit_client.py：列表 + 详情(hdms 活动说明)

    def _xg_headers(self):
        return {
            "Origin": self.xg_base,
            "Referer": self.xg_base + "/hdgl/hdydlist",
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
        }

    def fetch_activities(self):
        """拉取活动引导页全部活动，按 大类/类别 展开为扁平列表（补充 _dlmc/_lbmc）"""
        if not self.session:
            raise DektError("未登录")
        url = self.xg_api + "/hdgl/getHdgcHdList.zf"
        try:
            resp = self.session.post(url, json={}, timeout=30, headers=self._xg_headers())
        except requests.exceptions.RequestException:
            raise DektError("学工系统响应超时，请重试")
        j = self._parse_response(resp)
        if not isinstance(j, dict) or j.get("code") != 0:
            self.session = None
            raise DektError("登录态失效，请重新查询")
        result = []
        for group in (j.get("data") or {}).get("resultList") or []:
            for lb in group.get("lblist") or []:
                for hd in lb.get("hdlist") or []:
                    hd = dict(hd)
                    hd["_dlmc"] = group.get("dlmc")
                    hd["_lbmc"] = lb.get("lbmc")
                    cached = self._hdms_cache.get(hd.get("id"))
                    if cached and not hd.get("hdms"):
                        hd["hdms"] = cached
                    result.append(hd)
        return result

    def fetch_activity_detail(self, hd_id):
        """获取单个活动详情（含 hdms 活动说明全文），说明写入缓存供列表复用"""
        if not self.session:
            raise DektError("未登录")
        try:
            resp = self.session.get(self.xg_api + "/hdgl/details.zf", params={"id": hd_id},
                                    timeout=30, headers=self._xg_headers())
        except requests.exceptions.RequestException:
            raise DektError("学工系统响应超时，请重试")
        j = self._parse_response(resp)
        if not isinstance(j, dict) or j.get("code") != 0:
            self.session = None
            raise DektError("登录态失效，请重新查询")
        data = j.get("data") or {}
        hdms = str(data.get("hdms") or "")
        if hdms:
            self._hdms_cache[hd_id] = hdms
        return data

    # ==================== 校园卡动态码 ====================

    def fetch_ecard_qr(self, codetype="O5"):
        """通过统一认证 SSO 获取校园卡动态码；服务端解析 #myText 并生成二维码 PNG。"""
        if not self.session:
            raise DektError("未登录")
        url = self.ecard_qr_url + "?codetype=%s" % codetype
        try:
            # 第一次：SSO 握手，建立 ecard 的 JSESSIONID
            self.session.get(url, timeout=30, allow_redirects=True)
            # 第二次：获取动态码页面
            r = self.session.get(url, timeout=30, allow_redirects=True)
        except requests.exceptions.RequestException:
            raise DektError("校园卡系统响应超时，请重试")
        ct = r.headers.get("Content-Type", "")
        if "image" in ct:
            return {"image": base64.b64encode(r.content).decode(), "type": ct, "refresh": 55}
        if r.url.startswith(self.auth_base.rstrip("/")):
            # SSO 握手停在统一认证登录页 = CAS 会话已失效，清掉让下次查询重新登录
            self.session = None
            raise DektError("登录态失效，请重新查询")
        m = re.search(r'id="myText"[^>]*value="([^"]+)"', r.text)
        if not m:
            raise DektError("未解析到动态码(%s %s)" % (r.status_code, ct))
        code = m.group(1)
        try:
            import io
            import qrcode as _qr
            img = _qr.make(code)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return {"image": base64.b64encode(buf.getvalue()).decode(),
                    "type": "image/png", "code": code, "refresh": 55}
        except Exception:
            # 无二维码库时退回返回码值文本
            return {"code": code, "refresh": 55}

    # ==================== 教务系统（成绩，独立登录） ====================

    def _grades_body(self, xnm="", xqm=""):
        return {
            "xnm": str(xnm) if xnm else "",
            "xqm": str(xqm) if xqm else "",
            "sfzgcj": "",
            "kcbj": "",
            "pkey": "",
            "_search": "false",
            "nd": str(int(time.time() * 1000)),
            "queryModel.showCount": "15",
            "queryModel.currentPage": "1",
            "queryModel.sortName": " ",
            "queryModel.sortOrder": "asc",
            "time": "0",
        }

    def _grades_headers(self):
        return {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Referer": self.jxw_base + "/jwglxt/cjcx/cjcx_cxDgXscj.html?gnmkdm=N305005&layout=default",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": self.jxw_base,
        }

    def prepare_jwxt_login(self, student_id, password):
        """准备教务系统(jwxt)登录：抓 csrftoken + 公钥加密密码 + 验证码"""
        with self.lock:
            if self.jwxt_session is not None:
                return None
            s = self._http()
            base = self.jxw_base + "/jwglxt"
            html = s.get(base + "/xtgl/login_slogin.html", timeout=30).text
            m = re.search(r'name="csrftoken"[^>]*value="([^"]*)"', html)
            csrftoken = m.group(1) if m else ""
            r = s.get(base + "/xtgl/login_getPublicKey.html?time=%d" % int(time.time() * 1000), timeout=30)
            kd = r.json()
            n = int.from_bytes(base64.b64decode(kd["modulus"]), "big")
            e = int.from_bytes(base64.b64decode(kd["exponent"]), "big")
            from Crypto.Cipher import PKCS1_v1_5
            from Crypto.PublicKey import RSA
            mm = base64.b64encode(PKCS1_v1_5.new(RSA.construct((n, e))).encrypt(password.encode())).decode()
            pending = PendingJwxtLogin(s, csrftoken, mm, None)
            try:
                cap = s.get(base + "/kaptcha?time=%d" % int(time.time() * 1000), timeout=20)
                pending.captcha = cap.content
            except Exception:
                pending.captcha = None
            self.jwxt_pending = pending
            self.pending_kind = "jwxt"
            return pending

    def complete_jwxt_login(self, student_id, captcha):
        """用验证码完成教务系统登录"""
        with self.lock:
            p = self.jwxt_pending
            if p is None:
                raise DektError("教务登录会话已过期，请重新查询")
            if time.time() - p.created_at > 300:
                self.jwxt_pending = None
                raise DektError("验证码已过期，请重新查询")
            base = self.jxw_base + "/jwglxt"
            data = {"yhm": student_id, "mm": p.mm, "yzm": captcha or "",
                    "csrftoken": p.csrftoken, "language": "zh_CN"}
            try:
                r = p.http.post(base + "/xtgl/login_slogin.html?time=%d" % int(time.time() * 1000),
                                data=data, timeout=30, allow_redirects=False,
                                headers={"Content-Type": "application/x-www-form-urlencoded"})
            except requests.exceptions.RequestException:
                self.jwxt_pending = None
                self.pending_kind = None
                raise DektError("教务系统响应超时，请重试")
            self.jwxt_pending = None
            self.pending_kind = None
            if r.status_code != 302:
                err = ""
                m = re.search(r'id="tips"[^>]*>(.*?)</', r.text, re.S)
                if m:
                    err = re.sub(r'<[^>]+>', '', m.group(1)).strip()
                if not err:
                    m2 = re.search(r'验证码[^<]{0,20}', r.text)
                    if m2:
                        err = m2.group(0).strip()
                raise DektError(err or "教务登录失败（验证码错误或账号密码错误）")
            self.jwxt_session = p.http

    def fetch_grades(self, student_id, xnm="", xqm=""):
        """查询成绩：返回课程列表 + 总绩点(成绩/10-5, 满绩点5.0)。
        不指定 xnm/xqm 时查全部学期，并从结果推导可选学期列表。
        """
        if not self.jwxt_session:
            raise DektError("未登录教务系统")
        url = self.grades_url + "?doType=query&gnmkdm=N305005"
        body = self._grades_body(xnm, xqm)
        try:
            resp = self.jwxt_session.post(url, data=body, timeout=30,
                                          headers=self._grades_headers(), allow_redirects=False)
        except requests.exceptions.RequestException:
            raise DektError("教务系统响应超时，请重试")
        if resp.status_code == 302:
            self.jwxt_session = None
            raise DektError("教务登录已失效，请重新查询")
        j = self._parse_response(resp)
        if not isinstance(j, dict) or not isinstance(j.get("items"), list):
            raise DektError("教务系统查询失败(%s): %s" % (resp.status_code, resp.text[:200]))
        items = j.get("items") or []
        grades = []
        for it in items:
            grades.append({
                "kcmc": it.get("kcmc"),
                "cj": it.get("cj"),
                "xf": it.get("xf"),
                "jd": it.get("jd"),
                "xfjd": it.get("xfjd"),
                "kclbmc": it.get("kclbmc"),
                "kcxzmc": it.get("kcxzmc"),
                "khfsmc": it.get("khfsmc"),
                "xqmmc": it.get("xqmmc"),
                "xnmmc": it.get("xnmmc"),
                "sfxwkc": it.get("sfxwkc"),
            })
        result = self._calc_gpa(grades)
        if not xnm and not xqm:
            terms = []
            seen = set()
            for it in items:
                key = (it.get("xnm"), it.get("xqm"), it.get("xnmmc"), it.get("xqmmc"))
                if key[0] and key[1] and key not in seen:
                    seen.add(key)
                    terms.append({"xnm": key[0], "xqm": key[1],
                                  "xnmmc": key[2] or "", "xqmmc": key[3] or ""})
            result["terms"] = sorted(terms, key=lambda t: (t["xnmmc"], t["xqm"]))
        return result

    def fetch_kbcx(self, student_id, xnm, xqm, zs):
        """查询某周课表（教务系统移动端接口，按周返回该周有课的记录与日期安排）"""
        if not self.jwxt_session:
            raise DektError("未登录教务系统")
        url = self.jxw_base + "/jwglxt/kbcx/xskbcxMobile_cxXsKb.html?gnmkdm=N2154"
        body = {
            "gnmkdm": "N2154",
            "xnm": str(xnm),
            "xqm": str(xqm),
            "zs": str(zs),
            "doType": "app",
            "kblx": "1",
            "xh": student_id,
        }
        headers = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Referer": self.jxw_base + "/jwglxt/kbcx/xskbcxMobile_cxXsKb.html?gnmkdm=N2154&layout=default",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": self.jxw_base,
        }
        try:
            resp = self.jwxt_session.post(url, data=body, timeout=30,
                                          headers=headers, allow_redirects=False)
        except requests.exceptions.RequestException:
            raise DektError("教务系统响应超时，请重试")
        if resp.status_code in (302, 901):  # 901 = 教务移动端「未登录/会话失效」
            print(f"[kbcx] session invalid ({resp.status_code}), zs={zs}", flush=True)
            self.jwxt_session = None
            raise DektError("教务登录已失效，请重新导入")
        j = self._parse_response(resp)
        if not isinstance(j, dict) or not isinstance(j.get("rqazcList"), list) or not j.get("rqazcList"):
            # 超出学期范围等情况下日期安排为空，前端据此停止逐周遍历
            print(f"[kbcx] unexpected response (status={resp.status_code}, zs={zs}, xnm={xnm}, xqm={xqm}): {str(resp.text)[:300]}", flush=True)
            raise DektError("该周没有课表数据（可能已超出学期范围）")
        courses = []
        for it in j.get("kbList") or []:
            try:
                jcs = str(it.get("jcs") or "")
                if "-" in jcs:
                    a, b = jcs.split("-")[:2]
                    slot_start, slot_end = int(a) - 1, int(b) - 1
                else:
                    v = int(jcs) - 1
                    slot_start = slot_end = v
                day = max(0, min(6, int(it.get("xqj") or 1) - 1))
            except (ValueError, TypeError):
                continue
            if slot_start < 0 or slot_end < slot_start or slot_end >= 11:
                continue
            courses.append({
                "name": (it.get("kcmc") or "").strip(),
                "place": (it.get("cdmc") or "").strip(),
                "teachers": (it.get("xm") or "").strip(),
                # 课程代码 / 教学班：正方 kbList 标准字段为 kcb_id / jxbmc，多备一个候选兜底
                "code": readable_course_code(it.get("kcb_id"), it.get("kch_id"), it.get("kch")),
                "clazz": (it.get("jxbmc") or it.get("jxb_id") or "").strip(),
                "day": day,
                "slotStart": slot_start,
                "slotEnd": slot_end,
            })
        xsxx = j.get("xsxx") or {}
        print(f"[kbcx] week {zs} ok: {len(courses)} courses", flush=True)
        return {
            "courses": courses,
            "dates": [{"xqj": d.get("xqj"), "rq": d.get("rq")} for d in j["rqazcList"]],
            "xnmc": xsxx.get("XNMC") or "",
        }

    @staticmethod
    def _calc_gpa(grades):
        """绩点 = 成绩/10 - 5（满绩点5.0）；总绩点 = Σ(绩点×学分)/Σ学分"""
        total_xfjd = 0.0
        total_xf = 0.0
        for g in grades:
            cj = g.get("cj")
            xf = g.get("xf")
            try:
                cj_f = float(cj)
            except (TypeError, ValueError):
                # 等级制成绩，用系统绩点
                try:
                    jd = float(g.get("jd") or 0)
                except (TypeError, ValueError):
                    continue
                xf_f = float(xf) if xf is not None and xf != "" else 0.0
            else:
                jd = round(cj_f / 10.0 - 5.0, 4)
                xf_f = float(xf) if xf is not None and xf != "" else 0.0
            xfjd = round(jd * xf_f, 4)
            g["jd"] = jd
            g["xfjd"] = xfjd
            total_xfjd += xfjd
            total_xf += xf_f
        gpa = round(total_xfjd / total_xf, 4) if total_xf else 0
        return {"grades": grades, "gpa": gpa, "count": len(grades)}


class DektManager:
    def __init__(self, cfg):
        self.cfg = cfg
        self.clients = {}
        self.lock = threading.Lock()

    def get(self, user_id, sess):
        with self.lock:
            c = self.clients.get(user_id)
            if c is None or c.socks_port != sess.socks_port:
                c = DektClient(user_id, sess.socks_port, self.cfg, proxy_host=getattr(sess, "proxy_host", "127.0.0.1"))
                self.clients[user_id] = c
            return c

    def drop(self, user_id):
        with self.lock:
            self.clients.pop(user_id, None)
