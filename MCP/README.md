# Tiny Test MCP Server

一个零依赖的本地 MCP 测试服务，用来验证 agent 是否能成功连接、发现工具并调用工具。

支持两种启动方式：

- `server.py`：stdio，本地 agent 直接拉起进程使用。
- `http_server.py`：HTTP / SSE，默认监听 `127.0.0.1:8765`。

## 工具

- `ping`：返回 `pong` 和服务端时间戳。
- `echo`：回显传入的 `message`，用于验证参数传递。
- `add`：计算 `a + b`，用于验证结构化参数和返回值。
- `stock_tech`：查询A股实时行情与技术面指标（MACD/RSI/KDJ/布林带/量比），详情见下方单独章节。

## stdio 本地验证

```bash
python3 test_protocol.py
```

预期输出：

```text
ok - initialize, tools/list, and tools/call all passed
```

## Agent / MCP 客户端配置

如果你的客户端使用 JSON 配置，可以把命令配置为：

```json
{
  "mcpServers": {
    "tiny-test": {
      "command": "python3",
      "args": ["/Users/allen/Desktop/github/test-mcp-server/server.py"]
    }
  }
}
```

连接成功后，客户端应该能看到 `ping`、`echo`、`add`、`stock_tech` 四个工具。先调用 `ping`，如果返回 `pong`，说明 agent 到 MCP 服务的 stdio 链路正常。

## HTTP / SSE / Streamable HTTP 版本

启动服务：

```bash
python3 http_server.py
```

默认端口是 `8765`，默认地址是：

```text
http://127.0.0.1:8765
```

可用端点：

- `GET /health`：健康检查。
- `POST /mcp`：JSON-RPC over HTTP，用来做 Streamable HTTP 连接测试。
- `GET /sse`：SSE 事件流，会返回 `endpoint` 事件，内容为 `/mcp`。

如果要改端口：

```bash
python3 http_server.py --host 127.0.0.1 --port 9000
```

HTTP 版本本地验证：

```bash
python3 test_http_protocol.py
```

预期输出：

```text
ok - HTTP /mcp and SSE /sse tests passed
```

如果你的 agent 支持 HTTP / Streamable HTTP，可以配置 URL：

```text
http://127.0.0.1:8765/mcp
```

如果你的 agent 支持 SSE，可以配置 URL：

```text
http://127.0.0.1:8765/sse
```

> 注意：这个服务只实现了用于连接测试的最小 MCP 子集，不依赖 SDK，也不包含资源、提示词或鉴权。

## stock_tech — A股技术分析

查询A股实时行情并计算常用技术分析指标。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `symbol` | string | 是 | 股票代码，如 `002050`（三花智控）、`600519`（贵州茅台）。6/7/9 开头 = 上海交易所，其余 = 深圳交易所。 |

**数据来源：**
- **实时行情**：新浪财经 API（`hq.sinajs.cn`）
- **历史 K 线**：腾讯财经 API（`web.ifzq.gtimg.cn`），取最近 120 个交易日数据

**返回指标：**

| 指标 | 说明 |
|------|------|
| 基础行情 | 名称、代码、最新价、涨跌幅、今开、最高、最低、昨收、成交量、成交额、交易日期时间 |
| 量比 | 当日实时成交量与过去 5 日同期均量的比值 |
| MACD | DIF、DEA、MACD 柱值 + 信号判断（金叉/死叉/DIF在DEA上方/DIF在DEA下方/走平） |
| RSI | RSI6 / RSI12 / RSI24 三个周期值 |
| KDJ | K 值、D 值、J 值 + K 线与 D 线位置关系 |
| 布林带 | 上轨、中轨、下轨 + 股价位置描述（上轨附近/中轨与上轨之间/中轨附近/中轨与下轨之间/下轨附近） |
| **技术预测** | **基于上述指标的量化评分生成：短期趋势判断（看涨/偏多/方向不明/偏空/看跌）、主力信号、预估近期价格区间（布林带上下轨）** |

**返回值结构：**

工具同时返回纯文本摘要（`content[0].text`，适合直接展示）和结构化数据（`structuredContent`，适合代码消费）：

```json
{
  "content": [{
    "type": "text",
    "text": "📊 三花智控 (SZ002050)\n价格: 26.53  涨幅: 1.32%  量比: 0.88\nMACD: ...\n---\n🔮 短期预测：看涨\n📌 判断依据：MACD金叉；KDJ金叉状态；RSI6=68.32偏强\n💰 主力信号：量比>1.2，主力参与度较高\n📊 预估近期区间：支撑23.50 / 中轴26.00 / 压力28.50\n📝 说明：⚠️ 以上预测仅基于技术指标分析，不构成投资建议，不具备市场预期能力"
  }],
  "basic": {
    "name": "三花智控",
    "code": "SZ002050",
    "price": 26.53,
    "change_percent": 1.32,
    "volume_ratio": 0.88
  },
  "macd": { "dif": 0.2234, "dea": 0.1856, "macd": 0.0756, "signal": "金叉" },
  "rsi": { "rsi6": 68.32, "rsi12": 62.15, "rsi24": 55.78 },
  "kdj": { "k": 72.15, "d": 65.43, "j": 85.59, "k_above_d": true },
  "bollinger": { "upper": 28.50, "middle": 26.00, "lower": 23.50, "price_position": "中轨与上轨之间" },
  "predictions": {
    "short_term_trend": "看涨",
    "reasons": ["MACD金叉", "KDJ金叉状态", "RSI6=68.32偏强"],
    "main_force_signal": "量比>1.2，主力参与度较高",
    "price_range": { "support": 23.50, "pivot": 26.00, "resistance": 28.50 },
    "disclaimer": "⚠️ 以上预测仅基于技术指标分析，不构成投资建议，不具备市场预期能力"
  }
}
```

**调用示例（stdio）：**

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stock_tech","arguments":{"symbol":"002050"}}}
```

**无外部依赖：** 所有技术指标计算（MACD/RSI/KDJ/布林带/量比）均由服务端内嵌算法实现，无需安装 ta-lib、numpy、pandas 等第三方库。

## 手动协议测试

也可以直接运行服务并输入 JSON-RPC 行：

```bash
python3 server.py
```

输入：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0.1.0"}}}
```

服务的日志会写到 stderr，协议响应只写到 stdout，避免污染 MCP stdio 消息流。
