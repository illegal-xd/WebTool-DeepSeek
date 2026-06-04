#!/usr/bin/env python3
from __future__ import annotations

# 本脚本是 stock_tech 能力的独立单文件版本，不依赖当前项目中的 server.py 或任何第三方库。
import argparse
import csv
import io
import json
import re
import ssl
import sys
import urllib.request
from typing import Any


# 网络请求超时时间，避免外部行情接口无响应时脚本长期卡住。
REQUEST_TIMEOUT_SECONDS = 15

# 默认拉取最近约 120 个交易日 K 线，足够覆盖 MACD(26,9)、RSI24、BOLL20 等指标。
KLINE_LIMIT = 120

# 部分行情接口会校验请求头，使用常见浏览器 UA 能提高接口返回稳定性。
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# 完整文案里保留和原 stock_tech 工具一致的说明，但不会作为 predictions.disclaimer 字段输出。
DISCLAIMER_TEXT = "⚠️ 以上预测仅基于技术指标分析，不构成投资建议，不具备市场预期能力"


class StockTechError(Exception):
    # 对外统一抛出可读错误，命令行入口会把它序列化成 JSON 错误信息。
    pass


def _detect_market(symbol: str) -> str:
    # A 股常见规则：6/7/9 开头走上交所，其余按深交所处理。
    return "sh" if symbol.startswith(("6", "7", "9")) else "sz"


def _http_get_text(url: str, headers: dict[str, str], encoding: str, *, use_ssl_context: bool = False) -> str:
    # urllib 是标准库，适合让脚本复制给其他人后无需 pip install 直接运行。
    context = ssl.create_default_context() if use_ssl_context else None
    request = urllib.request.Request(url, headers=headers)
    response = urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS, context=context)
    return response.read().decode(encoding, errors="replace")


def _parse_float(value: Any) -> float | None:
    text = "" if value is None else str(value).strip()
    return float(text) if text and text not in ("-", "--") else None


def _parse_eastmoney_price(value: Any) -> float | None:
    number = _parse_float(value)
    return round(number / 100.0, 2) if number is not None else None


def _eastmoney_secid(symbol: str, market: str) -> str:
    exchange = "1" if market == "sh" else "0"
    return f"{exchange}.{symbol}"


def _eastmoney_datetime(value: Any) -> tuple[str, str]:
    text = "" if value is None else str(value)
    if len(text) < 14:
        return "", ""
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}", f"{text[8:10]}:{text[10:12]}:{text[12:14]}"


def _sina_realtime(symbol: str, market: str) -> dict[str, Any]:
    # 新浪接口提供实时行情，字段用逗号分隔，编码为 GB18030。
    url = f"https://hq.sinajs.cn/list={market}{symbol}"
    text = _http_get_text(url, {
        "User-Agent": USER_AGENT,
        "Referer": "https://finance.sina.com.cn",
        "Accept": "*/*",
        "Connection": "close",
    }, "GB18030", use_ssl_context=True)

    match = re.search(r'"([^"]+)"', text)
    if not match:
        raise ValueError("Sina API: response format unexpected")

    fields = match.group(1).split(",")
    if len(fields) < 33:
        raise ValueError(f"Sina API: expected >= 33 fields, got {len(fields)}")
    if not fields[0]:
        raise ValueError("Sina API: empty stock name, symbol may be invalid")

    return {
        "source": "sina",
        "name": fields[0],
        "open": _parse_float(fields[1]),
        "prev_close": _parse_float(fields[2]),
        "price": _parse_float(fields[3]),
        "high": _parse_float(fields[4]),
        "low": _parse_float(fields[5]),
        "volume": int(fields[8]) if fields[8] else 0,
        "amount": float(fields[9]) if fields[9] else 0.0,
        "date": fields[30],
        "time": fields[31],
    }


def _tencent_realtime(symbol: str, market: str) -> dict[str, Any]:
    # 腾讯实时行情作为新浪失败时的兜底来源，字段用 ~ 分隔。
    code = f"{market}{symbol}"
    url = f"https://qt.gtimg.cn/q={code}"
    text = _http_get_text(url, {
        "User-Agent": USER_AGENT,
        "Referer": "https://stockapp.finance.qq.com",
        "Accept": "*/*",
        "Connection": "close",
    }, "GB18030")

    match = re.search(r'"([^"]+)"', text)
    if not match:
        raise ValueError("Tencent API: response format unexpected")

    fields = match.group(1).split("~")
    if len(fields) < 38:
        raise ValueError(f"Tencent API: expected >= 38 fields, got {len(fields)}")
    if not fields[1]:
        raise ValueError("Tencent API: empty stock name, symbol may be invalid")

    # fields[35] 通常形如 price/volume_lots/amount，volume_lots 是“手”，1 手 = 100 股。
    deal = fields[35].split("/")
    volume_lots = int(float(deal[1])) if len(deal) > 1 and deal[1] else int(float(fields[36])) if fields[36] else 0
    amount = float(deal[2]) if len(deal) > 2 and deal[2] else float(fields[37]) * 10000 if fields[37] else 0.0

    timestamp = fields[30]
    trade_date = f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}" if len(timestamp) >= 8 else ""
    trade_time = f"{timestamp[8:10]}:{timestamp[10:12]}:{timestamp[12:14]}" if len(timestamp) >= 14 else ""

    return {
        "source": "tencent",
        "name": fields[1],
        "open": _parse_float(fields[5]),
        "prev_close": _parse_float(fields[4]),
        "price": _parse_float(fields[3]),
        "high": _parse_float(fields[33]),
        "low": _parse_float(fields[34]),
        "volume": volume_lots * 100,
        "amount": amount,
        "date": trade_date,
        "time": trade_time,
    }


def _eastmoney_realtime(symbol: str, market: str) -> dict[str, Any]:
    secid = _eastmoney_secid(symbol, market)
    fields = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f86"
    url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields={fields}"
    text = _http_get_text(url, {
        "User-Agent": USER_AGENT,
        "Referer": "https://quote.eastmoney.com",
        "Accept": "application/json, text/plain, */*",
        "Connection": "close",
    }, "utf-8")
    body = json.loads(text)
    data = body.get("data")
    if not isinstance(data, dict):
        raise ValueError("Eastmoney realtime API: no stock data returned")
    if not data.get("f58"):
        raise ValueError("Eastmoney realtime API: empty stock name, symbol may be invalid")

    trade_date, trade_time = _eastmoney_datetime(data.get("f86"))
    volume_lots = int(_parse_float(data.get("f47")) or 0)

    return {
        "source": "eastmoney",
        "name": data.get("f58"),
        "open": _parse_eastmoney_price(data.get("f46")),
        "prev_close": _parse_eastmoney_price(data.get("f60")),
        "price": _parse_eastmoney_price(data.get("f43")),
        "high": _parse_eastmoney_price(data.get("f44")),
        "low": _parse_eastmoney_price(data.get("f45")),
        "volume": volume_lots * 100,
        "amount": _parse_float(data.get("f48")) or 0.0,
        "date": trade_date,
        "time": trade_time,
    }


def _tencent_klines(symbol: str, market: str, limit: int = KLINE_LIMIT) -> dict[str, Any]:
    # 腾讯 K 线接口返回前复权日线；实际返回可能是 day 或 qfqday，二者都兼容。
    code = f"{market}{symbol}"
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{limit},qfq"
    text = _http_get_text(url, {"User-Agent": USER_AGENT}, "utf-8")
    body = json.loads(text)

    stock_data = body.get("data", {}).get(code, {})
    rows = stock_data.get("day", []) or stock_data.get("qfqday", [])
    if not rows:
        raise ValueError("Tencent K-line API: no daily k-line data returned")

    klines: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, list) or len(item) < 6:
            raise ValueError("Tencent K-line API: k-line row format unexpected")
        klines.append({
            "date": item[0],
            "open": float(item[1]),
            "close": float(item[2]),
            "high": float(item[3]),
            "low": float(item[4]),
            "volume": float(item[5]),
        })

    klines.sort(key=lambda row: row["date"])
    return {"source": "tencent", "adjust": "qfq", "klines": klines}


def _eastmoney_klines(symbol: str, market: str, limit: int = KLINE_LIMIT) -> dict[str, Any]:
    secid = _eastmoney_secid(symbol, market)
    fields1 = "f1,f2,f3,f4,f5,f6"
    fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={secid}&klt=101&fqt=1&lmt={limit}&end=20500101&fields1={fields1}&fields2={fields2}"
    )
    text = _http_get_text(url, {
        "User-Agent": USER_AGENT,
        "Referer": "https://quote.eastmoney.com",
        "Accept": "application/json, text/plain, */*",
        "Connection": "close",
    }, "utf-8")
    body = json.loads(text)
    rows = body.get("data", {}).get("klines", [])
    if not rows:
        raise ValueError("Eastmoney K-line API: no daily k-line data returned")

    klines: list[dict[str, Any]] = []
    for row in rows:
        fields = row.split(",")
        if len(fields) < 6:
            raise ValueError("Eastmoney K-line API: k-line row format unexpected")
        klines.append({
            "date": fields[0],
            "open": float(fields[1]),
            "close": float(fields[2]),
            "high": float(fields[3]),
            "low": float(fields[4]),
            "volume": float(fields[5]),
        })

    klines.sort(key=lambda row: row["date"])
    return {"source": "eastmoney", "adjust": "qfq", "klines": klines}


def _netease_klines(symbol: str, market: str, limit: int = KLINE_LIMIT) -> dict[str, Any]:
    prefix = "0" if market == "sh" else "1"
    code = f"{prefix}{symbol}"
    url = (
        "http://quotes.money.163.com/service/chddata.html"
        f"?code={code}&start=19900101&end=20500101&fields=TOPEN;HIGH;LOW;TCLOSE;VOTURNOVER"
    )
    text = _http_get_text(url, {
        "User-Agent": USER_AGENT,
        "Referer": "https://quotes.money.163.com",
        "Accept": "text/csv,*/*",
        "Connection": "close",
    }, "GBK")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ValueError("NetEase K-line API: no daily k-line data returned")

    klines: list[dict[str, Any]] = []
    for row in rows:
        close = _parse_float(row.get("收盘价"))
        if close is None:
            continue
        klines.append({
            "date": row.get("日期", ""),
            "open": _parse_float(row.get("开盘价")) or close,
            "close": close,
            "high": _parse_float(row.get("最高价")) or close,
            "low": _parse_float(row.get("最低价")) or close,
            "volume": (_parse_float(row.get("成交量")) or 0.0) / 100.0,
        })

    if not klines:
        raise ValueError("NetEase K-line API: no valid daily k-line rows returned")

    klines.sort(key=lambda row: row["date"])
    return {"source": "netease", "adjust": "none", "klines": klines[-limit:]}


def _query_klines(symbol: str, market: str) -> dict[str, Any]:
    errors: list[str] = []
    for source_name, loader in (
        ("腾讯", _tencent_klines),
        ("东方财富", _eastmoney_klines),
        ("网易", _netease_klines),
    ):
        try:
            return loader(symbol, market)
        except Exception as error:
            errors.append(f"{source_name}: {error}")
    raise StockTechError(f"K线数据API请求失败: {'; '.join(errors)}")


def _query_realtime(symbol: str, market: str) -> dict[str, Any]:
    errors: list[str] = []
    for source_name, loader in (
        ("新浪", _sina_realtime),
        ("腾讯", _tencent_realtime),
        ("东方财富", _eastmoney_realtime),
    ):
        try:
            return loader(symbol, market)
        except Exception as error:
            errors.append(f"{source_name}: {error}")
    raise StockTechError(f"实时行情API请求失败: {'; '.join(errors)}")


def _ema(seq: list[float], period: int) -> list[float]:
    # EMA 使用递推公式：EMA_today = (price - EMA_prev) * multiplier + EMA_prev。
    if not seq:
        return []
    multiplier = 2.0 / (period + 1.0)
    values = [seq[0]]
    for i in range(1, len(seq)):
        values.append((seq[i] - values[-1]) * multiplier + values[-1])
    return values


def _macd(klines: list[dict[str, Any]]) -> dict[str, Any]:
    # MACD 常用参数为 EMA12、EMA26、DEA9；K 线不足时返回 None。
    closes = [k["close"] for k in klines]
    if len(closes) < 27:
        return {"dif": None, "dea": None, "macd": None, "signal": None}

    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif_values = [e12 - e26 for e12, e26 in zip(ema12, ema26)]
    dea_values = _ema(dif_values, 9)
    macd_bars = [2.0 * (dif - dea) for dif, dea in zip(dif_values, dea_values)]

    dif_now, dif_prev = dif_values[-1], dif_values[-2]
    dea_now, dea_prev = dea_values[-1], dea_values[-2]
    threshold = max(abs(dea_now) * 0.005, 0.01)

    # 信号判断兼顾金叉/死叉和非交叉状态，接近 DEA 时标记为走平。
    if abs(dif_now - dea_now) < threshold:
        signal = "走平"
    elif dif_now > dea_now and dif_prev <= dea_prev:
        signal = "金叉"
    elif dif_now < dea_now and dif_prev >= dea_prev:
        signal = "死叉"
    elif dif_now > dea_now:
        signal = "DIF在DEA上方"
    else:
        signal = "DIF在DEA下方"

    return {
        "dif": round(dif_now, 4),
        "dea": round(dea_now, 4),
        "macd": round(macd_bars[-1], 4),
        "signal": signal,
    }


def _rsi(klines: list[dict[str, Any]]) -> dict[str, Any]:
    # RSI 分别计算 6/12/24 日周期，用 Wilder 平滑方式更新平均涨跌幅。
    closes = [k["close"] for k in klines]
    result: dict[str, Any] = {}

    for period in (6, 12, 24):
        if len(closes) < period + 1:
            result[f"rsi{period}"] = None
            continue

        deltas = [closes[i] - closes[i - 1] for i in range(1, period + 1)]
        avg_gain = sum(delta for delta in deltas if delta > 0) / period
        avg_loss = sum(-delta for delta in deltas if delta < 0) / period

        for i in range(period + 1, len(closes)):
            delta = closes[i] - closes[i - 1]
            avg_gain = (avg_gain * (period - 1) + max(delta, 0)) / period
            avg_loss = (avg_loss * (period - 1) + max(-delta, 0)) / period

        result[f"rsi{period}"] = 100.0 if avg_loss == 0 else round(100.0 - 100.0 / (1.0 + avg_gain / avg_loss), 2)

    return result


def _kdj(klines: list[dict[str, Any]]) -> dict[str, Any]:
    # KDJ 以 9 日 RSV 为基础递推 K/D/J，初始 K 和 D 都取 50。
    if len(klines) < 9:
        return {"k": None, "d": None, "j": None, "k_above_d": None}

    highs = [k["high"] for k in klines]
    lows = [k["low"] for k in klines]
    closes = [k["close"] for k in klines]
    k_value, d_value = 50.0, 50.0

    for i in range(9, len(klines) + 1):
        high_9 = max(highs[i - 9:i])
        low_9 = min(lows[i - 9:i])
        rsv = 50.0 if high_9 == low_9 else (closes[i - 1] - low_9) / (high_9 - low_9) * 100.0
        k_value = 2.0 / 3.0 * k_value + 1.0 / 3.0 * rsv
        d_value = 2.0 / 3.0 * d_value + 1.0 / 3.0 * k_value

    j_value = 3.0 * k_value - 2.0 * d_value
    return {
        "k": round(k_value, 2),
        "d": round(d_value, 2),
        "j": round(j_value, 2),
        "k_above_d": k_value > d_value,
    }


def _boll(klines: list[dict[str, Any]]) -> dict[str, Any]:
    # 布林带采用 20 日均线和 2 倍标准差，返回上轨/中轨/下轨及价格位置。
    if len(klines) < 20:
        return {"upper": None, "middle": None, "lower": None, "price_position": None}

    recent = klines[-20:]
    closes = [k["close"] for k in recent]
    middle = sum(closes) / 20.0
    variance = sum((close - middle) ** 2 for close in closes) / 20.0
    std = variance ** 0.5
    upper = middle + 2.0 * std
    lower = middle - 2.0 * std
    price = klines[-1]["close"]

    if price >= upper * 0.99:
        position = "上轨附近"
    elif price <= lower * 1.01:
        position = "下轨附近"
    elif abs(price - middle) / max(upper - lower, 0.01) < 0.3:
        position = "中轨附近"
    elif price > middle:
        position = "中轨与上轨之间"
    else:
        position = "中轨与下轨之间"

    return {
        "upper": round(upper, 2),
        "middle": round(middle, 2),
        "lower": round(lower, 2),
        "price_position": position,
    }


def _volume_ratio(current_volume: int, klines: list[dict[str, Any]]) -> float:
    # 实时行情成交量单位是股，K 线成交量单位通常是手；这里统一换算成股。
    historical_volumes = [k["volume"] * 100 for k in klines[-6:-1]] if len(klines) >= 6 else [k["volume"] * 100 for k in klines]
    if not historical_volumes:
        return 0.0

    avg_5d_volume = sum(historical_volumes) / len(historical_volumes)
    if avg_5d_volume == 0:
        return 0.0

    # 原 stock_tech 工具按全天 240 分钟折算，公式可约简为 current_volume / avg_5d_volume。
    return round(current_volume / avg_5d_volume, 2)


def _generate_predictions(
    macd: dict[str, Any],
    rsi: dict[str, Any],
    kdj: dict[str, Any],
    boll: dict[str, Any],
    volume_ratio: float,
    change_pct: float | None,
) -> tuple[str, dict[str, Any]]:
    # 预测逻辑是简单技术指标打分，只用于生成文案和结构化摘要。
    score = 0.0
    reasons: list[str] = []

    macd_signal = macd.get("signal")
    if macd_signal == "金叉":
        score += 1.5
        reasons.append("MACD金叉，短线偏多")
    elif macd_signal == "死叉":
        score -= 1.5
        reasons.append("MACD死叉，短线偏空")
    elif macd_signal == "DIF在DEA上方":
        score += 0.5
        reasons.append("MACD多头排列")
    elif macd_signal == "DIF在DEA下方":
        score -= 0.5
        reasons.append("MACD空头排列")

    k_above_d = kdj.get("k_above_d")
    if k_above_d is True:
        score += 0.5
        reasons.append("KDJ金叉状态")
    elif k_above_d is False:
        score -= 0.5
        reasons.append("KDJ死叉状态")

    rsi6 = rsi.get("rsi6")
    if rsi6 is not None:
        if rsi6 < 30:
            score += 1.0
            reasons.append(f"RSI6={rsi6}处于超卖区，有反弹需求")
        elif rsi6 > 70:
            score -= 1.0
            reasons.append(f"RSI6={rsi6}处于超买区，有回调风险")
        elif rsi6 > 60:
            score += 0.5
            reasons.append(f"RSI6={rsi6}偏强")
        elif rsi6 < 40:
            score -= 0.5
            reasons.append(f"RSI6={rsi6}偏弱")
        else:
            reasons.append(f"RSI6={rsi6}处于中性区间")

    price_position = boll.get("price_position") or ""
    if "下轨" in price_position:
        score += 1.0
        reasons.append("股价在布林下轨附近，技术面存在支撑")
    elif "上轨" in price_position:
        score -= 1.0
        reasons.append("股价在布林上轨附近，技术面存在压力")
    elif "中轨与下轨之间" in price_position:
        score -= 0.3
        reasons.append("股价运行在中轨下方，偏弱")
    elif "中轨与上轨之间" in price_position:
        score += 0.3
        reasons.append("股价运行在中轨上方，偏强")

    if volume_ratio > 1.5:
        score += 0.5
        reasons.append(f"量比{volume_ratio}，资金关注度高")
    elif volume_ratio < 0.5:
        score -= 0.5
        reasons.append(f"量比{volume_ratio}，量能萎缩")

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
    if volume_ratio > 2.0:
        main_force_signals.append("量比>2，有主力资金活跃迹象")
    elif volume_ratio > 1.2:
        main_force_signals.append("量比>1.2，主力参与度较高")
    elif volume_ratio < 0.5:
        main_force_signals.append("量比<0.5，主力参与度低")

    if abs(change_pct or 0) > 3 and volume_ratio > 1.2:
        main_force_signals.append("价量配合明显，主力方向明确")

    if not main_force_signals:
        main_force_signals.append("主力信号不明显，交投平稳")

    if not reasons:
        reasons.append("技术指标数据不足，暂不形成明确判断")

    main_force = "；".join(main_force_signals)
    upper = boll.get("upper")
    middle = boll.get("middle")
    lower = boll.get("lower")

    if upper is not None and middle is not None and lower is not None:
        range_desc = f"支撑{lower:.2f} / 中轴{middle:.2f} / 压力{upper:.2f}"
        price_range = {"support": lower, "pivot": middle, "resistance": upper}
    else:
        range_desc = "数据不足无法估算"
        price_range = {"support": None, "pivot": None, "resistance": None}

    text_lines = [
        "---",
        f"🔮 短期预测：{direction}",
        f"📌 判断依据：{'；'.join(reasons)}",
        f"💰 主力信号：{main_force}",
        f"📊 预估近期区间：{range_desc}",
        f"📝 说明：{DISCLAIMER_TEXT}",
    ]

    return "\n".join(text_lines), {
        "short_term_trend": direction,
        "reasons": reasons,
        "main_force_signal": main_force,
        "price_range": price_range,
    }


def _format_value(value: Any) -> Any:
    # 只用于完整文案展示：None 显示为 -，JSON 结构化字段仍保留 None。
    return "-" if value is None else value


def query_stock_tech(symbol: str) -> dict[str, Any]:
    # 对外主函数：输入 6 位 A 股代码，返回可直接 json.dumps 的字典。
    normalized_symbol = symbol.strip()
    if not normalized_symbol:
        raise StockTechError("symbol cannot be empty")
    if not re.fullmatch(r"\d{6}", normalized_symbol):
        raise StockTechError("symbol must be a 6-digit A-share stock code, e.g. 002050 or 600519")

    market = _detect_market(normalized_symbol)
    kline_data = _query_klines(normalized_symbol, market)
    klines = kline_data["klines"]
    realtime = _query_realtime(normalized_symbol, market)

    macd = _macd(klines)
    rsi = _rsi(klines)
    kdj = _kdj(klines)
    bollinger = _boll(klines)
    volume_ratio = _volume_ratio(realtime["volume"], klines)

    change_pct = None
    if realtime["prev_close"] and realtime["price"]:
        change_pct = round((realtime["price"] - realtime["prev_close"]) / realtime["prev_close"] * 100, 2)

    kdj_relation = "-"
    if kdj.get("k_above_d") is True:
        kdj_relation = "上方"
    elif kdj.get("k_above_d") is False:
        kdj_relation = "下方"

    summary_lines = [
        f"📊 {realtime['name']} ({market.upper()}{normalized_symbol})",
        f"数据源: 实时={realtime['source']}  K线={kline_data['source']}({kline_data['adjust']})",
        f"价格: {_format_value(realtime['price'])}  涨幅: {_format_value(change_pct)}%  量比: {volume_ratio}",
        f"MACD: DIF={_format_value(macd['dif'])} DEA={_format_value(macd['dea'])} MACD={_format_value(macd['macd'])}  信号: {_format_value(macd['signal'])}",
        f"RSI(6/12/24): {_format_value(rsi.get('rsi6'))}/{_format_value(rsi.get('rsi12'))}/{_format_value(rsi.get('rsi24'))}",
        f"KDJ: K={_format_value(kdj['k'])} D={_format_value(kdj['d'])} J={_format_value(kdj['j'])}  K在D{kdj_relation}",
        f"布林带: 上={_format_value(bollinger['upper'])} 中={_format_value(bollinger['middle'])} 下={_format_value(bollinger['lower'])}  股价位置: {_format_value(bollinger['price_position'])}",
    ]

    prediction_text, prediction_data = _generate_predictions(macd, rsi, kdj, bollinger, volume_ratio, change_pct)
    full_text = "\n".join([*summary_lines, prediction_text])

    return {
        "basic": {
            "name": realtime["name"],
            "code": f"{market.upper()}{normalized_symbol}",
            "source": realtime["source"],
            "price": realtime["price"],
            "change_percent": change_pct,
            "open": realtime["open"],
            "high": realtime["high"],
            "low": realtime["low"],
            "prev_close": realtime["prev_close"],
            "volume": realtime["volume"],
            "amount": realtime["amount"],
            "volume_ratio": volume_ratio,
            "trade_date": realtime["date"],
            "trade_time": realtime["time"],
        },
        "sources": {
            "realtime": realtime["source"],
            "kline": kline_data["source"],
            "kline_adjust": kline_data["adjust"],
            "technical_indicators": kline_data["source"],
        },
        "macd": macd,
        "rsi": rsi,
        "kdj": kdj,
        "bollinger": bollinger,
        "predictions": prediction_data,
        "full_text": full_text,
    }


def main() -> int:
    # 命令行入口：成功时 JSON 输出到 stdout，失败时 JSON 错误输出到 stderr。
    parser = argparse.ArgumentParser(description="查询A股实时行情与技术指标，输出 JSON 数据。")
    parser.add_argument("symbol", help="股票代码，如 002050、600519、000001、300750")
    args = parser.parse_args()

    try:
        data = query_stock_tech(args.symbol)
    except StockTechError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
