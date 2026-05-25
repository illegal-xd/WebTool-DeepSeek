#!/usr/bin/env python3
"""Smoke-test the tiny MCP server over stdio."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"


def send(process: subprocess.Popen[str], message: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("server closed stdout before responding")
    return json.loads(line)


def assert_ok(response: dict[str, Any], request_id: Any) -> dict[str, Any]:
    if response.get("id") != request_id or "result" not in response:
        raise AssertionError(f"unexpected response for id={request_id}: {response}")
    return response["result"]


def assert_error(response: dict[str, Any], request_id: Any, code: int) -> dict[str, Any]:
    if response.get("id") != request_id or response.get("error", {}).get("code") != code:
        raise AssertionError(f"unexpected error for id={request_id}: {response}")
    return response["error"]


def main() -> int:
    with subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ) as process:
        init = assert_ok(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "smoke-test", "version": "0.1.0"},
                    },
                },
            ),
            1,
        )
        assert init["serverInfo"]["name"] == "tiny-test-mcp"

        tools = assert_ok(
            send(process, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
            2,
        )
        tool_names = {tool["name"] for tool in tools["tools"]}
        assert {"ping", "echo", "add"}.issubset(tool_names)

        ping = assert_ok(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "ping", "arguments": {}},
                },
            ),
            3,
        )
        assert ping["structuredContent"]["ok"] is True

        echo = assert_ok(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "echo", "arguments": {"message": "hello agent"}},
                },
            ),
            4,
        )
        assert echo["structuredContent"]["message"] == "hello agent"

        add = assert_ok(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "add", "arguments": {"a": 2, "b": 3.5}},
                },
            ),
            5,
        )
        assert add["structuredContent"]["sum"] == 5.5

        assert_error(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 6,
                    "method": "tools/call",
                    "params": {"name": "echo", "arguments": []},
                },
            ),
            6,
            -32602,
        )

        assert_error(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/list",
                    "params": [],
                },
            ),
            7,
            -32602,
        )

        assert_error(
            send(
                process,
                {
                    "jsonrpc": "1.0",
                    "id": 8,
                    "method": "tools/list",
                    "params": {},
                },
            ),
            8,
            -32600,
        )

        assert_error(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 9,
                    "params": {},
                },
            ),
            9,
            -32600,
        )

        null_id_tools = assert_ok(
            send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "method": "tools/list",
                    "params": {},
                },
            ),
            None,
        )
        assert {"ping", "echo", "add"}.issubset({tool["name"] for tool in null_id_tools["tools"]})

        invalid_id = send(
            process,
            {
                "jsonrpc": "2.0",
                "id": {"not": "valid"},
                "method": "tools/list",
                "params": {},
            },
        )
        assert_error(invalid_id, None, -32600)

        assert process.stdin is not None
        process.stdin.close()
        process.wait(timeout=5)

    print("ok - initialize, tools/list, and tools/call all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
