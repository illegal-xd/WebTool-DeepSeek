#!/usr/bin/env python3
"""Tiny HTTP/SSE MCP server for agent connectivity tests.

Endpoints:
- GET  /health: simple readiness check.
- POST /mcp: stateless JSON-RPC over HTTP, suitable for Streamable HTTP tests.
- GET  /sse: one-shot Server-Sent Events stream that advertises the server.

This server intentionally uses only Python's standard library. It reuses the
same JSON-RPC handlers as server.py so stdio and HTTP expose identical tools.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from server import SERVER_NAME, SERVER_VERSION, failure, handle_request, require_object, McpError


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 1024 * 1024


def log(message: str) -> None:
    print(f"[{SERVER_NAME}-http] {message}", file=sys.stderr, flush=True)


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


class McpHttpHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"

    def log_message(self, format: str, *args: Any) -> None:
        log(format % args)

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION,
                    "transport": "http+sse",
                },
            )
            return

        if self.path == "/sse":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.write_sse("endpoint", "/mcp")
            self.write_sse(
                "server",
                json.dumps(
                    {
                        "name": SERVER_NAME,
                        "version": SERVER_VERSION,
                        "tools": ["ping", "echo", "add"],
                    },
                    separators=(",", ":"),
                ),
            )
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": self.path})

    def do_POST(self) -> None:
        if self.path != "/mcp":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": self.path})
            return

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length is required"})
            return

        try:
            length = int(content_length)
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Content-Length must be an integer"})
            return

        if length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request body too large"})
            return

        body = self.rfile.read(length)
        try:
            request = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.OK, failure(None, McpError(-32700, "Parse error", str(error))))
            return

        try:
            request = require_object(request, "request")
        except McpError as error:
            self.send_json(HTTPStatus.OK, failure(None, error))
            return

        response = handle_request(request)
        if response is None:
            self.send_empty(HTTPStatus.ACCEPTED)
            return
        self.send_json(HTTPStatus.OK, response)

    def write_sse(self, event: str, data: str) -> None:
        payload = f"event: {event}\ndata: {data}\n\n".encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the tiny test MCP HTTP/SSE server.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Host to bind, default: {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to bind, default: {DEFAULT_PORT}")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), McpHttpHandler)
    log(f"started on http://{args.host}:{args.port}; POST /mcp, GET /sse, GET /health")
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        log("received interrupt; shutting down")
    finally:
        httpd.server_close()
        time.sleep(0.05)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
