#!/usr/bin/env python3
"""Tiny stdio MCP server with A-stock technical analysis tool.

No third-party dependencies — uses only Python stdlib (urllib, json, re).
Data sources:
  - Sina Finance API (hq.sinajs.cn): real-time quote
  - Tencent Finance API (web.ifzq.gtimg.cn): historical daily K-lines
Technical indicators (MACD/RSI/KDJ/BOLL/量比) are calculated from K-line data.
"""

from __future__ import annotations

import atexit
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from tools import search, shell
from tools.mcp_external import ExternalMCPError, ExternalMCPProxy


SERVER_NAME = "tiny-test-mcp"
SERVER_VERSION = "0.2.0"
PROTOCOL_VERSION = "2024-11-05"
ROOT = Path(__file__).resolve().parent


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
const configPath = process.argv[1];
const config = require(configPath);
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
    servers: dict[str, Any] = {}
    for config in configs:
        mcp_servers = config.get("mcpServers")
        if isinstance(mcp_servers, dict):
            servers.update(mcp_servers)
    return servers


PRESETS = load_json_file("MCP_PRESETS_PATH", "presets.json")
JSON_CONFIG = load_json_file("MCP_CONFIG_PATH", "mcp.json")
JS_CONFIG = load_js_config_file("MCP_JS_CONFIG_PATH", "config.js")
CONFIG = merge_config(JSON_CONFIG, JS_CONFIG)


CORE_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "ping",
        "description": "返回 pong 与服务端当前时间，用于验证 MCP 服务是否可用。",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
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
                    "数据来源：新浪财经实时行情 + 腾讯财经日K线数据，"
                    "技术指标由服务端计算得出。",
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
]


def service_config(name: str) -> dict[str, Any]:
    services = CONFIG.get("services")
    if not isinstance(services, dict):
        return {}
    config = services.get(name)
    return config if isinstance(config, dict) else {}


def service_tools(name: str, definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    config = service_config(name)
    if config.get("enabled") is False:
        return []
    configured_tools = config.get("tools")
    if isinstance(configured_tools, list):
        names = {item for item in configured_tools if isinstance(item, str)}
        return [tool for tool in definitions if tool.get("name") in names]
    return list(definitions)


def service_tool_config(name: str) -> dict[str, Any]:
    config = service_config(name).get("config")
    return config if isinstance(config, dict) else {}


TOOLS: list[dict[str, Any]] = [
    *CORE_TOOL_DEFINITIONS,
    *service_tools("shell", shell.TOOL_DEFINITIONS),
    *service_tools("web_search", search.TOOL_DEFINITIONS),
]
ENABLED_TOOL_NAMES = {tool["name"] for tool in TOOLS if isinstance(tool.get("name"), str)}
EXTERNAL_PROXY = ExternalMCPProxy(ENABLED_TOOL_NAMES)
EXTERNAL_PROXY.load_config(merge_mcp_servers(PRESETS, CONFIG))
atexit.register(EXTERNAL_PROXY.stop_all)


class McpError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def log(message: str) -> None:
    print(f"[{SERVER_NAME}] {message}", file=sys.stderr, flush=True)


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


# ---------------------------------------------------------------------------
# Stock data fetching
# ---------------------------------------------------------------------------

def _detect_market(symbol: str) -> str:
    return "sh" if symbol.startswith(("6", "7", "9")) else "sz"


def _sina_realtime(symbol: str, market: str) -> dict[str, Any]:
    url = f"https://hq.sinajs.cn/list={market}{symbol}"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn",
        "Accept": "*/*",
        "Connection": "close",
    })
    resp = urllib.request.urlopen(req, timeout=15, context=ctx)
    text = resp.read().decode("GB18030")
    m = re.search(r'"([^"]+)"', text)
    if not m:
        raise ValueError("Sina API: response format unexpected")
    fields = m.group(1).split(",")
    if len(fields) < 33:
        raise ValueError(f"Sina API: expected >= 33 fields, got {len(fields)}")
    return {
        "name": fields[0],
        "open": float(fields[1]) if fields[1] else None,
        "prev_close": float(fields[2]) if fields[2] else None,
        "price": float(fields[3]) if fields[3] else None,
        "high": float(fields[4]) if fields[4] else None,
        "low": float(fields[5]) if fields[5] else None,
        "volume": int(fields[8]) if fields[8] else 0,
        "amount": float(fields[9]) if fields[9] else 0.0,
        "date": fields[30],
        "time": fields[31],
    }


def _klines(symbol: str, market: str, limit: int = 120) -> list[dict[str, Any]]:
    """Fetch daily K-lines from Tencent Finance API.  Returns newest-last."""
    code = f"{market}{symbol}"
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{limit},qfq"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=15)
    body = json.loads(resp.read().decode("utf-8"))
    klines = body.get("data", {}).get(code, {}).get("day", [])
    if not klines:
        klines = body.get("data", {}).get(code, {}).get("qfqday", [])
    out: list[dict[str, Any]] = []
    for item in klines:
        out.append({
            "date": item[0],
            "open": float(item[1]),
            "close": float(item[2]),
            "high": float(item[3]),
            "low": float(item[4]),
            "volume": float(item[5]),
        })
    return out


# ---------------------------------------------------------------------------
# Technical indicator calculators
# ---------------------------------------------------------------------------

def _ema(seq: list[float], period: int) -> list[float]:
    mul = 2.0 / (period + 1.0)
    out = [seq[0]]
    for i in range(1, len(seq)):
        out.append((seq[i] - out[-1]) * mul + out[-1])
    return out


def _macd(klines: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [k["close"] for k in klines]
    if len(closes) < 27:
        return {"dif": None, "dea": None, "macd": None, "signal": None}
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif = [e12 - e26 for e12, e26 in zip(ema12, ema26)]
    dea = _ema(dif, 9)
    bar = [2.0 * (d - d2) for d, d2 in zip(dif, dea)]
    cd, cd_1 = dif[-1], dif[-2]
    dd, dd_1 = dea[-1], dea[-2]
    threshold = max(abs(dd) * 0.005, 0.01)
    if abs(cd - dd) < threshold:
        signal = "走平"
    elif cd > dd and cd_1 <= dd_1:
        signal = "金叉"
    elif cd < dd and cd_1 >= dd_1:
        signal = "死叉"
    elif cd > dd:
        signal = "DIF在DEA上方"
    else:
        signal = "DIF在DEA下方"
    return {"dif": round(cd, 4), "dea": round(dd, 4), "macd": round(bar[-1], 4), "signal": signal}


def _rsi(klines: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [k["close"] for k in klines]
    result: dict[str, Any] = {}
    for period in (6, 12, 24):
        if len(closes) < period + 1:
            result[f"rsi{period}"] = None
            continue
        deltas = [closes[i] - closes[i - 1] for i in range(1, period + 1)]
        avg_gain = sum(d for d in deltas if d > 0) / period
        avg_loss = sum(-d for d in deltas if d < 0) / period
        for i in range(period, len(closes)):
            delta = closes[i] - closes[i - 1]
            avg_gain = (avg_gain * (period - 1) + (delta if delta > 0 else 0)) / period
            avg_loss = (avg_loss * (period - 1) + (-delta if delta < 0 else 0)) / period
        if avg_loss == 0:
            result[f"rsi{period}"] = 100.0
        else:
            result[f"rsi{period}"] = round(100.0 - 100.0 / (1.0 + avg_gain / avg_loss), 2)
    return result


def _kdj(klines: list[dict[str, Any]]) -> dict[str, Any]:
    if len(klines) < 9:
        return {"k": None, "d": None, "j": None, "k_above_d": None}
    highs = [k["high"] for k in klines]
    lows = [k["low"] for k in klines]
    closes = [k["close"] for k in klines]
    k, d = 50.0, 50.0
    for i in range(9, len(klines) + 1):
        h9 = max(highs[i - 9:i])
        l9 = min(lows[i - 9:i])
        rsv = 50.0 if h9 == l9 else (closes[i - 1] - l9) / (h9 - l9) * 100.0
        k = 2.0 / 3.0 * k + 1.0 / 3.0 * rsv
        d = 2.0 / 3.0 * d + 1.0 / 3.0 * k
    j = 3.0 * k - 2.0 * d
    return {"k": round(k, 2), "d": round(d, 2), "j": round(j, 2), "k_above_d": k > d}


def _boll(klines: list[dict[str, Any]]) -> dict[str, Any]:
    if len(klines) < 20:
        return {"upper": None, "middle": None, "lower": None, "price_position": None}
    recent = klines[-20:]
    closes = [k["close"] for k in recent]
    middle = sum(closes) / 20.0
    var = sum((c - middle) ** 2 for c in closes) / 20.0
    std = var ** 0.5
    upper = middle + 2.0 * std
    lower = middle - 2.0 * std
    price = klines[-1]["close"]
    if price >= upper * 0.99:
        pos = "上轨附近"
    elif price <= lower * 1.01:
        pos = "下轨附近"
    elif abs(price - middle) / max(upper - lower, 0.01) < 0.3:
        pos = "中轨附近"
    elif price > middle:
        pos = "中轨与上轨之间"
    else:
        pos = "中轨与下轨之间"
    return {"upper": round(upper, 2), "middle": round(middle, 2), "lower": round(lower, 2), "price_position": pos}


def _volume_ratio(current_volume: int, klines: list[dict[str, Any]]) -> float:
    # Sina volume in 股 (shares), K-line volume in 手 (1手=100股)
    recent = [k["volume"] * 100 for k in klines[-6:-1]] if len(klines) >= 6 else [k["volume"] * 100 for k in klines]
    if not recent:
        return 0.0
    avg_5d = sum(recent) / len(recent)
    return 0.0 if avg_5d == 0 else round((current_volume / 240.0) / (avg_5d / 240.0), 2)


def _generate_predictions(
    macd: dict[str, Any], rsi: dict[str, Any], kdj: dict[str, Any],
    boll: dict[str, Any], vr: float, change_pct: float | None, price: float,
) -> tuple[str, dict[str, Any]]:
    score = 0.0
    reasons: list[str] = []

    sig = macd.get("signal", "")
    if sig == "金叉":
        score += 1.5
        reasons.append("MACD金叉，短线偏多")
    elif sig == "死叉":
        score -= 1.5
        reasons.append("MACD死叉，短线偏空")
    elif sig == "DIF在DEA上方":
        score += 0.5
        reasons.append("MACD多头排列")
    elif sig == "DIF在DEA下方":
        score -= 0.5
        reasons.append("MACD空头排列")

    if kdj.get("k_above_d"):
        score += 0.5
        reasons.append("KDJ金叉状态")
    else:
        score -= 0.5
        reasons.append("KDJ死叉状态")

    r6 = rsi.get("rsi6")
    if r6 is not None:
        if r6 < 30:
            score += 1.0
            reasons.append(f"RSI6={r6}处于超卖区，有反弹需求")
        elif r6 > 70:
            score -= 1.0
            reasons.append(f"RSI6={r6}处于超买区，有回调风险")
        elif r6 > 60:
            score += 0.5
            reasons.append(f"RSI6={r6}偏强")
        elif r6 < 40:
            score -= 0.5
            reasons.append(f"RSI6={r6}偏弱")
        else:
            reasons.append(f"RSI6={r6}处于中性区间")

    pos = boll.get("price_position", "")
    if "下轨" in pos:
        score += 1.0
        reasons.append("股价在布林下轨附近，技术面存在支撑")
    elif "上轨" in pos:
        score -= 1.0
        reasons.append("股价在布林上轨附近，技术面存在压力")
    elif "下方" in pos:
        score -= 0.3
        reasons.append("股价运行在中轨下方，偏弱")
    elif "上方" in pos:
        score += 0.3
        reasons.append("股价运行在中轨上方，偏强")

    if vr > 1.5:
        score += 0.5
        reasons.append(f"量比{vr}，资金关注度高")
    elif vr < 0.5:
        score -= 0.5
        reasons.append(f"量比{vr}，量能萎缩")

    if score >= 1.5:
        direction = "看涨"
    elif score >= 0.5:
        direction = "偏多"
    elif score > -0.5:
        direction = "方向不明"
    elif score > -1.5:
        direction = "偏空"
    else:
        direction = "看跌"

    main_force_signals: list[str] = []
    if vr > 2.0:
        main_force_signals.append("量比>2，有主力资金活跃迹象")
    elif vr > 1.2:
        main_force_signals.append("量比>1.2，主力参与度较高")
    elif vr < 0.5:
        main_force_signals.append("量比<0.5，主力参与度低")

    if abs(change_pct or 0) > 3 and vr > 1.2:
        main_force_signals.append("价量配合明显，主力方向明确")

    if not main_force_signals:
        main_force_signals.append("主力信号不明显，交投平稳")

    main_force = "；".join(main_force_signals)

    up = boll.get("upper")
    mid = boll.get("middle")
    lo = boll.get("lower")
    if up is not None and lo is not None:
        range_desc = f"支撑{lo:.2f} / 中轴{mid:.2f} / 压力{up:.2f}"
        price_range = {"support": lo, "pivot": mid, "resistance": up}
    else:
        range_desc = "数据不足无法估算"
        price_range = {"support": None, "pivot": None, "resistance": None}

    disclaimer = "⚠️ 以上预测仅基于技术指标分析，不构成投资建议，不具备市场预期能力"

    lines = [
        "---",
        f"🔮 短期预测：{direction}",
        f"📌 判断依据：{'；'.join(reasons)}",
        f"💰 主力信号：{main_force}",
        f"📊 预估近期区间：{range_desc}",
        f"📝 说明：{disclaimer}",
    ]

    predictions = {
        "short_term_trend": direction,
        "reasons": reasons,
        "main_force_signal": main_force,
        "price_range": price_range,
        "disclaimer": disclaimer,
    }

    return "\n".join(lines), predictions


def _handle_stock_tech(symbol: str) -> dict[str, Any]:
    market = _detect_market(symbol)
    try:
        raw_klines = _klines(symbol, market, 120)
    except Exception as e:
        raise McpError(-32603, f"K线数据API请求失败: {e}")
    try:
        rt = _sina_realtime(symbol, market)
    except Exception as e:
        raise McpError(-32603, f"新浪实时API请求失败: {e}")
    klines = list(reversed(raw_klines))
    macd = _macd(klines)
    rsi = _rsi(klines)
    kdj = _kdj(klines)
    boll = _boll(klines)
    vr = _volume_ratio(rt["volume"], klines)
    change_pct = None
    if rt["prev_close"] and rt["price"]:
        change_pct = round((rt["price"] - rt["prev_close"]) / rt["prev_close"] * 100, 2)
    kdj_pos = "上方" if kdj.get("k_above_d") else "下方"
    lines = [
        f"📊 {rt['name']} ({market.upper()}{symbol})",
        f"价格: {rt['price']}  涨幅: {change_pct}%  量比: {vr}",
        f"MACD: DIF={macd['dif']} DEA={macd['dea']} MACD={macd['macd']}  信号: {macd['signal']}",
        f"RSI(6/12/24): {rsi.get('rsi6','-')}/{rsi.get('rsi12','-')}/{rsi.get('rsi24','-')}",
        f"KDJ: K={kdj['k']} D={kdj['d']} J={kdj['j']}  K在D{kdj_pos}",
        f"布林带: 上={boll['upper']} 中={boll['middle']} 下={boll['lower']}  股价位置: {boll['price_position']}",
    ]

    pred_text, pred_data = _generate_predictions(
        macd, rsi, kdj, boll, vr, change_pct, rt["price"],
    )
    lines.append(pred_text)

    return text_result("\n".join(lines), {
        "basic": {
            "name": rt["name"], "code": f"{market.upper()}{symbol}",
            "price": rt["price"], "change_percent": change_pct,
            "open": rt["open"], "high": rt["high"], "low": rt["low"],
            "prev_close": rt["prev_close"], "volume": rt["volume"],
            "amount": rt["amount"], "volume_ratio": vr,
            "trade_date": rt["date"], "trade_time": rt["time"],
        },
        "macd": macd, "rsi": rsi, "kdj": kdj, "bollinger": boll,
        "predictions": pred_data,
    })


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

    if name == "echo":
        message = arguments.get("message")
        if not isinstance(message, str):
            raise McpError(-32602, "echo requires a string argument named 'message'")
        return text_result(message, {"message": message})

    if name == "add":
        a = arguments.get("a")
        b = arguments.get("b")
        if not isinstance(a, (int, float)) or isinstance(a, bool):
            raise McpError(-32602, "add requires numeric argument 'a'")
        if not isinstance(b, (int, float)) or isinstance(b, bool):
            raise McpError(-32602, "add requires numeric argument 'b'")
        total = a + b
        return text_result(str(total), {"a": a, "b": b, "sum": total})

    if name == "stock_tech":
        symbol = arguments.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            raise McpError(-32602, "stock_tech requires a string argument 'symbol'")
        return _handle_stock_tech(symbol.strip())

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
            return success(request_id, handle_tools_call(params))
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
