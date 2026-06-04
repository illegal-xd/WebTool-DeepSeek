#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# 每条调用记录保存时间戳、来源类型和记录文件路径。
Invocation = tuple[str, str, str]
InvocationMap = dict[str, list[Invocation]]


# 收集不同客户端在各平台上的会话或日志目录。
def usage_roots(home: Path) -> dict[str, list[Path]]:
    roots = {
        "claude": [home / ".claude" / "projects"],
        "codex": [home / ".codex" / "sessions"],
        "gemini": [home / ".gemini" / "tmp"],
        "opencode": [],
        "aspirecode_desktop_logs": [home / "Library" / "Logs" / "ai.aspirecode.desktop"],
    }

    system = platform.system().lower()
    if system == "darwin":
        roots["opencode"] = [
            home / "Library" / "Application Support" / "opencode" / "storage" / "message",
            home / ".opencode" / "storage" / "message",
        ]
    elif system == "windows":
        app_data = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
        local_app_data = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        roots["opencode"] = [
            app_data / "opencode" / "storage" / "message",
            app_data / "OpenCode" / "storage" / "message",
            local_app_data / "opencode" / "storage" / "message",
            local_app_data / "OpenCode" / "storage" / "message",
            home / ".opencode" / "storage" / "message",
        ]
    else:
        data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
        state_home = Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state")
        config_home = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        roots["opencode"] = [
            data_home / "opencode" / "storage" / "message",
            state_home / "opencode" / "storage" / "message",
            config_home / "opencode" / "storage" / "message",
            home / ".opencode" / "storage" / "message",
        ]

    return {name: unique_paths(paths) for name, paths in roots.items()}


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

    for name, records in invocations.items():
        filtered_records = [
            record for record in records
            if (cutoff is None or timestamp_in_range(record[0], cutoff))
            and (trigger_filter is None or record[1] in trigger_filter)
        ]
        if filtered_records:
            triggers = sorted({record[1] for record in filtered_records})
            summaries.append((name, len(filtered_records), triggers))
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
        "allCallCount": sum(call_count for _, call_count, _ in summaries),
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
    for path in safe_iterdir(root):
        if path.is_dir():
            for child in safe_iterdir(path):
                if child.suffix == ".jsonl":
                    parse_claude_jsonl(child, invocations, trigger, cutoff)
        elif path.suffix == ".jsonl":
            parse_claude_jsonl(path, invocations, trigger, cutoff)


def parse_claude_jsonl(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    for entry in iter_jsonl_matching(path, ("Launching skill: ",)):
        if entry.get("type") != "user":
            continue
        timestamp = string_or_empty(entry.get("timestamp"))
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        content = entry.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            for skill_name in extract_claude_skill_names(block):
                invocations[skill_name].append((timestamp, trigger, str(path)))


def extract_claude_skill_names(block: dict[str, Any]) -> list[str]:
    content = block.get("content")
    if isinstance(content, str):
        return parse_launching_skill_names(content)
    if isinstance(content, list):
        names: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                names.extend(parse_launching_skill_names(item["text"]))
        return names
    return []


# Codex 记录里通过 exec_command 调用 SKILL.md，因此按命令路径提取技能名。
def scan_codex_sessions(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    for path in safe_rglob(root, "*.jsonl"):
        parse_codex_jsonl(path, invocations, trigger, cutoff)


def parse_codex_jsonl(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    seen: dict[str, str] = {}
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
        skill_name = extract_skill_name_from_cmd(cmd)
        if skill_name and skill_name not in seen:
            seen[skill_name] = timestamp

    for skill_name, timestamp in seen.items():
        invocations[skill_name].append((timestamp, trigger, str(path)))


def scan_gemini_sessions(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    scan_json_files_in_named_dirs(root, "chats", invocations, trigger, cutoff)


def scan_opencode_messages(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    scan_json_files_recursive(root, invocations, trigger, cutoff)


# AspireCode 桌面日志是文本日志，需要从日志行里匹配技能名。
def scan_aspirecode_desktop_logs(root: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    for path in safe_glob(root, "opencode-desktop_*.log"):
        parse_aspirecode_desktop_log(path, invocations, trigger, cutoff)


def parse_aspirecode_desktop_log(path: Path, invocations: InvocationMap, trigger: str, cutoff: datetime | None) -> None:
    if not path_may_contain_recent_records(path, cutoff):
        return

    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return

    for line in lines:
        if not line_may_contain_skill(line):
            continue
        timestamp = extract_log_line_timestamp(line)
        if cutoff is not None and not timestamp_in_range(timestamp, cutoff):
            continue
        skill_names = extract_aspirecode_log_skill_names(line)
        for skill_name in skill_names:
            invocations[skill_name].append((timestamp, trigger, str(path)))


def extract_aspirecode_log_skill_names(line: str) -> list[str]:
    if is_aspirecode_log_noise(line):
        return []

    names = parse_launching_skill_names(line)
    names.extend(extract_skill_names_from_skill_md_paths(line))

    service_match = re.search(r"\bservice=skill\b.*?\bname=([^\s]+)", line)
    if service_match:
        skill_name = normalize_skill_identifier(service_match.group(1))
        if skill_name:
            names.append(skill_name)

    if "Registered agent:" not in line:
        entry_match = re.search(r"\bentry_skill=([^\s)]+)", line)
        if entry_match and entry_match.group(1) != "undefined":
            skill_name = normalize_skill_identifier(entry_match.group(1))
            if skill_name:
                names.append(skill_name)

    return unique_names(names)


def is_aspirecode_log_noise(line: str) -> bool:
    return any(marker in line for marker in (
        "duplicate skill name",
        "Registered agent:",
        "Injected build agent skill allowlist",
        "Injected plan agent skill allowlist",
        "Loaded custom prompt from:",
        "failed to load plugin",
    ))


def extract_log_line_timestamp(line: str) -> str:
    match = re.match(r"^(\d{4}-\d{2}-\d{2}T\S+)", line)
    return match.group(1) if match else ""


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
        raw = path.read_text(encoding="utf-8")
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
) -> None:
    if isinstance(value, dict):
        current_timestamp = extract_timestamp(value) or inherited_timestamp
        skill_name = extract_skill_invocation_from_object(value)
        if skill_name:
            results.append((skill_name, current_timestamp))
            return
        for child in value.values():
            collect_skill_invocations_from_value(child, current_timestamp, results)
        return

    if isinstance(value, list):
        for item in value:
            collect_skill_invocations_from_value(item, inherited_timestamp, results)
        return

    if isinstance(value, str):
        for skill_name in parse_skill_names_from_text(value):
            results.append((skill_name, inherited_timestamp))


def extract_skill_invocation_from_object(value: dict[str, Any]) -> str | None:
    for key in ("functionCall", "function_call"):
        function_call = value.get(key)
        if isinstance(function_call, dict):
            skill_name = extract_tool_call_skill(function_call)
            if skill_name:
                return skill_name
    return extract_tool_call_skill(value)


def extract_tool_call_skill(value: dict[str, Any]) -> str | None:
    tool_name = value.get("name") or value.get("toolName") or value.get("tool_name")
    if tool_name not in {"activate_skill", "skill"}:
        return None

    for key in ("args", "arguments", "input", "parameters", "payload"):
        if key in value:
            skill_name = extract_skill_name_from_argument_value(value[key])
            if skill_name:
                return skill_name
    return None


def extract_skill_name_from_argument_value(value: Any) -> str | None:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return normalize_skill_identifier(value)
        return extract_skill_name_from_argument_value(parsed)

    if isinstance(value, dict):
        for key in ("skillName", "skill_name", "identifier", "name", "path", "id"):
            if key in value:
                skill_name = extract_skill_name_from_argument_value(value[key])
                if skill_name:
                    return skill_name
        for child in value.values():
            skill_name = extract_skill_name_from_argument_value(child)
            if skill_name:
                return skill_name
        return None

    if isinstance(value, list):
        for item in value:
            skill_name = extract_skill_name_from_argument_value(item)
            if skill_name:
                return skill_name

    return None


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
    if names:
        return names
    return extract_skill_names_from_skill_md_paths(text)


def extract_skill_names_from_skill_md_paths(text: str) -> list[str]:
    normalized = text.replace("\\", "/")
    names: list[str] = []
    for match in re.finditer(r"([^\s\"']+)/SKILL\.md", normalized):
        candidate = match.group(1).rsplit("/", 1)[-1]
        skill_name = normalize_skill_identifier(candidate)
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
    trimmed = raw.strip().strip('"').strip("'")
    if not trimmed:
        return None

    skill_name = extract_skill_name_from_cmd(trimmed)
    if skill_name:
        return skill_name

    normalized = trimmed.replace("\\", "/")
    candidate = normalized.rsplit("/", 1)[-1]
    if not candidate or candidate.startswith("."):
        return None
    if all(ch.isascii() and (ch.isalnum() or ch in "-_.") for ch in candidate):
        return candidate.lower()
    return None


def extract_skill_name_from_cmd(cmd: str) -> str | None:
    normalized = cmd.replace("\\", "/")
    index = normalized.find("/SKILL.md")
    if index == -1:
        return None
    before = normalized[:index]
    name = before.rsplit("/", 1)[-1]
    if not name or name.startswith("."):
        return None
    return name.lower()


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
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
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
    return entries


def line_may_contain_skill(line: str) -> bool:
    return any(marker in line for marker in (
        "Launching skill: ",
        "/SKILL.md",
        "service=skill",
        "entry_skill=",
    ))


def text_may_contain_skill(text: str) -> bool:
    return any(marker in text for marker in (
        "Launching skill: ",
        "/SKILL.md",
        "activate_skill",
        '"skill"',
        "functionCall",
        "function_call",
        "service=skill",
        "entry_skill=",
    ))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
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


# 命令行参数：默认最近 7 天、默认来源 aspirecode，-top 可选数量。
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan local Claude/Codex/Gemini/OpenCode session records and count skill invocations.",
    )
    parser.add_argument("--home", type=Path, help="User home directory to scan. Defaults to the current user's home.")
    parser.add_argument("--compact", action="store_true", help="Print minified raw JSON data instead of the terminal-friendly percentage bar chart.")
    parser.add_argument("-top", "--top", nargs="?", const=5, type=positive_int, help="Only show the top skills by call count. Defaults to 5 when no count is provided.")
    parser.add_argument("-type", "--type", default="aspirecode", help="Only count comma-separated trigger sources. Use all for every source. Defaults to aspirecode.")
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
