#!/usr/bin/env python3
"""Smoke-test the tiny MCP server over stdio."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
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
    with tempfile.TemporaryDirectory() as temp_dir:
        workspace = Path(temp_dir).resolve()
        (workspace / "nested").mkdir()
        (workspace / "seed.txt").write_text("hello workspace", encoding="utf-8")

        empty_presets = workspace / "presets.json"
        empty_presets.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
        empty_js_config = workspace / "config.js"
        empty_js_config.write_text("module.exports = {};\n", encoding="utf-8")
        external_config = workspace / "external-mcp.json"
        external_config.write_text(json.dumps({"services": {"web_search": {"enabled": False}}}), encoding="utf-8")
        main_config = workspace / "mcp.json"
        main_config.write_text(
            json.dumps(
                {
                    "services": {
                        "web_search": {
                            "tools": ["bing_search", "crawl_webpage"],
                            "config": {"bing_api_key": "YOUR_BING_API_KEY_HERE"},
                        }
                    },
                    "mcpServers": {
                        "nested": {
                            "type": "stdio",
                            "command": sys.executable,
                            "args": [str(SERVER)],
                            "env": {"DS_WORKSPACE": str(workspace), "MCP_CONFIG_PATH": str(external_config), "MCP_PRESETS_PATH": str(empty_presets)},
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        with subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "DS_WORKSPACE": str(workspace), "MCP_CONFIG_PATH": str(main_config), "MCP_JS_CONFIG_PATH": str(empty_js_config), "MCP_PRESETS_PATH": str(empty_presets)},
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

            tools = assert_ok(send(process, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}), 2)
            tool_names = {tool["name"] for tool in tools["tools"]}
            assert {"ping", "echo", "add"}.issubset(tool_names)
            assert {"get_cwd", "list_directory", "read_file", "write_file", "execute_command"}.issubset(tool_names)
            assert {"bing_search", "crawl_webpage", "nested_ping"}.issubset(tool_names)

            ping = assert_ok(send(process, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ping", "arguments": {}}}), 3)
            assert ping["structuredContent"]["ok"] is True

            echo = assert_ok(send(process, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "echo", "arguments": {"message": "hello agent"}}}), 4)
            assert echo["structuredContent"]["message"] == "hello agent"

            add = assert_ok(send(process, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "add", "arguments": {"a": 2, "b": 3.5}}}), 5)
            assert add["structuredContent"]["sum"] == 5.5

            search = assert_ok(send(process, {"jsonrpc": "2.0", "id": 20, "method": "tools/call", "params": {"name": "bing_search", "arguments": {"query": "mcp"}}}), 20)
            assert "未配置 Bing 搜索 API 密钥" in search["content"][0]["text"]

            external_ping = assert_ok(send(process, {"jsonrpc": "2.0", "id": 21, "method": "tools/call", "params": {"name": "nested_ping", "arguments": {}}}), 21)
            assert external_ping["structuredContent"]["ok"] is True

            cwd = assert_ok(send(process, {"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "get_cwd", "arguments": {}}}), 10)
            assert cwd["structuredContent"]["cwd"] == str(workspace)

            listing = assert_ok(send(process, {"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "list_directory", "arguments": {"path": "."}}}), 11)
            assert "seed.txt" in listing["content"][0]["text"]

            seed = assert_ok(send(process, {"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "seed.txt", "max_bytes": 200}}}), 12)
            assert "hello workspace" in seed["content"][0]["text"]

            write = assert_ok(send(process, {"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "write_file", "arguments": {"path": "nested/output.txt", "content": "created by mcp"}}}), 13)
            assert "nested/output.txt" in write["content"][0]["text"]
            assert (workspace / "nested" / "output.txt").read_text(encoding="utf-8") == "created by mcp"

            command = assert_ok(send(process, {"jsonrpc": "2.0", "id": 14, "method": "tools/call", "params": {"name": "execute_command", "arguments": {"command": "pwd", "timeout": 5}}}), 14)
            assert str(workspace) in command["content"][0]["text"]

            assert_error(send(process, {"jsonrpc": "2.0", "id": 15, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "../outside.txt"}}}), 15, -32603)
            assert_error(send(process, {"jsonrpc": "2.0", "id": 16, "method": "tools/call", "params": {"name": "execute_command", "arguments": {"command": "rm -rf ./", "timeout": 5}}}), 16, -32603)
            assert_error(send(process, {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "echo", "arguments": []}}), 6, -32602)
            assert_error(send(process, {"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": []}), 7, -32602)
            assert_error(send(process, {"jsonrpc": "1.0", "id": 8, "method": "tools/list", "params": {}}), 8, -32600)
            assert_error(send(process, {"jsonrpc": "2.0", "id": 9, "params": {}}), 9, -32600)

            null_id_tools = assert_ok(send(process, {"jsonrpc": "2.0", "id": None, "method": "tools/list", "params": {}}), None)
            assert {"ping", "echo", "add"}.issubset({tool["name"] for tool in null_id_tools["tools"]})

            invalid_id = send(process, {"jsonrpc": "2.0", "id": {"not": "valid"}, "method": "tools/list", "params": {}})
            assert_error(invalid_id, None, -32600)

            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=5)
            assert process.stderr is not None
            stderr = process.stderr.read()
            assert "tool call error: name=read_file" in stderr
            assert "tool call error: name=execute_command" in stderr
            assert "tool call error: name=echo" in stderr

        restricted_js_config = workspace / "config.js"
        restricted_js_config.write_text(
            """
module.exports = {
  services: {
    shell: { tools: ['get_cwd'] },
    web_search: { enabled: false },
  },
  mcpServers: {
    nested: { tools: ['ping'] },
  },
};
""".strip(),
            encoding="utf-8",
        )
        with subprocess.Popen(
            [sys.executable, str(SERVER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={
                **os.environ,
                "DS_WORKSPACE": str(workspace),
                "MCP_CONFIG_PATH": str(main_config),
                "MCP_JS_CONFIG_PATH": str(restricted_js_config),
                "MCP_PRESETS_PATH": str(empty_presets),
            },
        ) as process:
            tools = assert_ok(send(process, {"jsonrpc": "2.0", "id": 30, "method": "tools/list", "params": {}}), 30)
            tool_names = {tool["name"] for tool in tools["tools"]}
            assert "get_cwd" in tool_names
            assert "list_directory" not in tool_names
            assert "bing_search" not in tool_names
            assert "nested_ping" in tool_names
            assert "nested_echo" not in tool_names

            assert_ok(send(process, {"jsonrpc": "2.0", "id": 31, "method": "tools/call", "params": {"name": "get_cwd", "arguments": {}}}), 31)
            assert_ok(send(process, {"jsonrpc": "2.0", "id": 32, "method": "tools/call", "params": {"name": "nested_ping", "arguments": {}}}), 32)
            assert_error(send(process, {"jsonrpc": "2.0", "id": 33, "method": "tools/call", "params": {"name": "list_directory", "arguments": {"path": "."}}}), 33, -32601)

            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=5)

    print("ok - initialize, tools/list, and tools/call all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
