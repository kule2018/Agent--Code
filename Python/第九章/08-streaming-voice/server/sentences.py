"""缓存不完整的句子；中文句末标点分段，不把 1599.00 的小数点当句末。"""

import re
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "07-voice-interaction"))
from speech import trim_text, utf16_length  # noqa: E402


class SentenceBuffer:
    def __init__(self):
        self.pending = ""

    def push(self, delta):
        self.pending += delta
        sentences = []
        while match := re.search(r"[。！？；\n]", self.pending):
            sentence = trim_text(self.pending[:match.end()])
            self.pending = self.pending[match.end():]
            if sentence:
                sentences.append(sentence)
        # 对齐 JS string.length；单句上限不是按 Python 的 len(emoji) 计数。
        if utf16_length(self.pending) > 500:
            raise ValueError("回答单句过长，已停止合成，请缩短问题")
        return sentences

    def flush(self):
        tail = trim_text(self.pending)
        self.pending = ""
        return [tail] if tail else []
