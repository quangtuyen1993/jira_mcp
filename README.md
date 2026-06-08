# 🎫 Jira MCP Server

[![npm version](https://img.shields.io/npm/v/jira-mcp-server)](https://www.npmjs.com/package/jira-mcp-server)
[![CI](https://github.com/user/jira-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/user/jira-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MCP (Model Context Protocol) server** for fetching tasks/issues from Jira.  
Works with **VS Code**, **Claude Desktop**, and any MCP-compatible client.

## 🛠️ Tools

| Tool | Description |
|---|---|
| `jira_get_issue` | Get issue details by key (e.g. `PROJ-123`) |
| `jira_search` | Search issues with JQL query |
| `jira_my_tasks` | Get your open assigned issues |
| `jira_project_issues` | List all issues in a project |

## 📦 Installation

### Option 1: Install from GitHub

```bash
npm install -g github:your-username/jira-mcp-server
```

### Option 2: Clone & Build

```bash
git clone https://github.com/your-username/jira-mcp-server.git
cd jira-mcp-server
npm install
npm run bundle    # → dist/jira-mcp.js (single file, no node_modules needed)
```

### Option 3: Download pre-built binary

Download `jira-mcp.js` from [GitHub Releases](https://github.com/your-username/jira-mcp-server/releases).

## 🔧 Configuration

Set these environment variables (**required**):

```bash
export JIRA_BASE_URL=https://jira.your-company.com
export JIRA_AUTH_TYPE=basic          # or "session"
export JIRA_USERNAME=you@company.com
export JIRA_PASSWORD=your-password
```

Or create a `.env` file:

```bash
cp .env.example .env
# edit .env with your Jira credentials
```

### Auth Types

| Type | How it works | Best for |
|---|---|---|
| `basic` | Sends `Authorization: Basic` header | Most Jira instances |
| `session` | Logs in via `/rest/auth/1/session`, uses cookie | Older Jira Server/DC |

## 🚀 Quick Start

```bash
# 1. Test connection
npm run test

# 2. Start MCP server (if using .env)
npm run start

# 3. Or use with MCP Inspector (web UI debugger)
npm run test:inspector
```

## 🔌 MCP Client Setup

### VS Code / Claude Desktop

Add to `mcp.json` (VS Code) or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/path/to/jira-mcp-server/dist/jira-mcp.js"],
      "env": {
        "JIRA_BASE_URL": "https://jira.your-company.com",
        "JIRA_AUTH_TYPE": "basic",
        "JIRA_USERNAME": "you@company.com",
        "JIRA_PASSWORD": "your-password"
      }
    }
  }
}
```

## 📋 Usage Examples

Once connected, ask your AI agent:

- *"Get details of issue PROJ-123"*
- *"What tasks are assigned to me?"*
- *"Find all issues in project ABC with status 'In Progress'"*
- *"Search for issues created this week"*

## 🏗️ Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript → build/
npm run bundle     # Bundle to single JS file → dist/
npm run test       # Test Jira connection
```

## 📄 License

[MIT](LICENSE)
