"""真实 loopback HTTP 冒烟测试，服务是 Fake；只启动并关闭本测试自己的临时端口。"""

import socket
import threading
import time
import unittest

import httpx2 as httpx
import uvicorn

from server import create_app


class LiveHTTPTests(unittest.TestCase):
    def test_uvicorn_page_edited_question_and_cached_speech(self):
        calls = []
        def analyze(question):
            calls.append(("analyze", question))
            return {"status": "answered", "answer": "Fake 页面回答", "speechText": "Fake 朗读内容"}
        def synthesize(text):
            calls.append(("tts", text))
            return "https://voice.oss-cn-beijing.aliyuncs.com/fake.wav"
        app = create_app({"transcribe": lambda *_: "Fake 转写问题", "analyze": analyze, "synthesize": synthesize})
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", server_header=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(server.started, "临时 HTTP 服务未能启动")
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=3) as client:
                page = client.get("/")
                self.assertEqual(page.status_code, 200)
                self.assertIn("录音转写", page.text)
                self.assertNotIn("server", page.headers)
                self.assertEqual(client.get("/vendor/lucide.js").status_code, 200)
                self.assertEqual(client.get("/", headers={"Origin": "http://evil.test"}).status_code, 403)
                transcribed = client.post("/api/transcribe", content=bytes(32), headers={"Content-Type": "audio/webm"})
                self.assertEqual(transcribed.json(), {"text": "Fake 转写问题"})
                self.assertEqual(calls, [])
                answered = client.post("/api/ask", json={"question": " 修改后的问题 "}).json()
                for _ in range(2):
                    self.assertEqual(client.post("/api/speak", json={"answerId": answered["answerId"]}).status_code, 200)
                self.assertEqual(calls, [("analyze", "修改后的问题"), ("tts", "Fake 朗读内容")])
        finally:
            server.should_exit = True
            thread.join(timeout=5)
            listener.close()
        self.assertFalse(thread.is_alive(), "本测试创建的 HTTP 服务应已退出")


if __name__ == "__main__":
    unittest.main()
