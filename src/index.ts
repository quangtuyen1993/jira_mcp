import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JiraClient, JiraConfig } from "./jira-client.js";

// ─── Cấu hình từ biến môi trường ───────────────────────────────────
function loadConfig(): JiraConfig {
  const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
  const authType = (process.env.JIRA_AUTH_TYPE || "basic") as "basic" | "session";
  const username = process.env.JIRA_USERNAME || "";
  const password = process.env.JIRA_PASSWORD || "";
  const loginEndpoint = process.env.JIRA_LOGIN_ENDPOINT || "/rest/auth/1/session";

  if (!baseUrl) {
    console.error("[MCP] JIRA_BASE_URL is required. Set it via environment variable or .env file.");
    process.exit(1);
  }
  if (!username || !password) {
    console.error("[MCP] JIRA_USERNAME and JIRA_PASSWORD are required.");
    process.exit(1);
  }

  return { baseUrl, authType, username, password, loginEndpoint };
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const jira = new JiraClient(config);

  console.error(`[MCP] Connecting to Jira at ${config.baseUrl} (auth: ${config.authType})...`);

  try {
    await jira.authenticate();
    const user = await jira.whoami();
    console.error(`[MCP] Authenticated as: ${user}`);
  } catch (error: any) {
    console.error(`[MCP] Authentication failed: ${error.message}`);
    process.exit(1);
  }

  // ─── Tạo MCP Server ──────────────────────────────────────────────
  const server = new McpServer({
    name: "jira-mcp",
    version: "1.0.0",
    description: "MCP server to fetch tasks/issues from Jira. Supports JQL search, get issue details, my tasks, and project issues.",
  });

  // ─── Tool: Lấy chi tiết 1 issue ─────────────────────────────────
  server.tool(
    "jira_get_issue",
    "Lấy thông tin chi tiết của một Jira issue theo mã (ví dụ: PROJ-123). Trả về key, summary, status, assignee, priority, type, mô tả, và link.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
    },
    async ({ issueKey }) => {
      const issue = await jira.getIssue(issueKey);
      return {
        content: [
          {
            type: "text",
            text: formatIssue(issue),
          },
        ],
      };
    }
  );

  // ─── Tool: Tìm kiếm issue bằng JQL ──────────────────────────────
  server.tool(
    "jira_search",
    "Tìm kiếm Jira issue bằng JQL (Jira Query Language). Ví dụ: 'project = PROJ AND status = \"In Progress\"'",
    {
      jql: z.string().describe("Câu truy vấn JQL, ví dụ: project = PROJ AND status = 'In Progress'"),
      maxResults: z.number().optional().default(20).describe("Số lượng kết quả tối đa (mặc định 20)"),
    },
    async ({ jql, maxResults }) => {
      const result = await jira.searchIssues(jql, maxResults);
      return {
        content: [
          {
            type: "text",
            text: `Tìm thấy **${result.total}** issue(s) với JQL: \`${jql}\`\n\n${result.issues.map(formatIssue).join("\n---\n")}`,
          },
        ],
      };
    }
  );

  // ─── Tool: Lấy task của tôi ─────────────────────────────────────
  server.tool(
    "jira_my_tasks",
    "Lấy danh sách các issue đang được gán cho bạn (assignee = currentUser) và chưa được resolved.",
    {
      maxResults: z.number().optional().default(20).describe("Số lượng kết quả tối đa (mặc định 20)"),
    },
    async ({ maxResults }) => {
      const result = await jira.getMyIssues(maxResults);
      return {
        content: [
          {
            type: "text",
            text: `Bạn có **${result.total}** issue(s) đang open:\n\n${result.issues.map(formatIssue).join("\n---\n")}`,
          },
        ],
      };
    }
  );

  // ─── Tool: Lấy issue trong project ──────────────────────────────
  server.tool(
    "jira_project_issues",
    "Lấy danh sách issue trong một project, sắp xếp theo thời gian cập nhật gần nhất.",
    {
      projectKey: z.string().describe("Mã project Jira, ví dụ: PROJ"),
      maxResults: z.number().optional().default(20).describe("Số lượng kết quả tối đa (mặc định 20)"),
    },
    async ({ projectKey, maxResults }) => {
      const result = await jira.getProjectIssues(projectKey, maxResults);
      return {
        content: [
          {
            type: "text",
            text: `Project **${projectKey}**: **${result.total}** issue(s)\n\n${result.issues.map(formatIssue).join("\n---\n")}`,
          },
        ],
      };
    }
  );

  // ─── Tool: Lấy file đính kèm của issue ──────────────────────────
  server.tool(
    "jira_get_attachments",
    "Lấy danh sách file đính kèm (ảnh, tài liệu...) của một Jira issue. Trả về tên file, kích thước, định dạng, và link download. Với ảnh (<5MB), có thể xem trực tiếp.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
      downloadImages: z.boolean().optional().default(false).describe("Nếu true, tải nội dung ảnh về dạng base64 để xem trực tiếp (chỉ ảnh <5MB)"),
    },
    async ({ issueKey, downloadImages }) => {
      const attachments = await jira.getAttachments(issueKey);

      if (attachments.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Issue ${issueKey} không có file đính kèm.` }],
        };
      }

      const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"];
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      parts.push({
        type: "text",
        text: `📎 **${issueKey}** có **${attachments.length}** file đính kèm:\n`,
      });

      for (const att of attachments) {
        const sizeKB = (att.size / 1024).toFixed(1);
        const isImage = imageTypes.includes(att.mimeType);
        parts.push({
          type: "text",
          text: `\n- **${att.filename}** (${sizeKB} KB, ${att.mimeType})\n  📥 Tải về: ${att.downloadUrl}`,
        });

        // Nếu là ảnh nhỏ và user yêu cầu xem
        if (isImage && downloadImages && att.size < 5 * 1024 * 1024) {
          try {
            const { contentType, base64 } = await jira.downloadAttachment(att.downloadUrl);
            parts.push({ type: "text", text: `  🖼️ Xem trước:` });
            parts.push({
              type: "image",
              data: base64,
              mimeType: contentType,
            });
          } catch {
            parts.push({ type: "text", text: `  ⚠️ Không thể tải ảnh (có thể cần xác thực bổ sung)` });
          }
        }
      }

      return { content: parts };
    }
  );

  // ─── Tool: Lấy comment của issue ────────────────────────────────
  server.tool(
    "jira_get_comments",
    "Lấy danh sách comment trên một Jira issue. Hữu ích để xem lịch sử thảo luận, yêu cầu sửa, hoặc ghi chú từ team.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
      maxResults: z.number().optional().default(20).describe("Số lượng comment tối đa (mặc định 20)"),
    },
    async ({ issueKey, maxResults }) => {
      const comments = await jira.getComments(issueKey, maxResults);

      if (comments.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Issue ${issueKey} chưa có comment nào.` }],
        };
      }

      const lines: string[] = [
        `💬 **${issueKey}** có **${comments.length}** comment:\n`,
      ];

      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const body = c.body.length > 1000 ? c.body.substring(0, 1000) + "..." : c.body;
        lines.push(`---\n### ${i + 1}. ${c.author} — ${c.created}`);
        lines.push(`${body}\n`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  // ─── Tool: Phân tích tổng hợp task (issue + comment + ảnh) ──────
  server.tool(
    "jira_analyze_task",
    "Phân tích tổng hợp một Jira issue: lấy description, comments, và các ảnh đính kèm (dạng base64 để Copilot Vision đọc text trong ảnh). Dùng tool này khi cần hiểu rõ yêu cầu task từ mọi nguồn dữ liệu.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
      includeComments: z.boolean().optional().default(true).describe("Có lấy comment không (mặc định: true)"),
      includeImages: z.boolean().optional().default(true).describe("Có tải ảnh về để đọc text không (mặc định: true)"),
      maxComments: z.number().optional().default(10).describe("Số comment tối đa"),
      maxImages: z.number().optional().default(5).describe("Số ảnh tối đa (chỉ ảnh < 5MB)"),
    },
    async ({ issueKey, includeComments, includeImages, maxComments, maxImages }) => {
      const issue = await jira.getIssue(issueKey);
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      // ── Phần 1: Thông tin issue ──────────────────────────────
      const info = [
        `# 📋 Phân tích Task: ${issue.key}`,
        ``,
        `| Field | Value |`,
        `|---|---|`,
        `| **Summary** | ${issue.summary} |`,
        `| **Status** | ${issue.status} |`,
        `| **Priority** | ${issue.priority} |`,
        `| **Type** | ${issue.issueType} |`,
        `| **Assignee** | ${issue.assignee || "Unassigned"} |`,
        `| **Project** | ${issue.project} |`,
        `| **Created** | ${issue.created} |`,
        `| **Updated** | ${issue.updated} |`,
        `| **Link** | ${issue.url} |`,
        ``,
      ];
      if (issue.description) {
        info.push(`## 📝 Description`);
        info.push(issue.description);
        info.push(``);
      }
      parts.push({ type: "text", text: info.join("\n") });

      // ── Phần 2: Comments ────────────────────────────────────
      if (includeComments) {
        const comments = await jira.getComments(issueKey, maxComments);
        if (comments.length > 0) {
          const cmtLines: string[] = [`## 💬 Comments (${comments.length})`, ``];
          for (let i = 0; i < comments.length; i++) {
            const c = comments[i];
            const body = c.body.length > 1500 ? c.body.substring(0, 1500) + "..." : c.body;
            cmtLines.push(`### ${i + 1}. ${c.author} — ${c.created}`);
            cmtLines.push(body);
            cmtLines.push(``);
          }
          parts.push({ type: "text", text: cmtLines.join("\n") });
        }
      }

      // ── Phần 3: Ảnh đính kèm (cho Vision đọc text) ─────────
      if (includeImages) {
        const attachments = await jira.getAttachments(issueKey);
        const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
        const images = attachments.filter(a => imageTypes.includes(a.mimeType) && a.size < 5 * 1024 * 1024);

        if (images.length > 0) {
          parts.push({
            type: "text",
            text: `## 🖼️ Ảnh đính kèm (${Math.min(images.length, maxImages)}/${images.length} ảnh được tải về để phân tích)\n`,
          });

          let loadedCount = 0;
          for (const img of images) {
            if (loadedCount >= maxImages) break;
            try {
              const { contentType, base64 } = await jira.downloadAttachment(img.downloadUrl);
              parts.push({ type: "text", text: `### 📸 ${img.filename} (${(img.size / 1024).toFixed(1)} KB)` });
              parts.push({ type: "text", text: `🔍 *Hãy đọc text trong ảnh dưới đây và tổng hợp thông tin quan trọng:*` });
              parts.push({ type: "image", data: base64, mimeType: contentType });
              loadedCount++;
            } catch {
              parts.push({ type: "text", text: `- ⚠️ ${img.filename}: Không thể tải` });
            }
          }
        }
      }

      // ── Kết luận ────────────────────────────────────────────
      parts.push({
        type: "text",
        text: `---\n## 🤖 Yêu cầu phân tích\nDựa trên tất cả thông tin trên (description, comments, và text trong ảnh), hãy:\n1. Tóm tắt yêu cầu chính của task\n2. Liệt kê các điểm cần làm cụ thể\n3. Tổng hợp các ý kiến quan trọng từ comment\n4. Nếu có text trong ảnh, trích xuất và đối chiếu với mô tả`,
      });

      return { content: parts };
    }
  );

  // ─── Start server với stdio transport ───────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Jira MCP Server is ready!");
}

// ─── Format helper ─────────────────────────────────────────────────
function formatIssue(issue: {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  priority: string;
  issueType: string;
  created: string;
  updated: string;
  description?: string;
  project: string;
  url: string;
}): string {
  const lines = [
    `**[${issue.key}]** ${issue.summary}`,
    `- Status: ${issue.status} | Priority: ${issue.priority} | Type: ${issue.issueType}`,
    `- Assignee: ${issue.assignee || "Unassigned"} | Project: ${issue.project}`,
    `- Created: ${issue.created} | Updated: ${issue.updated}`,
    `- Link: ${issue.url}`,
  ];
  if (issue.description) {
    const desc =
      issue.description.length > 300
        ? issue.description.substring(0, 300) + "..."
        : issue.description;
    lines.push(`- Description: ${desc}`);
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
