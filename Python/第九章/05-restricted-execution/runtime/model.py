"""仅保留 SQL 执行器使用的长度助手；镜像不携带宿主的模型客户端。"""


def utf16_length(value):
    # 和 Python 04 / 原 JavaScript 字符长度一致，非 BMP 字符占两个单元。
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2
