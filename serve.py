#!/usr/bin/env python3
"""本地预览服务器 + AI 侧栏代理。

为什么需要这个代理：
  1) 多数大模型 API 对浏览器跨域限制不一，走同源代理最稳；
  2) API Key 只落在本机 config.json，不进入浏览器 localStorage，也不会被导出的备份带走。

接口：
  GET  /api/status   当前配置状态（不含 Key 明文）
  POST /api/config   保存 provider / apiKey / model / baseUrl（写入 config.json）
  POST /api/chat     SSE 流式转发到上游模型

用法：python serve.py [端口]     默认 8900
"""

import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "config.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8900

PRESETS = {
    "deepseek": {
        "name": "DeepSeek",
        "baseUrl": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "note": "按 token 计费，单价低；新账号常赠送试用额度，以官网为准。国内直连稳定。",
    },
    "zhipu": {
        "name": "智谱 GLM",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": "glm-4-flash",
        "note": "glm-4-flash 有免费额度政策，性价比高，以官网为准。",
    },
    "moonshot": {
        "name": "Kimi (Moonshot)",
        "baseUrl": "https://api.moonshot.cn/v1/chat/completions",
        "model": "moonshot-v1-8k",
        "note": "长上下文强，按量计费。",
    },
    "siliconflow": {
        "name": "硅基流动 SiliconFlow",
        "baseUrl": "https://api.siliconflow.cn/v1/chat/completions",
        "model": "Qwen/Qwen2.5-7B-Instruct",
        "note": "聚合多家开源模型，部分小模型免费，以官网为准。",
    },
    "mock": {
        "name": "演示通道（不联网）",
        "baseUrl": "mock://local",
        "model": "demo",
        "note": "不调用任何模型，只回一段固定文字。用来确认侧栏、流式输出与代码块渲染是否正常；不产生任何费用。",
    },
    "ollama": {
        "name": "本地 Ollama",
        "baseUrl": "http://localhost:11434/v1/chat/completions",
        "model": "qwen2.5:7b",
        "note": "完全免费、不联网；需要本机已安装 Ollama 并 pull 模型，Key 随便填。",
    },
}

SYSTEM_PROMPT = (
    "你是一位 C++ 算法竞赛与保研机试教练。回答要求：\n"
    "1. 用中文，直接、具体，不讲空话。\n"
    "2. 代码一律 C++17，可直接编译；给出时间/空间复杂度。\n"
    "3. 学生问「怎么做」时，先给 1~2 句思路提示和关键观察，再给完整解法；他明确要代码时再给完整代码。\n"
    "4. 不确定的地方直说不确定，不要编造题面或数据范围。\n"
    "5. 指出这类题的识别信号（看到什么条件就该想到这个方法）和常见易错点。\n"
    "6. 回答控制在必要长度，代码块用 ```cpp 包裹。"
)


# ---------------------------------------------------------------- 配置

def default_config():
    return {"provider": "", "apiKey": "", "model": "", "baseUrl": "", "maxTokens": 1400}


def load_config():
    cfg = default_config()
    loaded = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                loaded = json.load(fh) or {}
            cfg.update(loaded)
        except (json.JSONDecodeError, OSError):
            loaded = {}
    cfg["_keySource"] = "config" if cfg.get("apiKey") else "none"
    # 环境变量兜底：只认与 provider 匹配的变量，绝不把别家的 Key 转发给另一家。
    # （曾因读 OPENAI_API_KEY 却指向 DeepSeek 端点，会把 OpenAI 的密钥发给第三方——必须避免）
    env_key = os.environ.get("DEEPSEEK_API_KEY")
    if not cfg.get("apiKey") and "apiKey" not in loaded and env_key:
        cfg["apiKey"] = env_key
        cfg["provider"] = cfg.get("provider") or "deepseek"
        cfg["baseUrl"] = cfg.get("baseUrl") or PRESETS["deepseek"]["baseUrl"]
        cfg["model"] = cfg.get("model") or PRESETS["deepseek"]["model"]
        cfg["_keySource"] = "env"
    return cfg


def save_config(cfg):
    """原子写入，权限 600（Windows 上忽略权限位）。"""
    tmp = CONFIG_PATH + ".tmp"
    clean = {k: v for k, v in cfg.items() if not k.startswith("_")}
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(clean, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def public_status(cfg):
    provider = cfg.get("provider") or ""
    preset = PRESETS.get(provider, {})
    return {
        "configured": bool(cfg.get("apiKey") and cfg.get("baseUrl")),
        "provider": provider,
        "providerName": preset.get("name", provider or "未配置"),
        "model": cfg.get("model") or preset.get("model", ""),
        "baseUrl": cfg.get("baseUrl", ""),
        "keyHint": ("已保存（" + cfg["apiKey"][:3] + "…" + cfg["apiKey"][-4:] + "）") if cfg.get("apiKey") else "",
        "keySource": cfg.get("_keySource", "none"),
        "presets": {k: {"name": v["name"], "model": v["model"], "note": v["note"]} for k, v in PRESETS.items()},
        "webFallback": "https://chat.deepseek.com/",
    }


# ---------------------------------------------------------------- 请求处理

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    # ---------- 工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, limit=200_000):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    # ---------- GET ----------
    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            return self._json(public_status(load_config()))
        return super().do_GET()

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/config":
            return self._handle_config()
        if path == "/api/chat":
            return self._handle_chat()
        return self._json({"error": "not found"}, 404)

    def _handle_config(self):
        data = self._read_json(8000)
        if not isinstance(data, dict):
            return self._json({"error": "请求格式错误"}, 400)

        cfg = load_config()
        provider = str(data.get("provider") or "").strip()
        if provider and provider not in PRESETS:
            return self._json({"error": "未知的 provider"}, 400)

        if provider:
            cfg["provider"] = provider
            preset = PRESETS[provider]
            cfg["baseUrl"] = str(data.get("baseUrl") or preset["baseUrl"]).strip()
            cfg["model"] = str(data.get("model") or preset["model"]).strip()
        # apiKey：缺省表示不修改；空字符串表示清除
        if "apiKey" in data:
            key = str(data.get("apiKey") or "").strip()
            if key in ("__clear__", ""):
                cfg["apiKey"] = ""
            else:
                cfg["apiKey"] = key
        if data.get("clear"):
            cfg = default_config()

        save_config(cfg)
        return self._json(public_status(cfg))

    def _handle_chat(self):
        data = self._read_json(400_000)
        if not isinstance(data, dict):
            return self._json({"error": "请求格式错误"}, 400)

        cfg = load_config()
        if not (cfg.get("apiKey") and cfg.get("baseUrl")):
            return self._json(
                {"error": "尚未配置模型。请在侧栏「设置」里填入 API Key，或使用「复制到 DeepSeek 网页」。",
                 "code": "not_configured"}, 400)

        messages = data.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return self._json({"error": "messages 为空"}, 400)
        # 只保留合法字段，避免把任意结构转发给上游
        clean = []
        for m in messages[-24:]:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if role in ("user", "assistant") and isinstance(content, str):
                clean.append({"role": role, "content": content[:20000]})
        if not clean:
            return self._json({"error": "messages 无有效内容"}, 400)

        system = str(data.get("system") or SYSTEM_PROMPT)[:4000]
        payload = {
            "model": cfg.get("model") or "deepseek-chat",
            "messages": [{"role": "system", "content": system}] + clean,
            "stream": True,
            "temperature": 0.3,
            "max_tokens": int(data.get("maxTokens") or cfg.get("maxTokens") or 1400),
        }

        # 演示通道：不联网，用来验证流式与前端渲染链路
        if cfg.get("provider") == "mock":
            return self._stream_mock()

        req = urllib.request.Request(
            cfg["baseUrl"],
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Authorization": "Bearer " + cfg["apiKey"],
            },
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:500]
            except Exception:  # noqa: BLE001
                pass
            return self._json({"error": f"上游返回 HTTP {exc.code}", "detail": detail}, 502)
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": f"连接上游失败：{type(exc).__name__}: {exc}"}, 502)

        self._stream_from(upstream)

    # ---------- 流式输出 ----------
    def _start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _chunk(self, data: bytes):
        self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def _end_sse(self):
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception:  # noqa: BLE001
            pass
        self.close_connection = True

    def _stream_mock(self):
        self._start_sse()
        parts = [
            "（演示通道）流式连接正常。\n\n",
            "这里会显示模型的回答，支持 **加粗**、`行内代码` 和代码块：\n\n",
            "```cpp\nint main() {\n    // 你的代码\n    return 0;\n}\n```\n\n",
            "在侧栏「设置」里填入 API Key 后，即可切换到真实模型。",
        ]
        import time
        try:
            for p in parts:
                evt = "data: " + json.dumps({"choices": [{"delta": {"content": p}}]}, ensure_ascii=False) + "\n\n"
                self._chunk(evt.encode("utf-8"))
                time.sleep(0.25)
            self._chunk(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self._end_sse()

    def _stream_from(self, upstream):
        self._start_sse()
        try:
            while True:
                line = upstream.readline()
                if not line:
                    break
                if line.strip() == b"":
                    continue
                # 原样转发 OpenAI 兼容的 SSE 行
                self._chunk(line if line.endswith(b"\n\n") else line + b"\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                evt = "data: " + json.dumps({"error": f"读取上游失败：{exc}"}, ensure_ascii=False) + "\n\n"
                self._chunk(evt.encode("utf-8"))
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass
            self._end_sse()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    cfg = load_config()
    status = public_status(cfg)
    print(f"机试训练路线图： http://127.0.0.1:{PORT}/   （Ctrl+C 退出）")
    if status["configured"]:
        print(f"AI 侧栏：已配置 {status['providerName']} / {status['model']}")
    else:
        print("AI 侧栏：未配置（侧栏里可填 API Key，或直接用「复制到 DeepSeek 网页」）")
    if os.path.exists(CONFIG_PATH):
        print(f"配置文件：{CONFIG_PATH}")
    try:
        ThreadingServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")