# 演示页静态服务：/10000000/* 走 docs/demo，其余走项目根（dist 就在这里）
# 用法：python docs/demo/serve.py  →  http://127.0.0.1:8932/10000000/index.html
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEMO = os.path.join(ROOT, "docs", "demo")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        base = DEMO if clean.startswith("/10000000") else ROOT
        return os.path.join(base, clean.lstrip("/").replace("/", os.sep))

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("serving", ROOT, "on http://127.0.0.1:8932")
    http.server.ThreadingHTTPServer(("127.0.0.1", 8932), Handler).serve_forever()
