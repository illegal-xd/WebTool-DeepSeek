#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import re
import shutil
import sqlite3
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# 每条调用记录保存时间戳、来源类型和记录文件路径。
Invocation = tuple[str, str, str]
InvocationMap = dict[str, list[Invocation]]
FileSignature = tuple[int, int, int]
TextCacheKey = tuple[str, str, str]
JsonlMatchCacheKey = tuple[str, tuple[str, ...], FileSignature]
SqliteCacheKey = tuple[str, FileSignature]

_TEXT_CACHE: dict[TextCacheKey, tuple[FileSignature, str]] = {}
_JSONL_MATCH_CACHE: dict[JsonlMatchCacheKey, list[dict[str, Any]]] = {}
_SQLITE_SKILL_CACHE: dict[SqliteCacheKey, list[tuple[str, str]]] = {}
_SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]*$")
_SKILL_MD_PATH_RE = re.compile(r"^(?:[A-Za-z]:)?(?:~|\.\.?|/)[^\s\"'`]+/SKILL\.md$", re.IGNORECASE)
_ASPIRECODE_SKILL_START_RE = re.compile(r"\[data-monitor-skill\]\s+Started recording skill:\s*([^\s,;)]+)")
_ASPIRECODE_SKILL_LOADING_RE = re.compile(r"\bloading\s+([^\s,;)]+)\s+skill\b", re.IGNORECASE)
_ASPIRECODE_SKILL_NAME_RE = re.compile(r'\b(?:skillName|skill_name)\b\s*[:=]\s*"?([^\s,;)"\']+)')
_UNKNOWN_SKILL_NAME = "unknown-skill"
_TRAILING_NAME_PUNCTUATION = ".,;)]}"
_CLAUDE_ENTRY_MARKERS = (
    "Launching skill: ",
    '"tool_name":"skill"',
    '"tool_name": "skill"',
    '"name":"skill"',
    '"name": "skill"',
    '"toolUseResult"',
    '"commandName"',
    '"tool_use_id"',
)


def clear_scan_cache() -> None:
    _TEXT_CACHE.clear()
    _JSONL_MATCH_CACHE.clear()
    _SQLITE_SKILL_CACHE.clear()


def file_signature(path: Path) -> FileSignature:
    stat = path.stat()
    return (
        int(getattr(stat, "st_ino", 0) or 0),
        int(stat.st_mtime_ns),
        int(stat.st_size),
    )


def read_text_cached(path: Path, encoding: str = "utf-8", errors: str | None = None) -> str:
    signature = file_signature(path)
    key = (str(path), encoding, errors or "")
    cached = _TEXT_CACHE.get(key)
    if cached is not None and cached[0] == signature:
        return cached[1]

    if errors is None:
        text = path.read_text(encoding=encoding)
    else:
        text = path.read_text(encoding=encoding, errors=errors)
    _TEXT_CACHE[key] = (signature, text)
    return text


# 收集不同客户端在各平台上的会话或日志目录。
def usage_roots(home: Path) -> dict[str, list[Path]]:
    roots = {
        "claude": [
            home / ".claude" / "projects",
            home / ".claude" / "transcripts",
        ],
        "codex": [
            home / ".codex" / "sessions",
            home / ".codex" / "archived_sessions",
        ],
        "gemini": [home / ".gemini" / "tmp"],
        "opencode": [],
        "aspirecode_desktop_logs": [home / "Library" / "Logs" / "ai.aspirecode.desktop"],
        "aspirecode_timing_events": [home / ".config" / "opencode" / "aspirecode" / "timings"],
    }

    system = platform.system().lower()
    if system == "darwin":
        roots["opencode"] = opencode_storage_paths([
            home / ".local" / "share" / "opencode" / "storage",
            home / "Library" / "Application Support" / "opencode" / "storage" / "message",
            home / "Library" / "Application Support" / "opencode" / "storage",
            home / "Library" / "Application Support" / "ai.opencode.desktop" / "opencode" / "storage",
            home / ".opencode" / "storage",
        ])
        roots["opencode"].extend([
            home / ".local" / "share" / "opencode" / "opencode.db",
            home / ".local" / "share" / "opencode" / "opencode-prod.db",
            home / ".config" / "opencode" / "context-mode" / "sessions",
        ])
    elif system == "windows":
        app_data = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
        local_app_data = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        roots["opencode"] = opencode_storage_paths([
            app_data / "opencode" / "storage",
            app_data / "OpenCode" / "storage",
            local_app_data / "opencode" / "storage",
            local_app_data / "OpenCode" / "storage",
            home / ".opencode" / "storage",
        ])
        roots["opencode"].extend([
            app_data / "opencode" / "opencode.db",
            app_data / "opencode" / "opencode-prod.db",
            home / ".config" / "opencode" / "context-mode" / "sessions",
        ])
    else:
        data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
        state_home = Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state")
        config_home = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        roots["opencode"] = opencode_storage_paths([
            data_home / "opencode" / "storage",
            state_home / "opencode" / "storage",
            config_home / "opencode" / "storage",
            home / ".opencode" / "storage",
        ])
        roots["opencode"].extend([
            data_home / "opencode" / "opencode.db",
            data_home / "opencode" / "opencode-prod.db",
            config_home / "opencode" / "context-mode" / "sessions",
        ])

    return {name: unique_paths(paths) for name, paths in roots.items()}


def opencode_storage_paths(storage_roots: list[Path]) -> list[Path]:
    paths: list[Path] = []
    for root in storage_roots:
        if root.name in {"message", "part"}:
            paths.append(root)
            continue
        paths.extend((root / "message", root / "part"))
    return paths


def unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        key = str(path)
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


# 扫描所有已知来源，并统一写入 invocations 供后续汇总。
def scan_skill_usage(
    home: Path | None = None,
    max_age_days: int | None = None,
    top_count: int | None = None,
    trigger_filter: set[str] | None = None,
    include_records: bool = False,
) -> dict[str, Any]:
    resolved_home = home or Path.home()
    roots = usage_roots(resolved_home)
    invocations: InvocationMap = defaultdict(list)
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days) if max_age_days is not None else None

    if source_enabled(trigger_filter, "claude"):
        for path in roots["claude"]:
            if path.exists():
                scan_claude_projects(path, invocations, "claude", cutoff)

    if source_enabled(trigger_filter, "codex"):
        for path in roots["codex"]:
            if path.exists():
                scan_codex_sessions(path, invocations, "codex", cutoff)

    if source_enabled(trigger_filter, "gemini"):
        for path in roots["gemini"]:
            if path.exists():
                scan_gemini_sessions(path, invocations, "gemini", cutoff)

    if source_enabled(trigger_filter, "opencode"):
        for path in roots["opencode"]:
            if path.exists():
                scan_opencode_messages(path, invocations, "opencode", cutoff)

    if source_enabled(trigger_filter, "aspirecode"):
        for path in roots["aspirecode_desktop_logs"]:
            if path.exists():
                scan_aspirecode_desktop_logs(path, invocations, "aspirecode", cutoff)
        for path in roots["aspirecode_timing_events"]:
            if path.exists():
                scan_aspirecode_timing_events(path, invocations, "aspirecode", cutoff)

    return summarize_invocations(invocations, max_age_days, top_count, trigger_filter, include_records)


# 按时间和来源过滤后汇总调用次数，并可在最后截取 Top N。
def summarize_invocations(
    invocations: InvocationMap,
    max_age_days: int | None = None,
    top_count: int | None = None,
    trigger_filter: set[str] | None = None,
    include_records: bool = False,
) -> dict[str, Any]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days) if max_age_days is not None else None
    summaries: list[tuple[str, int, list[str]]] = []
    records_by_skill: dict[str, list[Invocation]] = {}
    total_call_count = 0

    for name, records in invocations.items():
        filtered_records = [
            record for record in records
            if (cutoff is None or timestamp_in_range(record[0], cutoff))
            and (trigger_filter is None or record[1] in trigger_filter)
        ]
        if filtered_records:
            triggers = sorted({record[1] for record in filtered_records})
            call_count = len(filtered_records)
            total_call_count += call_count
            summaries.append((name, call_count, triggers))
            records_by_skill[name] = filtered_records

    if top_count is None:
        summaries.sort(key=lambda item: item[0])
    else:
        summaries = sorted(summaries, key=lambda item: (-item[1], item[0]))[:top_count]

    usage: dict[str, Any] = {
        "skills": [
            {name: {"callCount": call_count, "trigger": triggers}}
            for name, call_count, triggers in summaries
        ],
        "allCallCount": total_call_count,
    }
    if include_records:
        selected_names = {name for name, _, _ in summaries}
        raw_records = [
            record_to_dict(name, record)
            for name in selected_names
            for record in records_by_skill.get(name, [])
        ]
        usage["records"] = sorted(raw_records, key=record_sort_key, reverse=True)
    return usage


def record_to_dict(skill_name: str, record: Invocation) -> dict[str, Any]:
    timestamp, source, source_path = record
    return {
        "skill": skill_name,
        "timestamp": timestamp,
        "source": source,
        "sourcePath": source_path,
    }


def record_sort_key(record: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        string_or_empty(record.get("timestamp")),
        string_or_empty(record.get("skill")),
        string_or_empty(record.get("source")),
        string_or_empty(record.get("sourcePath")),
    )


def source_enabled(trigger_filter: set[str] | None, source: str) -> bool:
    return trigger_filter is None or source in trigger_filter


def path_may_contain_recent_records(path: Path, cutoff: datetime | None) -> bool:
    if cutoff is None:
        return True
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except OSError:
        return False
    return modified_at >= cutoff


def timestamp_in_range(value: str, cutoff: datetime) -> bool:
    timestamp = parse_timestamp(value)
    return timestamp is not None and timestamp >= cutoff


# 解析不同日志来源里常见的 ISO 时间格式，统一转成 UTC。
def parse_timestamp(value: str) -> datetime | None:
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        timestamp = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc)


# Claude Code 会话是 JSONL，技能调用记录在 user/tool_result 内容中。
def scan_claude_projects(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    for path in safe_rglob(root, "*.jsonl"):
        parse_claude_jsonl(path, invocations, trigger, cutoff)


def parse_claude_jsonl(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    for entry in read_jsonl(path):
        timestamp = string_or_empty(entry.get("timestamp"))
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        for skill_name in extract_claude_entry_skill_names(entry):
            invocations[skill_name].append((timestamp, trigger, str(path)))


def extract_claude_entry_skill_names(entry: dict[str, Any]) -> list[str]:
    names: list[str] = []

    tool_use_result = entry.get("toolUseResult")
    if isinstance(tool_use_result, dict):
        for key in ("commandName", "command_name", "skillName", "skill_name"):
            if key in tool_use_result:
                skill_name = normalize_skill_identifier(string_or_empty(tool_use_result.get(key)))
                if skill_name:
                    names.append(skill_name)
                break

    if entry.get("type") == "tool_use":
        skill_name = extract_claude_tool_use_skill_name(entry)
        if skill_name:
            names.append(skill_name)

    message = entry.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    skill_name = extract_claude_tool_use_skill_name(block)
                    if skill_name:
                        names.append(skill_name)
    return unique_names(names)


def extract_claude_tool_use_skill_name(block: dict[str, Any]) -> str | None:
    tool_name = block.get("tool_name") or block.get("name")
    if tool_name != "skill":
        return None
    for key in ("tool_input", "input", "args", "arguments"):
        if key in block:
            skill_name = extract_skill_name_from_argument_value(block[key], allow_bare_name=True)
            if skill_name:
                return skill_name
    return None


# Codex 记录里通过 exec_command 调用 SKILL.md，因此按命令路径提取技能名。
def scan_codex_sessions(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    for path in safe_rglob(root, "*.jsonl"):
        parse_codex_jsonl(path, invocations, trigger, cutoff)


def parse_codex_jsonl(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    for entry in iter_jsonl_matching(path, ("exec_command", "/SKILL.md")):
        if entry.get("type") != "response_item":
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("type") != "function_call" or payload.get("name") != "exec_command":
            continue
        arguments = payload.get("arguments")
        if not isinstance(arguments, str):
            continue
        try:
            parsed_args = json.loads(arguments)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed_args, dict):
            continue
        cmd = parsed_args.get("cmd")
        if not isinstance(cmd, str):
            continue
        timestamp = string_or_empty(entry.get("timestamp"))
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        for skill_name in extract_skill_names_from_skill_md_paths(cmd):
            invocations[skill_name].append((timestamp, trigger, str(path)))


def scan_gemini_sessions(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    scan_json_files_in_named_dirs(root, "chats", invocations, trigger, cutoff)


def scan_opencode_messages(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if root.is_file():
        if root.suffix == ".json":
            parse_generic_json_file(root, invocations, trigger, cutoff)
        elif root.suffix in {".db", ".sqlite", ".sqlite3"}:
            parse_opencode_sqlite_database(root, invocations, trigger, cutoff)
        return

    scan_json_files_recursive(root, invocations, trigger, cutoff)
    scan_opencode_sqlite_databases(root, invocations, trigger, cutoff)


def scan_opencode_sqlite_databases(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if root.is_file():
        if root.suffix in {".db", ".sqlite", ".sqlite3"}:
            parse_opencode_sqlite_database(root, invocations, trigger, cutoff)
        return

    candidates = unique_paths(
        safe_rglob(root, "*.db")
        + safe_rglob(root, "*.sqlite")
        + safe_rglob(root, "*.sqlite3")
    )
    for path in candidates:
        parse_opencode_sqlite_database(path, invocations, trigger, cutoff)


def parse_opencode_sqlite_database(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    try:
        signature = file_signature(path)
    except OSError:
        return

    cache_key = (str(path), signature)
    cached = _SQLITE_SKILL_CACHE.get(cache_key)
    if cached is not None:
        for skill_name, timestamp in cached:
            if cutoff is None or timestamp_in_range(timestamp, cutoff):
                invocations[skill_name].append((timestamp, trigger, str(path)))
        return

    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            cursor = connection.cursor()
            tables = {
                row[0]
                for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                if isinstance(row[0], str)
            }
            if "part" not in tables:
                _SQLITE_SKILL_CACHE[cache_key] = []
                return

            rows = cursor.execute(
                """
                SELECT time_created, data
                FROM part
                WHERE COALESCE(data, '') LIKE '%"tool":"skill"%'
                   OR COALESCE(data, '') LIKE '%"tool": "skill"%'
                   OR COALESCE(data, '') LIKE '%"tool_name":"skill"%'
                   OR COALESCE(data, '') LIKE '%"tool_name": "skill"%'
                   OR COALESCE(data, '') LIKE '%"name":"skill"%'
                   OR COALESCE(data, '') LIKE '%"name": "skill"%'
                ORDER BY time_created ASC
                """
            ).fetchall()
    except sqlite3.Error:
        return

    records: list[tuple[str, str]] = []
    for row in rows:
        raw_data = row[1]
        if not isinstance(raw_data, str) or not raw_data.strip():
            continue
        try:
            payload = json.loads(raw_data)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        skill_name = extract_tool_call_skill(payload)
        if not skill_name:
            continue
        timestamp = timestamp_from_unix_millis(row[0])
        records.append((skill_name, timestamp))

    _SQLITE_SKILL_CACHE[cache_key] = records
    for skill_name, timestamp in records:
        if cutoff is None or timestamp_in_range(timestamp, cutoff):
            invocations[skill_name].append((timestamp, trigger, str(path)))


# AspireCode 桌面日志是文本日志，需要从日志行里匹配技能名。
def scan_aspirecode_desktop_logs(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    paths = unique_paths(safe_rglob(root, "*.log"))
    for path in paths:
        parse_aspirecode_desktop_log(path, invocations, trigger, cutoff)


def scan_aspirecode_timing_events(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    paths = unique_paths(safe_rglob(root, "*.jsonl"))
    for path in paths:
        parse_aspirecode_timing_jsonl(path, invocations, trigger, cutoff)


def parse_aspirecode_timing_jsonl(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    try:
        lines = read_text_cached(path, encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return

    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        if record.get("stage") != "skill.execute":
            continue
        skill_name = extract_aspirecode_timing_skill_name(record)
        if not skill_name:
            continue
        timestamp = extract_aspirecode_timing_timestamp(record)
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        invocations[skill_name].append((timestamp, trigger, str(path)))


def extract_aspirecode_timing_skill_name(record: dict[str, Any]) -> str | None:
    meta = record.get("meta")
    if isinstance(meta, dict):
        skill_name = normalize_skill_identifier(string_or_empty(meta.get("skill_name")))
        if skill_name:
            return skill_name
    skill_name = normalize_skill_identifier(string_or_empty(record.get("skill_name")))
    if skill_name:
        return skill_name
    title = record.get("title")
    if isinstance(title, str):
        match = re.search(r"Loaded skill:\s*([^\s,;]+)", title)
        if match:
            return normalize_skill_identifier(match.group(1))
    return None


def extract_aspirecode_timing_timestamp(record: dict[str, Any]) -> str:
    for key in ("start", "end", "timestamp"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def parse_aspirecode_desktop_log(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    try:
        lines = read_text_cached(path, encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return

    specific_records: list[tuple[str, str]] = []
    fallback_records: list[tuple[str, str]] = []

    for line in lines:
        if not line_may_contain_skill(line):
            continue
        timestamp = extract_log_line_timestamp(line)
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        skill_names = extract_aspirecode_log_skill_names(line)
        if not skill_names:
            continue
        records = specific_records if is_aspirecode_definitive_skill_line(line) else fallback_records
        for skill_name in skill_names:
            records.append((skill_name, timestamp))

    selected_records = specific_records if specific_records else fallback_records
    for skill_name, timestamp in selected_records:
        invocations[skill_name].append((timestamp, trigger, str(path)))


def extract_aspirecode_log_skill_names(line: str) -> list[str]:
    if is_aspirecode_log_noise(line):
        return []

    names = parse_launching_skill_names(line)
    names.extend(extract_aspirecode_skill_event_names(line))
    names.extend(extract_skill_names_from_skill_md_paths(line))

    return unique_names(names)


def extract_aspirecode_skill_event_names(line: str) -> list[str]:
    names: list[str] = []

    for pattern in (_ASPIRECODE_SKILL_START_RE, _ASPIRECODE_SKILL_LOADING_RE, _ASPIRECODE_SKILL_NAME_RE):
        for match in pattern.finditer(line):
            skill_name = normalize_skill_identifier(match.group(1))
            if skill_name:
                names.append(skill_name)

    return unique_names(names)


def is_aspirecode_definitive_skill_line(line: str) -> bool:
    return (
        any(marker in line for marker in (
            "[data-monitor-skill] Started recording skill:",
            "Skill start recorded",
            "skill.execute",
        ))
        or bool(_ASPIRECODE_SKILL_LOADING_RE.search(line))
    )


def is_aspirecode_log_noise(line: str) -> bool:
    return any(marker in line for marker in (
        "[startup]",
        "desktop.commands.directory.loaded",
        "directory.loaded",
        '"skills":[',
        '\\"skills\\":[',
        "skill_count",
        "permissionPattern",
        "duplicate skill name",
        "Registered agent:",
        "Injected build agent skill allowlist",
        "Injected plan agent skill allowlist",
        "Loaded custom prompt from:",
        "failed to load plugin",
        "Failed to start skill recording",
        "Failed to record skill",
        "requestBodyValues",
        "service=llm",
    ))


def extract_log_line_timestamp(line: str) -> str:
    match = re.match(r"^(\d{4}-\d{2}-\d{2}T\S+)", line)
    return match.group(1) if match else ""


def timestamp_from_unix_millis(value: Any) -> str:
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000.0
    elif isinstance(value, str):
        try:
            seconds = float(value) / 1000.0
        except ValueError:
            return ""
    else:
        return ""

    try:
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return ""


# Gemini/OpenCode 记录是 JSON，递归查找对象或文本里的技能调用。
def scan_json_files_in_named_dirs(
    root: Path,
    target_dir_name: str,
    invocations: InvocationMap,
    trigger: str,
    cutoff: datetime | None,
) -> None:
    for path in safe_iterdir(root):
        if not path.is_dir():
            continue
        if path.name == target_dir_name:
            scan_json_files_recursive(path, invocations, trigger, cutoff)
        else:
            scan_json_files_in_named_dirs(path, target_dir_name, invocations, trigger, cutoff)


def scan_json_files_recursive(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    for path in safe_rglob(root, "*.json"):
        parse_generic_json_file(path, invocations, trigger, cutoff)


def parse_generic_json_file(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    try:
        raw = read_text_cached(path, encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    if not text_may_contain_skill(raw):
        return

    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return

    events: list[tuple[str, str | None]] = []
    collect_skill_invocations_from_value(value, None, events)
    fallback_timestamp = file_timestamp(path)

    for skill_name, timestamp in events:
        resolved_timestamp = timestamp or fallback_timestamp or ""
        if cutoff is None or timestamp_in_range(resolved_timestamp, cutoff):
            invocations[skill_name].append((resolved_timestamp, trigger, str(path)))


def collect_skill_invocations_from_value(
    value: Any,
    inherited_timestamp: str | None,
    results: list[tuple[str, str | None]],
    parent_key: str | None = None,
) -> None:
    if isinstance(value, dict):
        current_timestamp = extract_timestamp(value) or inherited_timestamp
        skill_name = extract_skill_invocation_from_object(value)
        if skill_name:
            results.append((skill_name, current_timestamp))
            return
        for key, child in value.items():
            collect_skill_invocations_from_value(child, current_timestamp, results, str(key))
        return

    if isinstance(value, list):
        for item in value:
            collect_skill_invocations_from_value(item, inherited_timestamp, results, parent_key)
        return


def extract_skill_invocation_from_object(value: dict[str, Any]) -> str | None:
    for key in ("functionCall", "function_call"):
        function_call = value.get(key)
        if isinstance(function_call, dict):
            skill_name = extract_tool_call_skill(function_call)
            if skill_name:
                return skill_name
    return extract_tool_call_skill(value)


def extract_tool_call_skill(value: dict[str, Any]) -> str | None:
    tool_name = value.get("name") or value.get("toolName") or value.get("tool_name") or value.get("tool")
    if tool_name not in {"activate_skill", "skill"}:
        return None

    for key in ("args", "arguments", "input", "parameters", "payload"):
        if key in value:
            skill_name = extract_skill_name_from_argument_value(value[key])
            if skill_name:
                return skill_name

    state = value.get("state")
    if isinstance(state, dict):
        for key in ("args", "arguments", "input", "parameters", "payload"):
            if key in state:
                skill_name = extract_skill_name_from_argument_value(state[key])
                if skill_name:
                    return skill_name
    return None


def extract_skill_name_from_argument_value(value: Any, allow_bare_name: bool = False) -> str | None:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            skill_name = extract_slash_command_skill_name(value)
            if skill_name:
                return skill_name
            skill_names = extract_skill_names_from_skill_md_paths(value)
            if skill_names:
                return skill_names[0]
            if allow_bare_name:
                return normalize_skill_identifier(value)
            return None
        return extract_skill_name_from_argument_value(parsed, allow_bare_name=allow_bare_name)

    if isinstance(value, dict):
        for key in ("skillName", "skill_name", "identifier", "name", "path", "id", "commandName", "command_name"):
            if key in value:
                child_allow_bare_name = key in {"skillName", "skill_name", "identifier", "name", "id", "commandName", "command_name"}
                skill_name = extract_skill_name_from_argument_value(value[key], allow_bare_name=child_allow_bare_name)
                if skill_name:
                    return skill_name
        for key in ("cmd",):
            if key in value:
                skill_name = extract_skill_name_from_argument_value(value[key], allow_bare_name=False)
                if skill_name:
                    return skill_name
        for key in ("tool_input", "input", "args", "arguments", "parameters", "payload", "state"):
            if key in value:
                skill_name = extract_skill_name_from_argument_value(value[key], allow_bare_name=False)
                if skill_name:
                    return skill_name
        return None

    if isinstance(value, list):
        for item in value:
            skill_name = extract_skill_name_from_argument_value(item, allow_bare_name=allow_bare_name)
            if skill_name:
                return skill_name

    return None


def extract_slash_command_skill_name(text: str) -> str | None:
    trimmed = text.strip()
    if not trimmed.startswith("/"):
        return None

    match = re.match(r"^/([a-z0-9._:-]+)(?:\s+(.*))?$", trimmed)
    if not match:
        return None

    raw_name = match.group(1)
    remainder = match.group(2) or ""
    if raw_name.lower() in {"skill", "skills"}:
        if not remainder:
            return None
        first_token = remainder.split(None, 1)[0]
        return normalize_skill_identifier(first_token)

    return normalize_skill_identifier(raw_name)


def parse_launching_skill_names(text: str) -> list[str]:
    prefix = "Launching skill: "
    names: list[str] = []
    for line in text.splitlines():
        index = line.find(prefix)
        if index == -1:
            continue
        skill_name = normalize_skill_identifier(line[index + len(prefix):])
        if skill_name:
            names.append(skill_name)
    return names


def parse_skill_names_from_text(text: str) -> list[str]:
    names = parse_launching_skill_names(text)
    names.extend(parse_slash_skill_names(text))
    return unique_names(names)


def parse_textual_skill_invocation_names(text: str) -> list[str]:
    names = parse_launching_skill_names(text)
    names.extend(parse_slash_skill_names(text))
    return unique_names(names)


def parse_slash_skill_names(text: str) -> list[str]:
    names: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^\s*/(\S+)(?:\s+(\S+))?", line)
        if not match:
            continue
        raw_name = match.group(1)
        if raw_name.lower() in {"skill", "skills"} and match.group(2):
            raw_name = match.group(2)
        skill_name = normalize_skill_identifier(raw_name)
        if skill_name:
            names.append(skill_name)
    return unique_names(names)


def extract_skill_names_from_skill_md_paths(text: str) -> list[str]:
    normalized = text.replace("\\", "/")
    names: list[str] = []
    try:
        tokens = shlex.split(normalized)
    except ValueError:
        tokens = normalized.split()

    for token in tokens:
        candidate = token.strip().strip('"').strip("'").strip("`").strip()
        candidate = candidate.strip(".,;:])}>")
        if not candidate or any(char in candidate for char in "()[]{}<>"):
            continue
        if not _SKILL_MD_PATH_RE.fullmatch(candidate):
            continue
        skill_name = candidate.rsplit("/", 1)[-2]
        skill_name = normalize_skill_identifier(skill_name)
        if skill_name:
            names.append(skill_name)
    return unique_names(names)


def unique_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            result.append(name)
    return result


def normalize_skill_identifier(raw: str) -> str | None:
    trimmed = raw.strip().strip('"').strip("'").strip("`").strip()
    if not trimmed:
        return None

    skill_name = extract_skill_name_from_cmd(trimmed)
    if skill_name:
        return skill_name

    normalized = trimmed.replace("\\", "/")
    candidate = normalized.rsplit("/", 1)[-1].strip().strip('"').strip("'").strip("`")
    candidate = candidate.rstrip(_TRAILING_NAME_PUNCTUATION).lower()
    if not candidate or candidate.startswith("."):
        return None
    if _SKILL_NAME_RE.fullmatch(candidate):
        return candidate.lower()
    return None


def extract_skill_name_from_cmd(cmd: str) -> str | None:
    names = extract_skill_names_from_skill_md_paths(cmd)
    return names[0] if names else None


def extract_timestamp(value: dict[str, Any]) -> str | None:
    for key in ("timestamp", "createdAt", "updatedAt", "time"):
        timestamp = value.get(key)
        if isinstance(timestamp, str):
            return timestamp
    return None


def file_timestamp(path: Path) -> str | None:
    try:
        modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except OSError:
        return None
    return modified.isoformat().replace("+00:00", "Z")


def iter_jsonl_matching(path: Path, markers: tuple[str, ...]) -> list[dict[str, Any]]:
    try:
        signature = file_signature(path)
    except OSError:
        return []

    cache_key = (str(path), markers, signature)
    cached = _JSONL_MATCH_CACHE.get(cache_key)
    if cached is not None:
        return list(cached)

    try:
        lines = read_text_cached(path, encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []

    entries: list[dict[str, Any]] = []
    for line in lines:
        if not line.strip() or not any(marker in line for marker in markers):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    _JSONL_MATCH_CACHE[cache_key] = entries
    return entries


def line_may_contain_skill(line: str) -> bool:
    return (
        any(marker in line for marker in (
            "Launching skill: ",
            "[data-monitor-skill]",
            "Skill start recorded",
            "skill.execute",
        ))
        or bool(re.search(r"\bloading\s+[^\s,;)]+\s+skill\b", line, re.IGNORECASE))
    )


def text_may_contain_skill(text: str) -> bool:
    return any(marker in text for marker in (
        "Launching skill: ",
        "activate_skill",
        '"skill"',
        "functionCall",
        "function_call",
        "service=skill",
        "entry_skill=",
    ))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = read_text_cached(path, encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []

    entries: list[dict[str, Any]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries


def safe_iterdir(path: Path) -> list[Path]:
    try:
        return list(path.iterdir())
    except OSError:
        return []


def safe_rglob(path: Path, pattern: str) -> list[Path]:
    try:
        return list(path.rglob(pattern))
    except OSError:
        return []


def safe_glob(path: Path, pattern: str) -> list[Path]:
    try:
        return list(path.glob(pattern))
    except OSError:
        return []


def string_or_empty(value: Any) -> str:
    return value if isinstance(value, str) else ""


# 默认终端输出：按当前结果总数计算百分比并绘制进度条。
def format_compact_usage(usage: dict[str, Any]) -> str:
    rows = skill_rows_from_usage(usage)
    total = usage.get("allCallCount")
    if not isinstance(total, int):
        total = sum(count for _, count, _ in rows)
    if total <= 0 or not rows:
        return "No skill usage found."

    bar_width = 28
    max_count = max(count for _, count, _ in rows)
    max_name_width = max(len(name) for name, _, _ in rows)
    max_trigger_width = max(len(",".join(triggers)) for _, _, triggers in rows)
    name_width = min(max_name_width, 40)
    trigger_width = min(max(max_trigger_width, len("Trigger")), 28)
    count_width = max(len("Count"), len(str(max_count)))
    usage_width = len("Usage")
    lines = [
        f"Skill usage (total: {total})",
        "",
        f"{'Skill':<{name_width}}  {'Count':>{count_width}}  {'Trigger':<{trigger_width}}  {'Usage':>{usage_width}}  Bar",
        f"{'-' * name_width}  {'-' * count_width}  {'-' * trigger_width}  {'-' * usage_width}  {'-' * bar_width}",
    ]

    for name, count, triggers in sorted(rows, key=lambda item: (-item[1], item[0])):
        percent = count / total * 100
        filled = max(1, round(percent / 100 * bar_width))
        bar = "█" * filled + "░" * (bar_width - filled)
        display_name = truncate(name, name_width)
        display_trigger = truncate(",".join(triggers), trigger_width)
        lines.append(f"{display_name:<{name_width}}  {count:>{count_width}}  {display_trigger:<{trigger_width}}  {percent:>{usage_width}.1f}%  {bar}")

    return "\n".join(lines)


def truncate(value: str, width: int) -> str:
    return value if len(value) <= width else f"{value[:width - 1]}…"


def skill_rows_from_usage(usage: dict[str, Any]) -> list[tuple[str, int, list[str]]]:
    skills = usage.get("skills")
    if not isinstance(skills, list):
        return []

    rows: list[tuple[str, int, list[str]]] = []
    for item in skills:
        if not isinstance(item, dict):
            continue
        for name, data in item.items():
            if not isinstance(name, str) or not isinstance(data, dict):
                continue
            call_count = data.get("callCount")
            triggers = data.get("trigger")
            if isinstance(call_count, int) and isinstance(triggers, list):
                rows.append((name, call_count, [trigger for trigger in triggers if isinstance(trigger, str)]))
    return rows


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a positive integer") from None
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


# 命令行参数：默认最近 7 天、默认所有来源，-top 可选数量。
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan local Claude/Codex/Gemini/OpenCode session records and count skill invocations.",
    )
    parser.add_argument("--home", type=Path, help="User home directory to scan. Defaults to the current user's home.")
    parser.add_argument("--compact", action="store_true", help="Print minified raw JSON data instead of the terminal-friendly percentage bar chart.")
    parser.add_argument("-top", "--top", nargs="?", const=5, type=positive_int, help="Only show the top skills by call count. Defaults to 5 when no count is provided.")
    parser.add_argument("-type", "--type", default="all", help="Only count comma-separated trigger sources. Use all for every source. Defaults to all.")
    parser.add_argument("-time", "--time", choices=("week", "month", "all"), default="week", help="Time range to count: week, month, or all. Defaults to week.")
    return parser.parse_args(argv)


# 将 -type 的逗号分隔输入规范化为小写来源集合；all 表示不限制来源。
def parse_trigger_filter(value: str | None) -> set[str] | None:
    if value is None:
        return None
    triggers = {item.strip().lower() for item in value.split(",") if item.strip()}
    if "all" in triggers:
        return None
    return triggers or None


# 入口函数只负责组装过滤条件并选择表格或压缩 JSON 输出。
def main(argv: list[str]) -> int:
    args = parse_args(argv)
    max_age_days = {"week": 7, "month": 30, "all": None}[args.time]
    top_count = args.top
    trigger_filter = parse_trigger_filter(args.type)
    usage = scan_skill_usage(args.home.expanduser() if args.home else None, max_age_days, top_count, trigger_filter)
    if args.compact:
        print(json.dumps(usage, ensure_ascii=False, separators=(",", ":")))
    else:
        print(format_compact_usage(usage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
