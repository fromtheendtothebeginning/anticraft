# campus/docker_mgr.py — EasyConnect 容器生命周期与端口分配
# 移植自 SCHOOLALY（server/app/docker_mgr.py），配置改读 campus.config.Config

import random
import threading

import docker
from docker.errors import NotFound


class DockerManager:
    def __init__(self, cfg):
        self.cfg = cfg
        if cfg.docker_host:
            self.client = docker.DockerClient(base_url=cfg.docker_host)
        else:
            self.client = docker.from_env()
        self._lock = threading.Lock()

    def _used_ports(self):
        used = set()
        for c in self.client.containers.list(all=True):
            for proto in ("1080/tcp", "8888/tcp"):
                for bind in c.ports.get(proto, []) or []:
                    hp = bind.get("HostPort")
                    if hp:
                        used.add(int(hp))
        return used

    def allocate_ports(self):
        with self._lock:
            low, high = self.cfg.port_low, self.cfg.port_high
            free = [p for p in range(low, high + 1) if p not in self._used_ports()]
            if len(free) < 2:
                raise RuntimeError("代理端口资源不足")
            socks = random.choice(free)
            free.remove(socks)
            http = random.choice(free)
        return socks, http

    def create_container(self, sess):
        # bridge 模式 + 端口映射，EasyConnect 需要独立网络命名空间建 tun
        cli_opts = "-d %s -u %s -p %s" % (self.cfg.vpn_addr, sess.student_id, sess.password)
        ports = {
            "1080/tcp": ("0.0.0.0", str(sess.socks_port)),
            "8888/tcp": ("0.0.0.0", str(sess.http_port)),
        }
        env = {
            "EC_VER": self.cfg.ec_ver,
            "CLI_OPTS": cli_opts,
            # WSL2 环境沿用 legacy iptables（排查 WSL 隧道问题时的既有做法）。
            # 注意：容器内 "FIB table does not exist" 与"校园网同账号只能一个会话"是另外两回事，
            # 后者会让 tun0 时有时无、查询 30s 超时，见 AGENTS.md 运行注意事项。
            "IPTABLES_LEGACY": "1",
            "PING_ADDR": self.cfg.keepalive_addr,
            "PING_INTERVAL": self.cfg.ping_interval,
        }
        for attempt in range(2):
            try:
                self.client.containers.run(
                    self.cfg.ec_image,
                    name=sess.container_name,
                    detach=True,
                    remove=True,
                    devices=["/dev/net/tun"],
                    privileged=True,
                    environment=env,
                    ports=ports,
                    mem_limit=self.cfg.mem_limit,
                )
                return
            except docker.errors.APIError as e:
                if "Conflict" in str(e) and attempt == 0:
                    self.remove(sess)
                    continue
                raise

    def remove(self, sess):
        try:
            self.client.containers.get(sess.container_name).remove(force=True)
        except NotFound:
            pass

    def container_state(self, sess):
        try:
            c = self.client.containers.get(sess.container_name)
        except NotFound:
            return {"running": False, "exited": True}
        c.reload()
        state = c.attrs.get("State", {})
        return {"running": bool(state.get("Running")), "exited": not state.get("Running")}

    def get_logs(self, sess, tail=200):
        try:
            c = self.client.containers.get(sess.container_name)
            return (c.logs(tail=tail) or b"").decode("utf-8", "replace")
        except NotFound:
            return ""

    def tun_routes(self, sess):
        """容器内 tun0 的路由条数：>0 = 隧道真正可用；0 = 无隧道/未就绪；-1 = 探测失败

        只看 tun0 这个 link 在不在不够：被同账号的另一条会话踢掉后 tun0 常常还在，
        但路由被清零，此时所有校园内网请求都会卡到 30s 超时。
        """
        try:
            c = self.client.containers.get(sess.container_name)
            r = c.exec_run("sh -c 'ip route 2>/dev/null | grep -c tun0'")
        except Exception:
            return -1
        out = (r.output or b"").decode("utf-8", "replace")
        nums = [ln.strip() for ln in out.splitlines() if ln.strip().isdigit()]
        return int(nums[-1]) if nums else -1

    def has_tun(self, sess):
        """容器内 VPN 隧道(tun0)是否真正可用（tun0 存在且有路由才算）"""
        return self.tun_routes(sess) > 0

    def cleanup_orphans(self):
        for c in self.client.containers.list(all=True, filters={"name": "ec-"}):
            try:
                c.remove(force=True)
            except Exception:
                pass
