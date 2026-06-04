#!/usr/bin/env python3
"""Tiny stdio MCP server with configurable local and external tools."""

from __future__ import annotations

import atexit
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from tools import search, shell
from tools.mcp_external import ExternalMCPError, ExternalMCPProxy


SERVER_NAME = "tiny-test-mcp"
SERVER_VERSION = "0.2.0"
PROTOCOL_VERSION = "2024-11-05"
ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.skill_usage_stats import format_compact_usage, scan_skill_usage
from scripts.stock_tech import StockTechError, query_stock_tech


SKILL_USAGE_SOURCES = {"claude", "codex", "gemini", "opencode", "aspirecode"}


def load_json_file(env_name: str, default_name: str) -> dict[str, Any]:
    config_path = Path(os.environ.get(env_name) or ROOT / default_name)
    if not config_path.exists():
        return {}
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def load_js_config_file(env_name: str, default_name: str) -> dict[str, Any]:
    config_path = Path(os.environ.get(env_name) or ROOT / default_name)
    if not config_path.exists():
        return {}
    script = """
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const configPath = path.resolve(process.argv[1]);
const moduleRef = { exports: {} };
const sandbox = {
  module: moduleRef,
  exports: moduleRef.exports,
  require: createRequire(configPath),
  __filename: configPath,
  __dirname: path.dirname(configPath),
  console,
  process,
};
vm.runInNewContext(fs.readFileSync(configPath, 'utf8'), sandbox, { filename: configPath });
const config = moduleRef.exports && Object.keys(moduleRef.exports).length > 0 ? moduleRef.exports : sandbox.exports;
if (!config || Array.isArray(config) || typeof config !== 'object') process.exit(2);
process.stdout.write(JSON.stringify(config));
"""
    try:
        output = subprocess.check_output(["node", "-e", script, str(config_path)], text=True, timeout=5)
        data = json.loads(output)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def merge_config(*configs: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for config in configs:
        for key, value in config.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = merge_config(merged[key], value)
            else:
                merged[key] = value
    return merged


def merge_mcp_servers(*configs: dict[str, Any]) -> dict[str, Any]:
    # MCP server 配置按名称深度合并，让 mcp.json 可补全 presets.json 中的 command/args/tools。
    servers: dict[str, Any] = {}
    for config in configs:
        mcp_servers = config.get("mcpServers")
        if not isinstance(mcp_servers, dict):
            continue
        for name, server_config in mcp_servers.items():
            if isinstance(server_config, dict) and isinstance(servers.get(name), dict):
                servers[name] = merge_config(servers[name], server_config)
            else:
                servers[name] = server_config
    return servers


PRESETS = load_json_file("MCP_PRESETS_PATH", "presets.json")
JSON_CONFIG = load_json_file("MCP_CONFIG_PATH", "mcp.json")
JS_CONFIG = load_js_config_file("MCP_JS_CONFIG_PATH", "config.js")
CONFIG = merge_config(JSON_CONFIG, JS_CONFIG)


CONNECTIVITY_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "ping",
        "description": "返回 pong 与服务端当前时间，用于验证 MCP 服务是否可用。",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
]


CORE_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "echo",
        "description": "回显传入文本，用于验证 MCP 工具参数传递是否正常。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "要回显的文本。",
                }
            },
            "required": ["message"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add",
        "description": "计算两个数字之和，并返回结构化结果。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "第一个数字。"},
                "b": {"type": "number", "description": "第二个数字。"},
            },
            "required": ["a", "b"],
            "additionalProperties": False,
        },
    },
    {
        "name": "stock_tech",
        "description": "查询A股实时行情与技术面指标（MACD/RSI/KDJ/布林带/量比）。"
                    "复用 scripts/stock_tech.py 的查询逻辑，实时行情和K线均按脚本内置数据源顺序兜底。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "股票代码，如 002050（三花智控）、600519（贵州茅台）。"
                                    "6/9/7开头=上海，其余=深圳。",
                    "examples": ["002050", "600519", "000001", "300750"],
                },
            },
            "required": ["symbol"],
            "additionalProperties": False,
        },
    },
    {
        "name": "skill_usage_stats",
        "description": "查询本机 skills 使用情况。默认最近一周、Top 10、所有来源，并返回原始调用记录源数据。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "time_range": {
                    "type": "string",
                    "enum": ["week", "month", "all"],
                    "description": "统计时间范围。默认 week。",
                },
                "max_age_days": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "自定义最近 N 天；提供后覆盖 time_range。",
                },
                "top": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "description": "返回 Top N。默认 10；0 表示不限制。",
                },
                "sources": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["claude", "codex", "gemini", "opencode", "aspirecode"]},
                    "uniqueItems": True,
                    "description": "来源过滤；省略或空数组表示所有来源。",
                },
                "home": {
                    "type": "string",
                    "description": "可选：指定要扫描的用户 home 目录。默认当前用户 home。",
                },
            },
            "additionalProperties": False,
        },
    },
]


def service_config_from(config_data: dict[str, Any], name: str) -> dict[str, Any]:
    services = config_data.get("services")
    if not isinstance(services, dict):
        return {}
    config = services.get(name)
    return config if isinstance(config, dict) else {}


def service_config(name: str) -> dict[str, Any]:
    return service_config_from(CONFIG, name)


def configured_tools(definitions: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    # 默认不暴露业务工具；必须通过 enabled:true 或 tools 白名单显式开启。
    if config.get("enabled") is False:
        return []
    selected_tools = config.get("tools")
    if isinstance(selected_tools, list):
        names = {item for item in selected_tools if isinstance(item, str)}
        return [tool for tool in definitions if tool.get("name") in names]
    if config.get("enabled") is True:
        return list(definitions)
    return []


def core_tools() -> list[dict[str, Any]]:
    # 只有 config.js 顶层 tools 是本地工具的开关；mcp.json 只保留给外部 MCP 基础配置。
    config = {"tools": JS_CONFIG.get("tools")} if isinstance(JS_CONFIG.get("tools"), list) else {}
    return configured_tools(CORE_TOOL_DEFINITIONS, config)


def service_tools(name: str, definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # shell/web_search 这类高权限服务只接受 config.js 显式开启，避免继承旧 JSON 配置误暴露。
    return configured_tools(definitions, service_config_from(JS_CONFIG, name))


def service_tool_config(name: str) -> dict[str, Any]:
    config = service_config(name).get("config")
    return config if isinstance(config, dict) else {}


def enabled_mcp_servers() -> dict[str, Any]:
    # presets.json/mcp.json 只提供可复用定义；config.js.mcpServers 才决定哪些外部服务真正启动。
    js_servers = JS_CONFIG.get("mcpServers")
    if not isinstance(js_servers, dict):
        return {}
    base_servers = merge_mcp_servers(PRESETS, JSON_CONFIG)
    servers: dict[str, Any] = {}
    for name, js_config in js_servers.items():
        if not isinstance(name, str) or not isinstance(js_config, dict):
            continue
        if js_config.get("enabled") is False:
            continue
        configured = js_config.get("enabled") is True or isinstance(js_config.get("tools"), list) or "command" in js_config or "url" in js_config
        if not configured:
            continue
        base_config = base_servers.get(name)
        servers[name] = merge_config(base_config, js_config) if isinstance(base_config, dict) else dict(js_config)
    return servers


TOOLS: list[dict[str, Any]] = [
    *CONNECTIVITY_TOOL_DEFINITIONS,
    *core_tools(),
    *service_tools("shell", shell.TOOL_DEFINITIONS),
    *service_tools("web_search", search.TOOL_DEFINITIONS),
]
ENABLED_TOOL_NAMES = {tool["name"] for tool in TOOLS if isinstance(tool.get("name"), str)}
EXTERNAL_PROXY = ExternalMCPProxy(ENABLED_TOOL_NAMES)
EXTERNAL_PROXY.load_config(enabled_mcp_servers())
atexit.register(EXTERNAL_PROXY.stop_all)


class McpError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def log(message: str) -> None:
    print(f"[{SERVER_NAME}] {message}", file=sys.stderr, flush=True)


def log_tool_call_error(name: Any, error: "McpError") -> None:
    tool_name = name if isinstance(name, str) else "<invalid>"
    log(f"tool call error: name={tool_name} code={error.code} message={error.message}")


def write_message(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def success(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def failure(request_id: Any, error: McpError) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": error.code, "message": error.message}
    if error.data is not None:
        payload["data"] = error.data
    return {"jsonrpc": "2.0", "id": request_id, "error": payload}


def require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise McpError(-32602, f"{name} must be an object")
    return value


def optional_object(value: Any, name: str) -> dict[str, Any]:
    if value is None:
        return {}
    return require_object(value, name)


def valid_request_id(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float)) and not isinstance(value, bool)


def _handle_stock_tech(symbol: str) -> dict[str, Any]:
    try:
        data = query_stock_tech(symbol)
    except StockTechError as error:
        message = str(error)
        code = -32602 if message.startswith("symbol ") else -32603
        raise McpError(code, message) from error
    except Exception as error:
        raise McpError(-32603, f"stock_tech failed: {error}") from error
    text = data.get("full_text") if isinstance(data.get("full_text"), str) else json.dumps(data, ensure_ascii=False)
    return text_result(text, data)


def _handle_skill_usage_stats(arguments: dict[str, Any]) -> dict[str, Any]:
    time_range = arguments.get("time_range", "week")
    if not isinstance(time_range, str) or time_range not in {"week", "month", "all"}:
        raise McpError(-32602, "skill_usage_stats time_range must be one of: week, month, all")

    max_age_days: int | None = {"week": 7, "month": 30, "all": None}[time_range]
    custom_max_age_days = arguments.get("max_age_days")
    if custom_max_age_days is not None:
        if not isinstance(custom_max_age_days, int) or isinstance(custom_max_age_days, bool) or custom_max_age_days < 1:
            raise McpError(-32602, "skill_usage_stats max_age_days must be a positive integer")
        max_age_days = custom_max_age_days

    top = arguments.get("top", 10)
    if not isinstance(top, int) or isinstance(top, bool) or top < 0 or top > 100:
        raise McpError(-32602, "skill_usage_stats top must be an integer between 0 and 100")
    top_count = None if top == 0 else top

    sources_value = arguments.get("sources")
    trigger_filter: set[str] | None = None
    sources: list[str] | str = "all"
    if sources_value is not None:
        if not isinstance(sources_value, list) or not all(isinstance(item, str) for item in sources_value):
            raise McpError(-32602, "skill_usage_stats sources must be an array of source names")
        normalized_sources = [item.strip().lower() for item in sources_value if item.strip()]
        invalid_sources = sorted({item for item in normalized_sources if item not in SKILL_USAGE_SOURCES})
        if invalid_sources:
            raise McpError(-32602, f"skill_usage_stats sources contains unsupported values: {', '.join(invalid_sources)}")
        if normalized_sources:
            trigger_filter = set(normalized_sources)
            sources = sorted(trigger_filter)

    home_value = arguments.get("home")
    home: Path | None = None
    if home_value is not None:
        if not isinstance(home_value, str) or not home_value.strip():
            raise McpError(-32602, "skill_usage_stats home must be a non-empty string")
        home = Path(home_value).expanduser()

    try:
        usage = scan_skill_usage(home, max_age_days, top_count, trigger_filter, include_records=True)
    except Exception as error:
        raise McpError(-32603, f"skill_usage_stats failed: {error}") from error

    structured = {
        "query": {
            "timeRange": time_range,
            "maxAgeDays": max_age_days,
            "top": top,
            "sources": sources,
            "home": str(home) if home is not None else str(Path.home()),
        },
        **usage,
    }
    return text_result(format_compact_usage(usage), structured)


def text_result(text: str, structured_content: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": False}
    if structured_content is not None:
        result["structuredContent"] = structured_content
    return result


def get_tools() -> list[dict[str, Any]]:
    return [*TOOLS, *EXTERNAL_PROXY.get_all_tools()]


def handle_initialize(params: dict[str, Any]) -> dict[str, Any]:
    client_protocol = params.get("protocolVersion")
    return {
        "protocolVersion": client_protocol or PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
    }


def handle_tools_call(params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = optional_object(params.get("arguments"), "arguments")

    if isinstance(name, str) and name in EXTERNAL_PROXY.get_all_tool_names():
        try:
            return EXTERNAL_PROXY.call_tool(name, arguments)
        except ExternalMCPError as error:
            raise McpError(error.code, error.message) from error

    if name == "ping":
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return text_result("pong " + timestamp, {"ok": True, "timestamp": timestamp})

    if name == "echo" and name in ENABLED_TOOL_NAMES:
        message = arguments.get("message")
        if not isinstance(message, str):
            raise McpError(-32602, "echo requires a string argument named 'message'")
        return text_result(message, {"message": message})

    if name == "add" and name in ENABLED_TOOL_NAMES:
        a = arguments.get("a")
        b = arguments.get("b")
        if not isinstance(a, (int, float)) or isinstance(a, bool):
            raise McpError(-32602, "add requires numeric argument 'a'")
        if not isinstance(b, (int, float)) or isinstance(b, bool):
            raise McpError(-32602, "add requires numeric argument 'b'")
        total = a + b
        return text_result(str(total), {"a": a, "b": b, "sum": total})

    if name == "stock_tech" and name in ENABLED_TOOL_NAMES:
        symbol = arguments.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            raise McpError(-32602, "stock_tech requires a string argument 'symbol'")
        return _handle_stock_tech(symbol.strip())

    if name == "skill_usage_stats" and name in ENABLED_TOOL_NAMES:
        return _handle_skill_usage_stats(arguments)

    if shell.is_tool_name(name) and name in ENABLED_TOOL_NAMES:
        try:
            return shell.call_tool(name, arguments)
        except shell.ShellToolError as error:
            raise McpError(error.code, error.message) from error

    if search.is_tool_name(name) and name in ENABLED_TOOL_NAMES:
        try:
            return asyncio.run(search.call_tool(name, arguments, service_tool_config("web_search")))
        except search.SearchToolError as error:
            raise McpError(error.code, error.message) from error

    raise McpError(-32601, f"Unknown tool: {name}")


def handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    has_id = "id" in request
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params")

    if not has_id:
        # JSON-RPC notifications do not receive a response. MCP clients commonly
        # send notifications/initialized after initialize.
        return None

    try:
        if not valid_request_id(request_id):
            return failure(None, McpError(-32600, "Invalid Request: id must be a string, number, or null"))
        if request.get("jsonrpc") != "2.0":
            raise McpError(-32600, "Invalid Request: jsonrpc must be '2.0'")
        if not isinstance(method, str):
            raise McpError(-32600, "Invalid Request: method must be a string")
        params = optional_object(params, "params")
        if method == "initialize":
            return success(request_id, handle_initialize(params))
        if method == "tools/list":
            return success(request_id, {"tools": get_tools()})
        if method == "tools/call":
            try:
                return success(request_id, handle_tools_call(params))
            except McpError as error:
                log_tool_call_error(params.get("name"), error)
                raise
        raise McpError(-32601, f"Method not found: {method}")
    except McpError as error:
        return failure(request_id, error)
    except Exception as error:  # pragma: no cover - last-resort protocol safety
        log(f"unexpected error: {error}")
        return failure(request_id, McpError(-32603, "Internal error", str(error)))


def main() -> int:
    log("started; waiting for JSON-RPC messages on stdin")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            write_message(failure(None, McpError(-32700, "Parse error", str(error))))
            continue

        try:
            request = require_object(request, "request")
        except McpError as error:
            write_message(failure(None, error))
            continue

        response = handle_request(request)
        if response is not None:
            write_message(response)
    log("stdin closed; exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
