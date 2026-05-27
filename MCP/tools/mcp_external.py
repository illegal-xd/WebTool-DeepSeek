from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from typing import Any

import httpx

PROTOCOL_VERSION = "2025-03-26"


class ExternalMCPError(Exception):
    def __init__(self, message: str, code: int = -32603) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class StdioMCPServer:
    def __init__(self, name: str, config: dict[str, Any]) -> None:
        self.name = name
        self.config = config
        self.tools: list[dict[str, Any]] = []
        self._next_id = 1
        self._timeout = clamp_timeout(config.get("timeout"), 30.0)
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None

    def start(self) -> None:
        command = self.config.get("command")
        if not isinstance(command, str) or not command:
            raise ExternalMCPError(f"External MCP server '{self.name}' missing command", -32602)
        args = self.config.get("args") if isinstance(self.config.get("args"), list) else []
        env = {**os.environ, **{str(k): str(v) for k, v in self.config.get("env", {}).items()}} if isinstance(self.config.get("env"), dict) else os.environ.copy()
        cwd = self.config.get("cwd") if isinstance(self.config.get("cwd"), str) else None
        try:
            self._proc = subprocess.Popen(
                [command, *[str(arg) for arg in args]],
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            self._initialize()
            self.tools = self._list_tools()
        except FileNotFoundError as error:
            raise ExternalMCPError(f"External MCP command not found for '{self.name}': {command}") from error

    def stop(self) -> None:
        if not self._proc:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=3)
        self._proc = None

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._request("tools/call", {"name": tool_name, "arguments": arguments})

    def _initialize(self) -> None:
        self._request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "clientInfo": {"name": "WebTool-DeepSeek", "version": "1.0.0"}})
        self._notify("notifications/initialized", {})

    def _list_tools(self) -> list[dict[str, Any]]:
        result = self._request("tools/list", {})
        tools = result.get("tools")
        return tools if isinstance(tools, list) else []

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            proc = self._require_process()
            request_id = self._next_id
            self._next_id += 1
            message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            assert proc.stdin is not None
            assert proc.stdout is not None
            proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            proc.stdin.flush()
            line = self._readline(proc)
            if not line:
                raise ExternalMCPError(f"External MCP server '{self.name}' closed stdout")
            response = json.loads(line)
            if response.get("error"):
                error = response["error"]
                raise ExternalMCPError(str(error.get("message") or error), int(error.get("code") or -32603))
            return response.get("result") if isinstance(response.get("result"), dict) else {}

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        proc = self._require_process()
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, separators=(",", ":")) + "\n")
        proc.stdin.flush()

    def _readline(self, proc: subprocess.Popen[str]) -> str:
        assert proc.stdout is not None
        result: queue.Queue[str] = queue.Queue(maxsize=1)
        reader = threading.Thread(target=lambda: result.put(proc.stdout.readline()), daemon=True)
        reader.start()
        try:
            return result.get(timeout=self._timeout)
        except queue.Empty as error:
            self.stop()
            raise ExternalMCPError(f"External MCP server '{self.name}' timed out after {self._timeout:g}s") from error

    def _require_process(self) -> subprocess.Popen[str]:
        if not self._proc or self._proc.poll() is not None:
            raise ExternalMCPError(f"External MCP server '{self.name}' is not running")
        return self._proc


class HTTPMCPServer:
    def __init__(self, name: str, config: dict[str, Any]) -> None:
        self.name = name
        self.config = config
        self.tools: list[dict[str, Any]] = []
        self._next_id = 1
        self._session_id: str | None = None
        self._client = httpx.Client(timeout=clamp_timeout(config.get("timeout"), 15.0))

    def start(self) -> None:
        self._initialize()
        self.tools = self._list_tools()

    def stop(self) -> None:
        self._client.close()

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._request("tools/call", {"name": tool_name, "arguments": arguments})

    def _initialize(self) -> None:
        self._request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}}, "clientInfo": {"name": "WebTool-DeepSeek", "version": "1.0.0"}})
        self._notify("notifications/initialized", {})

    def _list_tools(self) -> list[dict[str, Any]]:
        result = self._request("tools/list", {})
        tools = result.get("tools")
        return tools if isinstance(tools, list) else []

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        response = self._post({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        data = response.json() if response.content else {"result": {}}
        if data.get("error"):
            error = data["error"]
            raise ExternalMCPError(str(error.get("message") or error), int(error.get("code") or -32603))
        return data.get("result") if isinstance(data.get("result"), dict) else {}

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        self._post({"jsonrpc": "2.0", "method": method, "params": params})

    def _post(self, body: dict[str, Any]) -> httpx.Response:
        url = self.config.get("url")
        if not isinstance(url, str) or not url:
            raise ExternalMCPError(f"External MCP HTTP server '{self.name}' missing url", -32602)
        response = self._client.post(url, json=body, headers=self._headers())
        if response.headers.get("mcp-session-id"):
            self._session_id = response.headers["mcp-session-id"]
        response.raise_for_status()
        return response

    def _headers(self) -> dict[str, str]:
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
        if isinstance(self.config.get("headers"), dict):
            headers.update({str(k): str(v) for k, v in self.config["headers"].items()})
        token = self.config.get("bearer_token") or self.config.get("token")
        if isinstance(token, str) and token:
            headers["authorization"] = f"Bearer {token}"
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers


class ExternalMCPProxy:
    def __init__(self, reserved_tool_names: set[str] | None = None) -> None:
        self._reserved_tool_names = reserved_tool_names or set()
        self._servers: dict[str, StdioMCPServer | HTTPMCPServer] = {}
        self._tools: list[dict[str, Any]] = []
        self._tool_to_server: dict[str, tuple[str, str]] = {}

    def load_config(self, mcp_servers: dict[str, Any] | None) -> None:
        self.stop_all()
        if not isinstance(mcp_servers, dict):
            return
        for name, config in mcp_servers.items():
            if not isinstance(name, str) or not isinstance(config, dict) or config.get("enabled") is False:
                continue
            server = self._create_server(name, config)
            try:
                server.start()
            except Exception as error:
                self._tools.append(error_tool(name, str(error)))
                continue
            self._servers[name] = server
            self._register_tools(name, server.tools, config)

    def stop_all(self) -> None:
        for server in self._servers.values():
            server.stop()
        self._servers.clear()
        self._tools.clear()
        self._tool_to_server.clear()

    def get_all_tools(self) -> list[dict[str, Any]]:
        return list(self._tools)

    def get_all_tool_names(self) -> set[str]:
        return set(self._tool_to_server.keys())

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        route = self._tool_to_server.get(tool_name)
        if not route:
            raise ExternalMCPError(f"External MCP tool not found: {tool_name}", -32601)
        server_name, original_tool_name = route
        return self._servers[server_name].call_tool(original_tool_name, arguments)

    def _create_server(self, name: str, config: dict[str, Any]) -> StdioMCPServer | HTTPMCPServer:
        kind = config.get("type") or config.get("kind") or ("http" if config.get("url") else "stdio")
        return HTTPMCPServer(name, config) if kind in {"http", "streamable_http"} else StdioMCPServer(name, config)

    def _register_tools(self, server_name: str, tools: list[dict[str, Any]], config: dict[str, Any]) -> None:
        configured_tools = config.get("tools")
        allowed_names = {item for item in configured_tools if isinstance(item, str)} if isinstance(configured_tools, list) else None
        for tool in tools:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                continue
            original_name = tool["name"]
            if allowed_names is not None and original_name not in allowed_names:
                continue
            exposed_name = original_name if original_name not in self._tool_to_server and original_name not in self._reserved_tool_names else f"{server_name}_{original_name}"
            descriptor = dict(tool)
            descriptor["name"] = exposed_name
            descriptor["description"] = f"[{server_name}] {descriptor.get('description') or original_name}"
            self._tools.append(descriptor)
            self._tool_to_server[exposed_name] = (server_name, original_name)



def error_tool(server_name: str, message: str) -> dict[str, Any]:
    return {
        "name": f"{server_name}_mcp_error",
        "description": f"外部 MCP 服务「{server_name}」启动失败：{message}",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    }


def clamp_timeout(value: Any, default: float) -> float:
    if isinstance(value, bool):
        return default
    try:
        number = float(value if value is not None else default)
    except (TypeError, ValueError):
        return default
    return min(max(number, 1.0), 300.0)
