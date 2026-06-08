# 🎫 Jira MCP Server

[![CI](https://github.com/quangtuyen1993/jira_mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/quangtuyen1993/jira_mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MCP (Model Context Protocol) server** lấy task/issue từ Jira.  
Hỗ trợ **VS Code Copilot**, **Claude Desktop** và mọi MCP client.

## 🛠️ Tools

| Tool | Mô tả |
|---|---|
| `jira_get_issue` | Lấy chi tiết 1 issue theo key (vd: `PROJ-123`) |
| `jira_search` | Tìm kiếm issue bằng JQL |
| `jira_my_tasks` | Lấy danh sách issue đang assign cho bạn |
| `jira_project_issues` | Lấy danh sách issue trong 1 project |

## 📦 Cài đặt

```bash
git clone https://github.com/quangtuyen1993/jira_mcp.git
cd jira_mcp
npm install
npm run build        # TypeScript → build/
```

## 🔧 Cấu hình Jira

Tạo file `.env` từ mẫu:

```bash
cp .env.example .env
```

Sửa `.env` với thông tin Jira của bạn:

```env
JIRA_BASE_URL=https://jira.your-company.com
JIRA_AUTH_TYPE=basic
JIRA_USERNAME=you@company.com
JIRA_PASSWORD=your-password
```

### Auth Types

| Type | Cách hoạt động | Phù hợp |
|---|---|---|
| `basic` | Gửi `Authorization: Basic` header | Hầu hết Jira |
| `session` | Login qua `/rest/auth/1/session`, dùng cookie | Jira Server/DC cũ |

## 🧪 Test kết nối

```bash
npm run test
```

Nếu hiện `✅ Tất cả test passed!` là OK.

## 🔌 Kết nối VS Code Copilot

### Bước 1: Mở file MCP config

Mở file `~/Library/Application Support/Code/User/mcp.json` (macOS) hoặc `%APPDATA%\Code\User\mcp.json` (Windows).

### Bước 2: Thêm config

```json
{
  "servers": {
    "pnj-jira": {
      "type": "stdio",
      "command": "node",
      "args": ["/đường/dẫn/đến/jira_mcp/build/index.js"],
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

> ⚠️ **Quan trọng:** VS Code dùng `"servers"` (không phải `"mcpServers"`) và cần `"type": "stdio"`.

### Bước 3: Reload VS Code

`Cmd+Shift+P` → `Reload Window`

### Bước 4: Test trong Copilot Chat

Gõ `@pnj-jira` trong chat, hoặc hỏi:

> *"Dùng tool jira_my_tasks lấy danh sách task của tôi"*

## 🔌 Kết nối Claude Desktop

Thêm vào `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/đường/dẫn/đến/jira_mcp/build/index.js"],
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

> ⚠️ Claude Desktop dùng `"mcpServers"` (khác với VS Code).

## 📋 Ví dụ sử dụng

Sau khi kết nối, hỏi Copilot:

- *"Lấy chi tiết issue PROJ-123"*
- *"Task nào đang assign cho tôi?"*
- *"Tìm tất cả issue trong project ABC có status In Progress"*

## 🏗️ Development

```bash
npm install        # Cài dependencies
npm run build      # Compile TypeScript → build/
npm run test       # Test kết nối Jira
```

## 📄 License

[MIT](LICENSE)
