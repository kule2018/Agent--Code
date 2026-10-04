"""业务错误保留 Node API 的状态码和 message 字段。"""


class StoryError(Exception):
    status_code = 400


class BadRequest(StoryError):
    status_code = 400


class NotFound(StoryError):
    status_code = 404


class Conflict(StoryError):
    status_code = 409
