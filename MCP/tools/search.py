from __future__ import annotations

from typing import Any

import httpx

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "bing_search",
        "description": "使用 Bing 搜索网页内容",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "count": {"type": "integer", "description": "返回结果数量（默认 10，最大 50）"},
                "offset": {"type": "integer", "description": "分页偏移量（默认 0）"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "crawl_webpage",
        "description": "抓取网页并提取纯文本内容",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要抓取的网页 URL"},
                "max_length": {"type": "integer", "description": "最大返回字符数（默认 10000）"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]


class SearchToolError(Exception):
    def __init__(self, message: str, code: int = -32603) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def is_tool_name(name: Any) -> bool:
    return isinstance(name, str) and any(tool["name"] == name for tool in TOOL_DEFINITIONS)


async def call_tool(name: str, arguments: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    if name == "bing_search":
        return text_result(await bing_search(arguments, config or {}))
    if name == "crawl_webpage":
        return text_result(await crawl_webpage(arguments))
    raise SearchToolError(f"Unknown search tool: {name}", -32601)


async def bing_search(arguments: dict[str, Any], config: dict[str, Any]) -> str:
    query = require_string(arguments.get("query"), "query").strip()
    if not query:
        raise SearchToolError("query must not be empty", -32602)
    api_key = str(config.get("bing_api_key") or "").strip()
    if not api_key or api_key == "YOUR_BING_API_KEY_HERE":
        return "错误：未配置 Bing 搜索 API 密钥。请在 MCP/mcp.json 的 services.web_search.config.bing_api_key 中填入 API Key"
    count = clamp_int(arguments.get("count"), 10, 1, 50)
    offset = clamp_int(arguments.get("offset"), 0, 0, 1000)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                "https://api.bing.microsoft.com/v7.0/search",
                headers={"Ocp-Apim-Subscription-Key": api_key},
                params={"q": query, "count": count, "offset": offset, "mkt": "zh-CN"},
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as error:
        return f"搜索请求失败: {error}。请检查网络连接和 API 密钥是否正确"
    results = data.get("webPages", {}).get("value", [])
    if not results:
        return "搜索无结果。请尝试调整关键词后重试"
    lines: list[str] = []
    for index, result in enumerate(results, offset + 1):
        lines.append(f"{index}. {result.get('name', '')}")
        lines.append(f"   URL: {result.get('url', '')}")
        lines.append(f"   {result.get('snippet', '')}")
        lines.append("")
    return "\n".join(lines).strip()


async def crawl_webpage(arguments: dict[str, Any]) -> str:
    url = require_string(arguments.get("url"), "url").strip()
    if not url:
        raise SearchToolError("url must not be empty", -32602)
    if not url.startswith(("http://", "https://")):
        raise SearchToolError("url must start with http:// or https://", -32602)
    max_length = clamp_int(arguments.get("max_length"), 10_000, 1, 100_000)
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return "网页抓取失败: 未安装 beautifulsoup4。请运行 python3 -m pip install -r MCP/requirements.txt"
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; WebTool-DeepSeek-MCP/1.0)"})
            response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        lines = [line.strip() for line in soup.get_text(separator="\n", strip=True).splitlines() if line.strip()]
        text = "\n".join(lines)
        if len(text) > max_length:
            text = text[:max_length] + f"\n\n... (已截断，原文共 {len(text):,} 个字符)"
        return text
    except Exception as error:
        return f"网页抓取失败: {error}。目标页面可能无法访问或响应超时"


def require_string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise SearchToolError(f"{name} must be a string", -32602)
    return value


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        number = int(value if value is not None else default)
    except (TypeError, ValueError):
        return default
    return min(max(number, minimum), maximum)


def text_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": False}
