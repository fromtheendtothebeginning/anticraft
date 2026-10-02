# campus/electricity.py — 电费查询/充值客户端（SIT 校付宝 epeortal 系统）
# 移植自 SCHOOLALY（server/app/dekt.py 的 openservice 电费部分），改造为独立客户端。
#
# 真实 API（ecard.sit.edu.cn/openservice）：
#   登录   POST /epeortalAuth/login          {"custname","pwd"(SM4),"stuempno"} → data.token
#   查电费 POST /miniprogram/queryroominfo   {"elcsysid","areaid","buildid","roomid"}
#                                            → data.restElecDegree（元）
#   查卡余额 POST /miniprogram/wxlayout       {} → layout.balancePart.content[0].number
#   充值   POST /miniprogram/buyelectrityinit（创建订单）→ billno
#          POST /miniprogram/balancepay      （余额支付，amount 单位分）
#
# 楼号换算：实际楼号 + 1（24 号楼 → 接口 buildid 25）。
# 校付宝支付密码 ≠ VPN 密码，SM4-128-ECB(PKCS7) 加密后提交。

import json
import logging
import re
import socket
import time

import requests
import urllib3

log = logging.getLogger(__name__)

# DNS 把不可达的 IPv6 排在 A 记录前，先撞它再回退 IPv4 会吃掉全部超时预算
urllib3.util.connection.allowed_gai_family = lambda: socket.AF_INET

# ============================================================
# SM4-ECB 加密（零依赖，移植自 ecard_sm4.py）
# ============================================================

_DEFAULT_KEY = b"IhaIWKKs9AJpn5ip"
_MASK = 0xFFFFFFFF
_SBOX = (
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
    0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
    0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
    0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
    0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
    0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
    0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
    0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
    0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
    0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
    0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
    0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
    0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
    0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
    0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
    0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
)
_FK = (0xA3B1BAC6, 0x56AA3350, 0x677D9197, 0xB27022DC)
_CK = tuple(
    (((4 * i) * 7 % 256) << 24) | (((4 * i + 1) * 7 % 256) << 16)
    | (((4 * i + 2) * 7 % 256) << 8) | ((4 * i + 3) * 7 % 256)
    for i in range(32)
)


def _rotl(x, n):
    return ((x << n) | (x >> (32 - n))) & _MASK


def _tau(a):
    return (
        (_SBOX[(a >> 24) & 0xFF] << 24)
        | (_SBOX[(a >> 16) & 0xFF] << 16)
        | (_SBOX[(a >> 8) & 0xFF] << 8)
        | _SBOX[a & 0xFF]
    )


def _l(b):
    return b ^ _rotl(b, 2) ^ _rotl(b, 10) ^ _rotl(b, 18) ^ _rotl(b, 24)


def _l_prime(b):
    return b ^ _rotl(b, 13) ^ _rotl(b, 23)


def _expand_key(key):
    k = [int.from_bytes(key[i * 4:i * 4 + 4], "big") ^ _FK[i] for i in range(4)]
    rk = []
    for i in range(32):
        v = k[i] ^ _l_prime(_tau(k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ _CK[i])) & _MASK
        k.append(v)
        rk.append(v)
    return rk


def _crypt_block(block, rk):
    x = [int.from_bytes(block[i * 4:i * 4 + 4], "big") for i in range(4)]
    for i in range(32):
        x.append(x[i] ^ _l(_tau(x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i])) & _MASK)
    out = x[35], x[34], x[33], x[32]
    return b"".join(w.to_bytes(4, "big") for w in out)


def _pad_pkcs7(data):
    n = 16 - len(data) % 16
    return data + bytes([n]) * n


def _unpad_pkcs7(data):
    if not data or len(data) % 16:
        raise ValueError("密文长度必须是 16 字节的整数倍")
    n = data[-1]
    if not 1 <= n <= 16 or data[-n:] != bytes([n]) * n:
        raise ValueError("PKCS#7 填充无效（密钥错误或密文损坏）")
    return data[:-n]


def sm4_encrypt(plain: str, key: bytes = _DEFAULT_KEY) -> str:
    """明文 -> SM4-ECB + PKCS#7 + base64"""
    import base64
    rk = _expand_key(key)
    data = _pad_pkcs7(plain.encode("utf-8"))
    ct = b"".join(_crypt_block(data[i:i + 16], rk) for i in range(0, len(data), 16))
    return base64.b64encode(ct).decode("ascii")


def sm4_decrypt(b64_cipher: str, key: bytes = _DEFAULT_KEY) -> str:
    """base64 密文 -> 明文（自检/调试用）"""
    import base64
    rk = _expand_key(key)[::-1]
    raw = base64.b64decode(b64_cipher)
    data = b"".join(_crypt_block(raw[i:i + 16], rk) for i in range(0, len(raw), 16))
    return _unpad_pkcs7(data).decode("utf-8")


# ============================================================
# 寝室解析：楼号 + 房间号 → buildid / roomid
# ============================================================

BUILD_OFFSET = 1  # 实际楼号 → 接口 buildid 的偏移（24号楼 → 25）


def parse_dorm(dorm_str: str) -> dict:
    """解析寝室字符串 → {building, room, buildid, roomid}。
    支持 '24号楼1016' / '24-1016' / '奉贤校区 24 号楼 1016' 等。
    buildid = 楼号 + BUILD_OFFSET
    """
    s = (dorm_str or "").strip()
    m = re.search(r'(\d+)\s*号?\s*楼?\s*[-]?\s*(\d+)', s)
    if not m:
        raise ValueError(f"无法解析寝室号「{dorm_str}」，请按「24号楼1016」格式填写")
    building = int(m.group(1))
    room = int(m.group(2))
    return {
        "building": building,
        "room": room,
        "buildid": building + BUILD_OFFSET,
        "roomid": room,
    }


# ============================================================
# 电费客户端
# ============================================================

class ElectricityError(Exception):
    pass


class ElectricityClient:
    """SIT 校付宝 epeortal 电费客户端（走 VPN SOCKS5 隧道）。"""

    OS_BASE = "https://ecard.sit.edu.cn/openservice"
    LOGIN_URL = OS_BASE + "/epeortalAuth/login"
    QUERY_URL = OS_BASE + "/miniprogram/queryroominfo"
    BALANCE_URL = OS_BASE + "/miniprogram/wxlayout"
    INIT_URL = OS_BASE + "/miniprogram/buyelectrityinit"
    PAY_URL = OS_BASE + "/miniprogram/balancepay"
    REFERER = "https://ecard.sit.edu.cn/epeortal/pages/h5/elecCharge"
    ORIGIN = "https://ecard.sit.edu.cn"
    TIMEOUT = 30
    ELCSYSID = 2
    AREAID = "99"

    def __init__(self, proxy_host="", socks_port=0):
        """proxy_host/socks_port 为空时直连（实测 epeortal API 公网可达，无需 VPN）。"""
        self.proxy_host = proxy_host
        self.socks_port = socks_port
        self._session = requests.Session()
        self._session.trust_env = False
        if proxy_host and socks_port:
            self._session.proxies = {
                "http": f"socks5h://{proxy_host}:{socks_port}",
                "https": f"socks5h://{proxy_host}:{socks_port}",
            }
        self._token = None
        self._os_pwd = ""
        self._os_name = ""

    # ── 登录 ──
    def _login(self, student_id, real_name, pay_password):
        """epeortal 登录换 accessToken。custname 必须用真实姓名（用学号会被拒）。"""
        if not student_id:
            raise ElectricityError("缺少学号")
        if not pay_password:
            raise ElectricityError("缺少校付宝支付密码，请在「我的 → 校园服务」填写")
        if not real_name:
            raise ElectricityError("缺少姓名，请在「我的 → 校园服务」填写")
        pwd = sm4_encrypt(pay_password)
        body = {"custname": real_name, "pwd": pwd, "stuempno": student_id}
        log.info(f"[electricity] login sid={student_id} name={real_name}")
        try:
            resp = self._session.post(self.LOGIN_URL, json=body, timeout=self.TIMEOUT)
        except requests.exceptions.RequestException as e:
            raise ElectricityError(f"校付宝系统响应超时：{e}")
        try:
            obj = resp.json()
        except ValueError:
            raise ElectricityError(f"校付宝系统返回异常（HTTP {resp.status_code}）")
        if str(obj.get("retcode")) != "0":
            raise ElectricityError(obj.get("retmsg") or "校付宝自动登录失败（姓名或支付密码错误）")
        token = (obj.get("data") or {}).get("token", "")
        if not token:
            raise ElectricityError("校付宝自动登录未返回令牌")
        self._token = token
        self._os_pwd = pay_password
        self._os_name = real_name
        return token

    def _ensure_token(self, student_id, real_name, pay_password):
        if not self._token:
            self._login(student_id, real_name, pay_password)
        return self._token

    # ── 带 token 的 POST ──
    def _os_post(self, url, body, student_id, real_name, pay_password):
        """调用校付宝小程序接口；403 时自动重登续期重试一次。"""
        self._ensure_token(student_id, real_name, pay_password)
        s = self._session
        s.cookies.set("type", "SIT")
        s.cookies.set("accessToken", self._token)
        headers = {
            "Content-Type": "application/json",
            "Referer": self.REFERER,
            "Origin": self.ORIGIN,
            "sw-Authorization": "Bearer " + self._token,
        }
        try:
            resp = s.post(url, json=body, timeout=self.TIMEOUT, headers=headers)
        except requests.exceptions.RequestException as e:
            raise ElectricityError(f"校园卡系统响应超时：{e}")
        if resp.status_code == 403:
            # 令牌过期：重登续期后重试一次
            self._token = None
            self._login(student_id, real_name, pay_password)
            headers["sw-Authorization"] = "Bearer " + self._token
            try:
                resp = s.post(url, json=body, timeout=self.TIMEOUT, headers=headers)
            except requests.exceptions.RequestException as e:
                raise ElectricityError(f"校园卡系统响应超时：{e}")
        try:
            obj = resp.json()
        except ValueError:
            raise ElectricityError(f"校园卡系统返回异常（HTTP {resp.status_code}）")
        if str(obj.get("retcode")) != "0":
            raise ElectricityError(obj.get("retmsg") or "校付宝接口调用失败")
        return obj.get("data") or {}

    # ── 校园卡余额 ──
    def _card_balance(self, student_id, real_name, pay_password):
        """校园卡（一卡通钱包）余额，失败返回 None"""
        try:
            data = self._os_post(self.BALANCE_URL, {}, student_id, real_name, pay_password)
            parts = (((data.get("layout") or {}).get("balancePart") or {}).get("content")) or []
            if not parts:
                return None
            number = (parts[0] or {}).get("number")
            if number is None:
                return None
            try:
                return round(float(number), 2)
            except (TypeError, ValueError):
                return None
        except ElectricityError:
            return None

    # ── 查询电费 ──
    def query(self, student_id, real_name, pay_password, dorm_str):
        """查询宿舍电费余额 + 校园卡余额。返回 {balance, card_balance, remain, dorm_info, raw}"""
        dorm = parse_dorm(dorm_str)
        body = {
            "elcsysid": self.ELCSYSID,
            "areaid": self.AREAID,
            "buildid": str(dorm["buildid"]),
            "roomid": str(dorm["roomid"]),
        }
        data = self._os_post(self.QUERY_URL, body, student_id, real_name, pay_password)
        # restElecDegree 实为宿舍电费余额（元），与校付宝小程序同源显示
        raw_balance = data.get("restElecDegree")
        try:
            balance = round(float(raw_balance), 2)
        except (TypeError, ValueError):
            balance = None
        return {
            "balance": balance,
            "card_balance": self._card_balance(student_id, real_name, pay_password),
            "remain": None,   # 接口不返回度数
            "dorm_info": data.get("roomName") or f"{dorm['building']}号楼{dorm['room']}",
            "raw": data,
        }

    # ── 充值 ──
    def recharge(self, student_id, real_name, pay_password, dorm_str, amount):
        """缴纳电费：buyelectrityinit 创建订单 → balancepay 余额支付。
        amount 单位元（前端传入），接口按分提交。
        返回 {ok, message, balance(支付后卡余额), billno, amount}
        """
        dorm = parse_dorm(dorm_str)
        amount_fen = int(round(float(amount) * 100))
        if amount_fen <= 0:
            raise ElectricityError("充值金额必须大于 0")
        room = {
            "elcsysid": self.ELCSYSID,
            "areaid": self.AREAID,
            "roomid": str(dorm["roomid"]),
            "buildid": str(dorm["buildid"]),
            "roomname": f"{dorm['building']}号楼{dorm['room']}",
        }
        # 1) 创建订单
        init_body = dict(room)
        init_body["amount"] = amount_fen
        init = self._os_post(self.INIT_URL, init_body, student_id, real_name, pay_password)
        billno = init.get("billno")
        if not billno:
            raise ElectricityError("创建电费订单失败，未返回订单号")
        # 2) 余额支付
        pay_body = dict(room)
        pay_body.update({"amount": amount_fen, "billno": billno, "pwd": ""})
        data = self._os_post(self.PAY_URL, pay_body, student_id, real_name, pay_password)
        bal = data.get("balance")
        try:
            bal = round(float(bal) / 100, 2) if bal is not None else None  # 分 -> 元
        except (TypeError, ValueError):
            pass
        return {
            "ok": True,
            "message": data.get("retmsg") or "充值成功",
            "balance": bal,
            "billno": billno,
            "amount": amount_fen / 100,
            "raw": data,
        }
