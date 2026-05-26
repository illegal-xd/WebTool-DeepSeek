from __future__ import annotations

import os
import pathlib
import platform
import re
import subprocess
from typing import Any

WORKSPACE_ROOT = pathlib.Path(os.environ.get("DS_WORKSPACE", os.getcwd())).expanduser().resolve()
DEFAULT_MAX_BYTES = 1_048_576
MAX_READ_BYTES = 10 * 1_048_576
DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120
MAX_OUTPUT_BYTES = 1_048_576

DANGEROUS_PATTERNS = [
    re.compile(r":\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;\s*:"),
    re.compile(r"\brm\s+-[^\n;|&]*r[^\n;|&]*f[^\n;|&]*(?:\s+/\s*$|\s+/\*|\s+~(?:\s|/|$)|\s+\.\.(?:\s|/|$)|\s+\.(?:\s|/|$)|\s+\./\*|\s+\*)", re.I),
    re.compile(r"--no-preserve-root", re.I),
    re.compile(r"\b(?:mkfs|mkfs\.[\w-]+)\b", re.I),
    re.compile(r"\bdd\s+[^\n;|&]*(?:\bif=/dev/|\bof=/dev/)", re.I),
    re.compile(r"\b(?:kill|pkill|killall|taskkill)\b", re.I),
    re.compile(r"\b(?:del|erase|rmdir|rd)\s+[^\n;|&]*(?:/s|/q)[^\n;|&]*(?:c:\\|%systemroot%|windows|system32)", re.I),
]

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "get_cwd",
        "description": "返回 MCP 服务当前受限工作区根目录。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_directory",
        "description": "列出受限工作区内指定目录的文件和子目录。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "相对于工作区根目录的目录路径。"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "read_file",
        "description": "读取受限工作区内的文本文件内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "相对于工作区根目录的文件路径。"},
                "encoding": {"type": "string", "default": "utf-8", "description": "文件编码，默认 utf-8。"},
                "max_bytes": {"type": "number", "default": DEFAULT_MAX_BYTES, "description": "最大读取字节数。"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_file",
        "description": "向受限工作区内的文本文件写入内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "相对于工作区根目录的文件路径。"},
                "content": {"type": "string", "description": "要写入的文本内容。"},
                "encoding": {"type": "string", "default": "utf-8", "description": "文件编码，默认 utf-8。"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "execute_command",
        "description": "在受限工作区内执行经过安全策略检查的 shell 命令。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令。"},
                "timeout": {"type": "number", "default": DEFAULT_TIMEOUT, "description": "超时时间，单位秒。"},
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
]


class ShellToolError(Exception):
    def __init__(self, message: str, code: int = -32603) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def is_tool_name(name: Any) -> bool:
    return isinstance(name, str) and any(tool["name"] == name for tool in TOOL_DEFINITIONS)


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "get_cwd":
        return text_result(str(WORKSPACE_ROOT), {"cwd": str(WORKSPACE_ROOT), "platform": platform.system()})
    if name == "list_directory":
        return text_result(list_directory(arguments.get("path", ".")))
    if name == "read_file":
        return text_result(read_file(arguments))
    if name == "write_file":
        return text_result(write_file(arguments))
    if name == "execute_command":
        return text_result(execute_command(arguments))
    raise ShellToolError(f"Unknown shell tool: {name}", -32601)


def list_directory(raw_path: Any) -> str:
    directory = validate_existing_path(require_string(raw_path, "path"))
    if not directory.is_dir():
        raise ShellToolError(f"Path is not a directory: {directory}")
    rows: list[tuple[str, int, str]] = []
    for entry in directory.iterdir():
        stat = entry.lstat()
        if entry.is_symlink():
            kind = "link"
        elif entry.is_dir():
            kind = "dir"
        elif entry.is_file():
            kind = "file"
        else:
            kind = "other"
        rows.append((kind, stat.st_size, entry.name))
    rows.sort(key=lambda row: (0 if row[0] == "dir" else 1, row[2].lower()))
    return "\n".join(f"{kind:<5} {size:>10} {name}" for kind, size, name in rows) or "(empty directory)"


def read_file(arguments: dict[str, Any]) -> str:
    file_path = validate_existing_path(require_string(arguments.get("path"), "path"))
    if not file_path.is_file():
        raise ShellToolError(f"Path is not a file: {file_path}")
    encoding = read_encoding(arguments.get("encoding"))
    max_bytes = clamp_positive_int(arguments.get("max_bytes"), DEFAULT_MAX_BYTES, MAX_READ_BYTES)
    with file_path.open("rb") as file:
        data = file.read(max_bytes + 1)
    truncated = len(data) > max_bytes
    text = data[:max_bytes].decode(encoding)
    return f"{text}\n\n[truncated after {max_bytes} bytes]" if truncated else text


def write_file(arguments: dict[str, Any]) -> str:
    raw_path = require_string(arguments.get("path"), "path")
    content = require_string(arguments.get("content"), "content")
    encoding = read_encoding(arguments.get("encoding"))
    file_path = validate_writable_path(raw_path)
    file_path.write_text(content, encoding=encoding)
    return f"Wrote {len(content.encode(encoding))} bytes to {file_path.relative_to(WORKSPACE_ROOT)}"


def execute_command(arguments: dict[str, Any]) -> str:
    command = require_string(arguments.get("command"), "command").strip()
    if not command:
        raise ShellToolError("command must not be empty", -32602)
    assert_command_allowed(command)
    timeout = clamp_positive_int(arguments.get("timeout"), DEFAULT_TIMEOUT, MAX_TIMEOUT)
    try:
        result = subprocess.run(
            command,
            cwd=str(WORKSPACE_ROOT),
            shell=True,
            text=True,
            capture_output=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as error:
        raise ShellToolError(f"Command timed out after {timeout} seconds") from error
    stdout = truncate_text(result.stdout or "", MAX_OUTPUT_BYTES)
    stderr = truncate_text(result.stderr or "", MAX_OUTPUT_BYTES)
    sections = [f"exit_code: {result.returncode}"]
    if stdout:
        sections.append(f"stdout:\n{stdout}")
    if stderr:
        sections.append(f"stderr:\n{stderr}")
    return "\n\n".join(sections)


def validate_existing_path(value: str) -> pathlib.Path:
    candidate = resolve_candidate_path(value)
    assert_inside_workspace(candidate)
    try:
        real_path = candidate.resolve(strict=True)
    except FileNotFoundError as error:
        raise ShellToolError(f"Path does not exist: {candidate}") from error
    assert_inside_workspace(real_path)
    return real_path


def validate_writable_path(value: str) -> pathlib.Path:
    candidate = resolve_candidate_path(value)
    assert_inside_workspace(candidate)
    parent = candidate.parent
    parent.mkdir(parents=True, exist_ok=True)
    real_parent = parent.resolve(strict=True)
    assert_inside_workspace(real_parent)
    if candidate.exists() or candidate.is_symlink():
        assert_inside_workspace(candidate.resolve(strict=True))
    return candidate


def resolve_candidate_path(value: str) -> pathlib.Path:
    raw = pathlib.Path(value).expanduser()
    if not raw.is_absolute():
        raw = WORKSPACE_ROOT / raw
    return raw.resolve(strict=False)


def assert_inside_workspace(path: pathlib.Path) -> None:
    try:
        path.relative_to(WORKSPACE_ROOT)
    except ValueError as error:
        raise ShellToolError(f"Path '{path}' is outside workspace root '{WORKSPACE_ROOT}'") from error


def assert_command_allowed(command: str) -> None:
    compact = re.sub(r"\s+", " ", command).strip()
    for pattern in DANGEROUS_PATTERNS:
        if pattern.search(compact):
            raise ShellToolError(f"Command rejected by local MCP safety policy: {command}")


def read_encoding(value: Any) -> str:
    encoding = value if isinstance(value, str) and value.strip() else "utf-8"
    try:
        "".encode(encoding)
    except LookupError as error:
        raise ShellToolError(f"Unsupported encoding: {encoding}", -32602) from error
    return encoding


def require_string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ShellToolError(f"{name} must be a string", -32602)
    return value


def clamp_positive_int(value: Any, fallback: int, maximum: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        number = int(value if value is not None else fallback)
    except (TypeError, ValueError):
        return fallback
    if number <= 0:
        return fallback
    return min(number, maximum)


def truncate_text(text: str, max_bytes: int) -> str:
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    truncated = data[:max_bytes].decode("utf-8", errors="ignore")
    return f"{truncated}\n[truncated after {max_bytes} bytes]"


def text_result(text: str, structured_content: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": False}
    if structured_content is not None:
        result["structuredContent"] = structured_content
    return result
