# campus/config.py — 校园服务运行配置（环境变量可覆盖，默认上海应用技术大学 SIT）

import os


class Config:
    vpn_addr = os.environ.get("VPN_ADDR", "myvpn.sit.edu.cn")
    ec_ver = os.environ.get("EC_VER", "7.6.7")
    ec_image = os.environ.get("EC_IMAGE", "hagb/docker-easyconnect:cli")
    max_sessions = int(os.environ.get("CAMPUS_MAX_SESSIONS", "6"))
    port_low = int(os.environ.get("CAMPUS_PORT_LOW", "10000"))
    port_high = int(os.environ.get("CAMPUS_PORT_HIGH", "18000"))
    connect_timeout = int(os.environ.get("CAMPUS_CONNECT_TIMEOUT", "90"))
    max_lifetime_hours = float(os.environ.get("CAMPUS_MAX_LIFETIME_HOURS", "12"))
    mem_limit = os.environ.get("CAMPUS_MEM_LIMIT", "256m")
    # docker 连接：留空 = 默认(本地 socket)；本地 Windows 连 WSL 时填 tcp://<wsl-ip>:2375
    docker_host = os.environ.get("DOCKER_HOST", "")
    # 对外展示的代理主机地址：服务器部署时填域名或公网 IP（如 anticraft.top），本地开发留空
    public_host = os.environ.get("CAMPUS_PUBLIC_HOST", "")

    @property
    def proxy_host(self) -> str:
        """后端自己连隧道用的地址：DOCKER_HOST 提取 IP（Windows 后端连 WSL dockerd），否则回环。

        注意这不是给用户填的代理地址——服务器上隧道端口发布在服务器本机，
        用户填的必须是 display_host（域名/公网 IP），两者别混用。
        """
        if self.docker_host.startswith("tcp://"):
            ip = self.docker_host.split("://", 1)[1].split(":", 1)[0]
            return ip or "127.0.0.1"
        return "127.0.0.1"

    @property
    def display_host(self) -> str:
        """对外展示、给用户填浏览器代理的地址：服务器用 CAMPUS_PUBLIC_HOST（域名/公网 IP），
        本地开发留空 = 回环（隧道就在本机）。"""
        return self.public_host or self.proxy_host

    dekt_aes_key = os.environ.get("DEKT_AES_KEY", "")
    keepalive_addr = os.environ.get("KEEPALIVE_ADDR", "10.2.248.254")
    ping_interval = os.environ.get("PING_INTERVAL", "20")
    # 校园系统域名（默认 SIT；迁移他校改这里）
    xg_base = os.environ.get("CAMPUS_XG_BASE", "https://xg.sit.edu.cn")
    jxw_base = os.environ.get("CAMPUS_JXW_BASE", "https://jwxt.sit.edu.cn")
    auth_base = os.environ.get("CAMPUS_AUTH_BASE", "https://authserver.sit.edu.cn/authserver")
    ecard_base = os.environ.get("CAMPUS_ECARD_BASE", "https://ecard.sit.edu.cn")
