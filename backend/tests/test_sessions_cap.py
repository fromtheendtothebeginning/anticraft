import time
import unittest

from campus.sessions import Session, SessionManager


class FakeConfig:
    max_sessions = 2
    port_low = 10000
    port_high = 18000
    connect_timeout = 1
    max_lifetime_hours = 12
    proxy_host = "127.0.0.1"


class FakeDocker:
    def create_container(self, sess):
        pass

    def remove(self, sess):
        pass

    def tun_routes(self, sess):
        return 1

    def container_state(self, sess):
        return {"running": True, "exited": False}

    def has_tun(self, sess):
        return True

    def get_logs(self, sess):
        return ""


class SessionsCapTest(unittest.TestCase):
    def test_cap_rejects_new_and_reclaims_failed(self):
        mgr = SessionManager(FakeConfig(), FakeDocker())
        for uid in (1, 2):
            s = Session(uid, "sid", "pwd", 10000 + uid * 2, 10001 + uid * 2)
            s.status = "connected"
            mgr.sessions[uid] = s

        # 满员且都在用：新用户拒绝，避免继续拉 256m 容器
        with self.assertRaises(RuntimeError):
            mgr.create(3, "sid", "pwd")

        # 有 failed 的会话：回收它的名额，新用户仍可连
        mgr.sessions[1].status = "failed"
        mgr.create(3, "sid", "pwd")
        self.assertIn(3, mgr.sessions)
        self.assertNotIn(1, mgr.sessions)

        deadline = time.time() + 2
        while time.time() < deadline and mgr.sessions[3].status != "connected":
            time.sleep(0.02)
        self.assertEqual(mgr.sessions[3].status, "connected")


if __name__ == "__main__":
    unittest.main()
