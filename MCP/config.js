module.exports = {
  // 内置业务工具默认不暴露；这里用白名单开启需要的工具。
  tools: ['stock_tech', 'skill_usage_stats'],
  services: {
    // shell: { tools: ['get_cwd', 'list_directory', 'read_file', 'write_file', 'execute_command'] },
    // web_search: { tools: ['bing_search', 'crawl_webpage'] },
    shell: { enabled: false },
    web_search: { enabled: false },
  },
  mcpServers: {
    // 外部 MCP 服务也必须在这里显式开启，避免 presets.json 自动暴露全部预设。
    // context7: { enabled: true },
    // example: { command: 'node', args: ['server.js'], tools: ['tool_name'] },
  },
};
