#!/usr/bin/env python3
"""Smoke-test the tiny MCP HTTP/SSE server."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "http_server.py"
HOST = "127.0.0.1"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def wait_for_health(base_url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited early with code {process.returncode}")
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=0.5) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.05)
    raise TimeoutError("server did not become healthy in time")


def post_json(base_url: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/mcp",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def get_text(url: str) -> tuple[int, str, str]:
    request = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
    with urllib.request.urlopen(request, timeout=2) as response:
        content_type = response.headers.get("Content-Type", "")
        return response.status, content_type, response.read().decode("utf-8")


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
                            "args": [str(ROOT / "server.py")],
                            "env": {"DS_WORKSPACE": str(workspace), "MCP_CONFIG_PATH": str(external_config), "MCP_PRESETS_PATH": str(empty_presets)},
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        port = free_port()
        base_url = f"http://{HOST}:{port}"
        process = subprocess.Popen(
            [sys.executable, str(SERVER), "--host", HOST, "--port", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "DS_WORKSPACE": str(workspace), "MCP_CONFIG_PATH": str(main_config), "MCP_PRESETS_PATH": str(empty_presets)},
        )
        try:
            wait_for_health(base_url, process)

            status, init = post_json(
                base_url,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "http-smoke-test", "version": "0.1.0"},
                    },
                },
            )
            assert status == 200
            assert assert_ok(init, 1)["serverInfo"]["name"] == "tiny-test-mcp"

            status, tools = post_json(base_url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            assert status == 200
            tool_names = {tool["name"] for tool in assert_ok(tools, 2)["tools"]}
            assert {"ping", "echo", "add"}.issubset(tool_names)
            assert {"get_cwd", "list_directory", "read_file", "write_file", "execute_command"}.issubset(tool_names)
            assert {"bing_search", "crawl_webpage", "nested_ping"}.issubset(tool_names)

            status, echo = post_json(base_url, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "echo", "arguments": {"message": "hello http agent"}}})
            assert status == 200
            assert assert_ok(echo, 3)["structuredContent"]["message"] == "hello http agent"

            status, add = post_json(base_url, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "add", "arguments": {"a": 10, "b": 2.5}}})
            assert status == 200
            assert assert_ok(add, 4)["structuredContent"]["sum"] == 12.5

            status, search = post_json(base_url, {"jsonrpc": "2.0", "id": 20, "method": "tools/call", "params": {"name": "bing_search", "arguments": {"query": "mcp"}}})
            assert status == 200
            assert "未配置 Bing 搜索 API 密钥" in assert_ok(search, 20)["content"][0]["text"]

            status, external_ping = post_json(base_url, {"jsonrpc": "2.0", "id": 21, "method": "tools/call", "params": {"name": "nested_ping", "arguments": {}}})
            assert status == 200
            assert assert_ok(external_ping, 21)["structuredContent"]["ok"] is True

            status, cwd = post_json(base_url, {"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "get_cwd", "arguments": {}}})
            assert status == 200
            assert assert_ok(cwd, 10)["structuredContent"]["cwd"] == str(workspace)

            status, listing = post_json(base_url, {"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "list_directory", "arguments": {"path": "."}}})
            assert status == 200
            assert "seed.txt" in assert_ok(listing, 11)["content"][0]["text"]

            status, seed = post_json(base_url, {"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "seed.txt", "max_bytes": 200}}})
            assert status == 200
            assert "hello workspace" in assert_ok(seed, 12)["content"][0]["text"]

            status, write = post_json(base_url, {"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "write_file", "arguments": {"path": "nested/output.txt", "content": "created by mcp"}}})
            assert status == 200
            assert "nested/output.txt" in assert_ok(write, 13)["content"][0]["text"]
            assert (workspace / "nested" / "output.txt").read_text(encoding="utf-8") == "created by mcp"

            status, command = post_json(base_url, {"jsonrpc": "2.0", "id": 14, "method": "tools/call", "params": {"name": "execute_command", "arguments": {"command": "pwd", "timeout": 5}}})
            assert status == 200
            assert str(workspace) in assert_ok(command, 14)["content"][0]["text"]

            status, escape = post_json(base_url, {"jsonrpc": "2.0", "id": 15, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "../outside.txt"}}})
            assert status == 200
            assert_error(escape, 15, -32603)

            status, dangerous = post_json(base_url, {"jsonrpc": "2.0", "id": 16, "method": "tools/call", "params": {"name": "execute_command", "arguments": {"command": "rm -rf ./", "timeout": 5}}})
            assert status == 200
            assert_error(dangerous, 16, -32603)

            status, invalid = post_json(base_url, {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": []})
            assert status == 200
            assert_error(invalid, 5, -32602)

            sse_status, content_type, body = get_text(f"{base_url}/sse")
            assert sse_status == 200
            assert content_type.startswith("text/event-stream")
            assert "event: endpoint" in body
            assert "data: /mcp" in body
            assert "event: server" in body
            assert "bing_search" in body
            assert "crawl_webpage" in body
            assert "nested_ping" in body

        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    print("ok - HTTP /mcp and SSE /sse tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
