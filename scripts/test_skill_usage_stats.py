#!/usr/bin/env python3
from __future__ import annotations

import json
import io
import tempfile
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from contextlib import redirect_stdout

import skill_usage_stats as stats


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def codex_skill_call(timestamp: str, skill_name: str) -> dict[str, object]:
    return {
        "type": "response_item",
        "timestamp": timestamp,
        "payload": {
            "type": "function_call",
            "name": "exec_command",
            "arguments": json.dumps(
                {"cmd": f"sed -n '1,120p' /Users/demo/.codex/skills/{skill_name}/SKILL.md"}
            ),
        },
    }


def write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")


def write_json(path: Path, record: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record), encoding="utf-8")


def write_sqlite(path: Path, schema: list[str], rows: list[tuple[object, ...]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as con:
        cur = con.cursor()
        for statement in schema:
            cur.execute(statement)
        if rows:
            placeholders = ", ".join(["?"] * len(rows[0]))
            cur.executemany(f"INSERT INTO part VALUES ({placeholders})", rows)
        con.commit()


def row_map(usage: dict[str, object]) -> dict[str, tuple[int, list[str]]]:
    return {
        name: (count, triggers)
        for name, count, triggers in stats.skill_rows_from_usage(usage)
    }


def test_codex_counts_every_skill_launch_in_a_session() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        timestamp = utc_now()
        write_jsonl(
            home / ".codex" / "sessions" / "session.jsonl",
            [
                codex_skill_call(timestamp, "frontend-design"),
                codex_skill_call(timestamp, "skill-creator"),
                codex_skill_call(timestamp, "frontend-design"),
            ],
        )

        usage = stats.scan_skill_usage(home, None, None, {"codex"}, include_records=True)
        rows = row_map(usage)

        assert usage["allCallCount"] == 3
        assert rows["frontend-design"] == (2, ["codex"])
        assert rows["skill-creator"] == (1, ["codex"])
        assert len(usage["records"]) == 3


def test_namespaced_and_punctuated_skill_names_are_recognized() -> None:
    assert stats.parse_launching_skill_names("Launching skill: browser:control-in-app-browser\n") == [
        "browser:control-in-app-browser"
    ]
    assert stats.extract_skill_name_from_argument_value({"name": "browser:control-in-app-browser,"}) == "browser:control-in-app-browser"
    assert stats.extract_skill_name_from_argument_value("/skill frontend-design extra args") == "frontend-design"


def test_roots_include_terminal_and_desktop_storage_locations() -> None:
    home = Path("/Users/demo")
    original_system = stats.platform.system
    stats.platform.system = lambda: "Darwin"  # type: ignore[assignment]
    try:
        roots = stats.usage_roots(home)
    finally:
        stats.platform.system = original_system  # type: ignore[assignment]

    assert home / ".codex" / "sessions" in roots["codex"]
    assert home / ".codex" / "archived_sessions" in roots["codex"]
    assert home / ".claude" / "projects" in roots["claude"]
    assert home / ".claude" / "transcripts" in roots["claude"]
    assert home / ".local" / "share" / "opencode" / "storage" / "message" in roots["opencode"]
    assert home / ".local" / "share" / "opencode" / "storage" / "part" in roots["opencode"]
    assert home / "Library" / "Application Support" / "ai.opencode.desktop" / "opencode" / "storage" / "part" in roots["opencode"]
    assert home / "Library" / "Logs" / "ai.aspirecode.desktop" in roots["aspirecode_desktop_logs"]
    assert home / ".config" / "opencode" / "aspirecode" / "timings" in roots["aspirecode_timing_events"]


def test_claude_transcript_counts_only_skill_tool_use() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        timestamp = utc_now()
        write_jsonl(
            home / ".claude" / "transcripts" / "session.jsonl",
            [
                {"type": "tool_use", "timestamp": timestamp, "tool_name": "skill", "tool_input": {"name": "/frontend-ui-ux"}},
                {"type": "tool_result", "timestamp": timestamp, "tool_name": "skill", "tool_input": {"name": "/frontend-ui-ux"}},
                {"type": "tool_use", "timestamp": timestamp, "tool_name": "task", "tool_input": {"subagent_type": "frontend-ui-ux"}},
                {
                    "type": "assistant",
                    "timestamp": timestamp,
                    "message": {"content": [{"type": "tool_use", "name": "skill", "input": {"name": "self-improvement"}}]},
                },
            ],
        )

        usage = stats.scan_skill_usage(home, None, None, {"claude"}, include_records=True)
        rows = row_map(usage)

        assert usage["allCallCount"] == 2
        assert rows["frontend-ui-ux"] == (1, ["claude"])
        assert rows["self-improvement"] == (1, ["claude"])
        assert len(usage["records"]) == 2


def test_claude_tool_result_text_does_not_count_without_tool_use() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        timestamp = utc_now()
        write_jsonl(
            home / ".claude" / "projects" / "session.jsonl",
            [
                {
                    "type": "user",
                    "timestamp": timestamp,
                    "message": {
                        "content": [
                            {
                                "type": "tool_result",
                                "content": "## activate_skill: 0\nLaunching skill: not-a-real-skill\n",
                            }
                        ]
                    },
                }
            ],
        )

        usage = stats.scan_skill_usage(home, None, None, {"claude"}, include_records=True)

        assert usage["allCallCount"] == 0
        assert usage.get("records", []) == []


def test_opencode_part_tool_shape_counts_skill_and_ignores_diff_text() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        write_json(
            home / ".local" / "share" / "opencode" / "storage" / "part" / "msg_1" / "part.json",
            {
                "type": "tool",
                "tool": "skill",
                "state": {"status": "completed", "input": {"name": "browser:control-in-app-browser"}},
            },
        )
        write_json(
            home / ".local" / "share" / "opencode" / "storage" / "message" / "ses_1" / "msg.json",
            {
                "type": "session_diff",
                "text": "+ /Users/demo/.agents/skills/not-a-skill-call/SKILL.md",
            },
        )

        original_system = stats.platform.system
        stats.platform.system = lambda: "Darwin"  # type: ignore[assignment]
        try:
            usage = stats.scan_skill_usage(home, None, None, {"opencode"}, include_records=True)
        finally:
            stats.platform.system = original_system  # type: ignore[assignment]

        rows = row_map(usage)
        assert usage["allCallCount"] == 1
        assert rows["browser:control-in-app-browser"] == (1, ["opencode"])
        assert "not-a-skill-call" not in rows


def test_opencode_sqlite_database_counts_skill_tool_input_name() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        db_path = home / ".local" / "share" / "opencode" / "opencode.db"
        with sqlite3.connect(db_path) as con:
            cur = con.cursor()
            cur.execute("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
            cur.execute(
                "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
                (
                    "prt_1",
                    "msg_1",
                    "ses_1",
                    1779180469140,
                    1779180469140,
                    json.dumps(
                        {
                            "type": "tool",
                            "tool": "skill",
                            "state": {
                                "status": "completed",
                                "input": {"name": "browser:control-in-app-browser"},
                            },
                        }
                    ),
                ),
            )
            con.commit()

        usage = stats.scan_skill_usage(home, None, None, {"opencode"}, include_records=True)
        rows = row_map(usage)

        assert usage["allCallCount"] == 1
        assert rows["browser:control-in-app-browser"] == (1, ["opencode"])
        assert usage["records"][0]["sourcePath"].endswith("opencode.db")


def test_aspirecode_timing_events_count_skill_execute_and_ignore_desktop_noise() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        timing_path = home / ".config" / "opencode" / "aspirecode" / "timings" / "events.jsonl"
        write_jsonl(
            timing_path,
            [
                {
                    "trace_id": "delivery-1",
                    "stage": "skill.execute",
                    "provider_name": "CUSTOMMOTA-API",
                    "model_name": "gpt-5.5",
                    "project_name": "demo",
                    "project_dir": "/Users/demo/project",
                    "session_id": "ses_1",
                    "start": "2026-06-10T08:00:00+08:00",
                    "end": "2026-06-10T08:00:01+08:00",
                    "status": "completed",
                    "meta": {"skill_name": "vue-best-practices", "call_id": "call_1", "title": "Loaded skill: vue-best-practices"},
                }
            ],
        )
        write_jsonl(
            home / "Library" / "Logs" / "ai.aspirecode.desktop" / "aspirecode-desktop_2026-06-10.log",
            [
                {
                    "timestamp": utc_now(),
                    "line": '2026-06-10T08:00:00Z INFO sidecar: service=skill name=kimi-webbridge existing=/a/SKILL.md duplicate=/b/SKILL.md duplicate skill name',
                }
            ],
        )

        usage = stats.scan_skill_usage(home, None, None, {"aspirecode"}, include_records=True)
        rows = row_map(usage)

        assert usage["allCallCount"] == 1
        assert rows["vue-best-practices"] == (1, ["aspirecode"])
        assert "kimi-webbridge" not in rows



def test_codex_ignores_skill_path_inside_script_text() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        write_jsonl(
            home / ".codex" / "sessions" / "session.jsonl",
            [
                {
                    "type": "response_item",
                    "timestamp": utc_now(),
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "arguments": json.dumps(
                            {
                                "cmd": "python3 - <<'PY'\nprint('/Users/demo/.codex/skills/not-a-skill-call/SKILL.md')\nPY",
                            }
                        ),
                    },
                }
            ],
        )

        usage = stats.scan_skill_usage(home, None, None, {"codex"}, include_records=True)

        assert usage["allCallCount"] == 0
        assert usage.get("records", []) == []


def test_aspirecode_desktop_logs_skip_startup_noise_and_scan_aspire_logs() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        log_path = home / "Library" / "Logs" / "ai.aspirecode.desktop" / "aspirecode-desktop_2026-06-10.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(
            "\n".join(
                [
                    '2026-06-10T08:00:00Z INFO asp_app: [startup] desktop.commands.directory.loaded meta="{\\"skills\\":[{\\"name\\":\\"agent-browser\\",\\"permissionPattern\\":\\"/Users/demo/.agents/skills/agent-browser/SKILL.md\\"}]}"',
                    "2026-06-10T08:00:01Z INFO sidecar: service=skill name=kimi-webbridge existing=/a/SKILL.md duplicate=/b/SKILL.md duplicate skill name",
                    "2026-06-10T08:00:02Z INFO sidecar: Launching skill: browser:control-in-app-browser",
                ]
            ),
            encoding="utf-8",
        )

        usage = stats.scan_skill_usage(home, None, None, {"aspirecode"}, include_records=True)
        rows = row_map(usage)

        assert stats.extract_aspirecode_log_skill_names(log_path.read_text(encoding="utf-8").splitlines()[0]) == []
        assert usage["allCallCount"] == 1
        assert rows["browser:control-in-app-browser"] == (1, ["aspirecode"])
        assert "agent-browser" not in rows
        assert "kimi-webbridge" not in rows


def test_repeated_scan_reuses_unchanged_file_content() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        session = home / ".codex" / "sessions" / "session.jsonl"
        write_jsonl(session, [codex_skill_call(utc_now(), "frontend-design")])

        stats.clear_scan_cache()
        original_read_text = Path.read_text
        read_count = 0

        def counting_read_text(self: Path, *args: object, **kwargs: object) -> str:
            nonlocal read_count
            if self == session:
                read_count += 1
            return original_read_text(self, *args, **kwargs)

        Path.read_text = counting_read_text  # type: ignore[method-assign]
        try:
            first = stats.scan_skill_usage(home, None, None, {"codex"})
            second = stats.scan_skill_usage(home, None, None, {"codex"})
        finally:
            Path.read_text = original_read_text  # type: ignore[method-assign]
            stats.clear_scan_cache()

        assert first == second
        assert read_count == 1


def test_top_limit_does_not_truncate_total_call_count() -> None:
    invocations: stats.InvocationMap = {
        "alpha": [("2026-06-10T08:00:00Z", "codex", "a")] * 3,
        "beta": [("2026-06-10T08:00:00Z", "codex", "b")] * 2,
        "gamma": [("2026-06-10T08:00:00Z", "codex", "c")],
    }

    usage = stats.summarize_invocations(invocations, top_count=2)

    assert usage["allCallCount"] == 6
    assert [name for name, _, _ in stats.skill_rows_from_usage(usage)] == ["alpha", "beta"]


def test_main_defaults_to_all_sources() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        home = Path(temp_dir)
        timestamp = utc_now()
        write_jsonl(home / ".codex" / "sessions" / "session.jsonl", [codex_skill_call(timestamp, "frontend-design")])
        write_jsonl(
            home / ".claude" / "transcripts" / "session.jsonl",
            [{"type": "tool_use", "timestamp": timestamp, "tool_name": "skill", "tool_input": {"name": "obsidian-markdown"}}],
        )

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            exit_code = stats.main(["--home", str(home), "--compact"])

        payload = json.loads(buffer.getvalue())
        assert exit_code == 0
        assert payload["allCallCount"] == 2
        assert {name for item in payload["skills"] for name in item} == {"frontend-design", "obsidian-markdown"}


def main() -> int:
    tests: list[Callable[[], None]] = [
        test_codex_counts_every_skill_launch_in_a_session,
        test_namespaced_and_punctuated_skill_names_are_recognized,
        test_roots_include_terminal_and_desktop_storage_locations,
        test_claude_transcript_counts_only_skill_tool_use,
        test_claude_tool_result_text_does_not_count_without_tool_use,
        test_opencode_part_tool_shape_counts_skill_and_ignores_diff_text,
        test_codex_ignores_skill_path_inside_script_text,
        test_aspirecode_desktop_logs_skip_startup_noise_and_scan_aspire_logs,
        test_repeated_scan_reuses_unchanged_file_content,
        test_top_limit_does_not_truncate_total_call_count,
        test_main_defaults_to_all_sources,
    ]
    failures: list[str] = []
    for test in tests:
        try:
            test()
        except Exception as error:
            failures.append(f"{test.__name__}: {error}")

    if failures:
        print("\n".join(failures))
        return 1
    print(f"{len(tests)} skill_usage_stats tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
