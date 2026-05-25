#!/usr/bin/env python3
"""Smoke-test the tiny MCP HTTP/SSE server."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
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
    port = free_port()
    base_url = f"http://{HOST}:{port}"
    process = subprocess.Popen(
        [sys.executable, str(SERVER), "--host", HOST, "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
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
        assert {"ping", "echo", "add"}.issubset({tool["name"] for tool in assert_ok(tools, 2)["tools"]})

        status, echo = post_json(
            base_url,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "echo", "arguments": {"message": "hello http agent"}},
            },
        )
        assert status == 200
        assert assert_ok(echo, 3)["structuredContent"]["message"] == "hello http agent"

        status, add = post_json(
            base_url,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "add", "arguments": {"a": 10, "b": 2.5}},
            },
        )
        assert status == 200
        assert assert_ok(add, 4)["structuredContent"]["sum"] == 12.5

        status, invalid = post_json(base_url, {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": []})
        assert status == 200
        assert_error(invalid, 5, -32602)

        sse_status, content_type, body = get_text(f"{base_url}/sse")
        assert sse_status == 200
        assert content_type.startswith("text/event-stream")
        assert "event: endpoint" in body
        assert "data: /mcp" in body
        assert "event: server" in body

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
