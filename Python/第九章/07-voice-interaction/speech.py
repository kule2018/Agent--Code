"""语音服务：完整录音只做 ASR；已生成的短回答才做 TTS，不自动重试计费请求。"""

import base64
import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


# JavaScript trim() 的空白集合与 Python strip() 略有不同，保留原例的边界。
_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_BASE_ERROR = "DASHSCOPE_BASE_URL 请使用百炼北京或新加坡地域的真实兼容接口地址，以 /compatible-mode/v1 结尾。"
_AUDIO_ERROR = "语音服务返回了非预期音频地址。"


def trim_text(text):
    return text.strip(_WHITESPACE)


def utf16_length(text):
    """问题/转写的 2000 上限沿用 JS string.length，emoji 通常计两个单元。"""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def character_count(text):
    """朗读上限沿用 JS [...text].length，按 Unicode 码点而非 UTF-16 单元计数。"""
    return len(text.encode("utf-16-le", errors="surrogatepass")
               .decode("utf-16-le", errors="surrogatepass"))


def _trusted_url(raw_url, *, audio=False):
    """发送 Key 前限定百炼域名；播放前限定 OSS 域名，不跟随任意地址。"""
    message = _AUDIO_ERROR if audio else _BASE_ERROR
    try:
        if not isinstance(raw_url, str) or any(c in raw_url for c in "\r\n\t\\"):
            raise ValueError(message)
        url = urlsplit(raw_url)
        host = url.hostname or ""
        allowed_host = (re.search(r"\.oss-[a-z0-9-]+\.aliyuncs\.com$", host)
                        if audio else re.fullmatch(
                            r"(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)",
                            host, flags=re.ASCII))
        allowed_protocol = url.scheme in ({"http", "https"} if audio else {"https"})
        # WHATWG URL 会去掉协议的默认端口；同样接受 https:443 / http:80。
        allowed_port = url.port in (None, 443 if url.scheme == "https" else 80)
        if (not allowed_host or not allowed_protocol or not allowed_port
                or url.username or url.password):
            raise ValueError(message)
        if not audio and (url.query or url.fragment
                          or re.sub(r"/$", "", url.path) != "/compatible-mode/v1"):
            raise ValueError(message)
        # 已校验域名和默认端口，再用规范化地址发请求；签名 query 保持不变。
        return urlunsplit(("https", host, url.path or "/", url.query, url.fragment))
    except (ValueError, TypeError) as error:
        raise ValueError(message) from error


def configuration(env):
    """ASR 与 TTS 共用同一地域、业务空间的 Key；只读取进程环境，不加载文件。"""
    if not env.get("DASHSCOPE_API_KEY") or not env.get("DASHSCOPE_BASE_URL"):
        raise ValueError("请在本节 .env 配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL。")
    base = _trusted_url(env["DASHSCOPE_BASE_URL"]).removesuffix("/")
    return {"base": base, "origin": f"https://{urlsplit(base).hostname}",
            "key": env["DASHSCOPE_API_KEY"]}


def validate_audio(audio, content_type):
    """只接受浏览器的 WebM/Ogg；大小和魔数在发送到语音服务前检查。"""
    mime = content_type.split(";", 1)[0].strip().lower() if isinstance(content_type, str) else ""
    if not isinstance(audio, bytes) or not 32 <= len(audio) <= 2 * 1024 * 1024:
        raise ValueError("录音为空或超过 2 MB，请重新录制一段不超过 30 秒的问题。")
    webm = mime == "audio/webm" and audio[:4] == bytes([0x1A, 0x45, 0xDF, 0xA3])
    ogg = mime == "audio/ogg" and audio[:4] == b"OggS"
    if not webm and not ogg:
        raise ValueError("录音格式需要是 WebM 或 Ogg，请使用新版 Chrome / Edge。")
    return mime


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 不允许携带 Bearer Key 的请求跳转到别的地址。
        raise ValueError("语音服务返回了重定向，已拒绝转发请求。")


def request_json(url, body, key):
    """标准库 HTTP 客户端；单次网络操作超时 60 秒，供应商错误直接交给页面。"""
    payload = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    request = Request(url, data=payload.encode("utf-8", errors="backslashreplace"),
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                      method="POST")
    try:
        response = build_opener(_NoRedirect()).open(request, timeout=60)
    except HTTPError as error:
        response = error  # HTTP 4xx/5xx 的 JSON 错误也需要读取；不重发请求。
    with response:
        data = json.loads(response.read())
        status = response.status
    if not isinstance(data, dict):
        raise ValueError("语音服务没有返回有效 JSON 对象。")
    if not 200 <= status < 300 or data.get("code"):
        vendor_error = data.get("error")
        detail = data.get("message") or (vendor_error.get("message") if isinstance(vendor_error, dict) else None) or data.get("code") or "请求失败"
        raise ValueError(f"语音服务 {status}：{detail}")
    return data


def transcribe(audio, content_type, *, env=None, request_impl=request_json):
    """完整录音 → 文字；只返回核对用的文本，不在这里执行分析。"""
    mime = validate_audio(audio, content_type)
    config = configuration(os.environ if env is None else env)
    response = request_impl(f"{config['base']}/chat/completions", {
        "model": "qwen3-asr-flash",
        "messages": [{"role": "user", "content": [{"type": "input_audio", "input_audio": {
            "data": f"data:{mime};base64,{base64.b64encode(audio).decode('ascii')}"
        }}]}],
        "stream": False,  # 等待完整识别结果，不使用流式输出。
        "asr_options": {"enable_itn": False},  # 不主动将口语数字等转换为规范格式。
    }, config["key"])
    choices = response.get("choices") or []
    choice = choices[0] if isinstance(choices, list) and choices else None
    message = choice.get("message") if isinstance(choice, dict) else None
    text = message.get("content") if isinstance(message, dict) else None
    if not isinstance(text, str) or not trim_text(text):
        raise ValueError("没有识别到文字，请重新录音或直接输入问题。")
    if utf16_length(text) > 2000:
        raise ValueError("识别文字过长，请缩短问题。")
    return trim_text(text)


def synthesize(text, *, env=None, request_impl=request_json):
    """短回答 → 供应商临时音频地址；不下载音频，也不伪造合成结果。"""
    if not isinstance(text, str) or not trim_text(text) or character_count(text) > 600:
        raise ValueError("本例每次合成 1 到 600 字符的回答。")
    config = configuration(os.environ if env is None else env)
    response = request_impl(f"{config['origin']}/api/v1/services/aigc/multimodal-generation/generation", {
        "model": "qwen3-tts-flash",
        "input": {"text": text, "voice": "Cherry", "language_type": "Chinese"},
    }, config["key"])
    raw_url = ((response.get("output") or {}).get("audio") or {}).get("url")
    if not raw_url:
        raise ValueError("语音服务没有返回音频地址。")
    # 官方示例可能返回 HTTP；校验后使用同一 OSS 地址的 HTTPS 版本播放。
    return _trusted_url(raw_url, audio=True)
