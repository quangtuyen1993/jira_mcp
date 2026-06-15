import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JiraClient, JiraConfig } from "./jira-client.js";
import * as fs from "fs";
import * as path from "path";

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

  // ─── Tool: Tạo 1 hoặc nhiều issue ───────────────────────────────
  server.tool(
    "jira_create_issues",
    "Tạo một hoặc nhiều Jira task/issue mới dựa trên cấu hình đầu vào. Trả về danh sách các issue key vừa được tạo.",
    {
      issues: z.array(
        z.object({
          projectKey: z.string().describe("Mã project, ví dụ: PROJ"),
          summary: z.string().describe("Tiêu đề của task"),
          issueType: z.string().describe("Loại issue, ví dụ: Task, Bug, Story"),
          description: z.string().optional().describe("Mô tả chi tiết task"),
          priority: z.string().optional().describe("Độ ưu tiên, ví dụ: High, Medium, Low"),
          assignee: z.string().optional().describe("Username người được gán task")
        })
      ).describe("Danh sách các cấu hình issue cần tạo")
    },
    async ({ issues }) => {
      try {
        const keys = await jira.createIssues(issues);
        return {
          content: [
            {
              type: "text",
              text: `✅ Đã tạo thành công ${keys.length} issue:\n${keys.map(k => `- ${k}`).join("\n")}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Lỗi khi tạo issue:\n${error.message || error}`
            }
          ],
          isError: true
        };
      }
    }
  );

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
            const { contentType, base64 } = await jira.downloadAttachment(att.id, att.downloadUrl);
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

  // ─── Tool: Lấy các bước chuyển đổi trạng thái (transitions) ──────
  server.tool(
    "jira_get_transitions",
    "Lấy danh sách các transition (trạng thái chuyển đổi) khả dụng của một Jira issue (ví dụ: 'In Progress', 'Ready to test', 'Done Internal').",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
    },
    async ({ issueKey }) => {
      const transitions = await jira.getTransitions(issueKey);

      if (transitions.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Issue ${issueKey} không có trạng thái chuyển đổi khả dụng nào.` }],
        };
      }

      const lines: string[] = [
        `🔄 **${issueKey}** có **${transitions.length}** trạng thái chuyển đổi khả dụng:\n`,
        `| ID | Tên Transition | Trạng thái chuyển tới |`,
        `|---|---|---|`,
      ];

      for (const t of transitions) {
        lines.push(`| **${t.id}** | ${t.name} | ${t.to?.name || "N/A"} |`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  // ─── Tool: Thực hiện chuyển đổi trạng thái (transition) ──────────
  server.tool(
    "jira_transition_issue",
    "Thực hiện thay đổi trạng thái của Jira issue bằng Transition ID.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
      transitionId: z.string().describe("ID của transition cần thực hiện (lấy từ tool jira_get_transitions)"),
    },
    async ({ issueKey, transitionId }) => {
      await jira.transitionIssue(issueKey, transitionId);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Đã chuyển đổi trạng thái thành công cho issue **${issueKey}** với Transition ID **${transitionId}**.`,
          },
        ],
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
    },
    async ({ issueKey, includeComments, includeImages }) => {
      // getIssue tự động kiểm tra metadata và cache mọi thông tin offline
      const issue = await jira.getIssue(issueKey);
      const cacheDir = jira.getCacheDir(issueKey);
      
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
        const comments = await jira.getComments(issueKey, 100);
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

      // ── Phần 3: Ảnh đính kèm ─ đọc trực tiếp từ local folder ─────
      if (includeImages) {
        let saved: string[] = [];
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir);
          const imageExtensions = [".png", ".jpeg", ".jpg", ".gif", ".webp", ".svg", ".bmp"];
          saved = files
            .filter(f => imageExtensions.includes(path.extname(f).toLowerCase()))
            .map(f => path.join(cacheDir, f));
        }

        if (saved.length > 0) {
          parts.push({
            type: "text",
            text: `## 🖼️ Ảnh đính kèm (đã cache về local)\n📁 \`${cacheDir}\`\n`,
          });
          saved.forEach(f => {
            parts.push({
              type: "text",
              text: `- 📸 \`${f}\` → **Hãy dùng tool read_file để đọc ảnh này và trích xuất text bằng Vision**`,
            });
          });
        }
      }

      // ── Kết luận ────────────────────────────────────────────
      parts.push({
        type: "text",
        text: `---\n## 🤖 Yêu cầu phân tích\nDựa trên tất cả thông tin trên (description, comments, và text trong ảnh đã cache ở local), hãy:\n1. Dùng Vision đọc từng file ảnh trong thư mục cache\n2. Tóm tắt yêu cầu chính của task\n3. Liệt kê các điểm cần làm cụ thể\n4. Tổng hợp các ý kiến quan trọng từ comment\n5. Đối chiếu text trong ảnh với mô tả`,
      });

      return { content: parts };
    }
  );

  // ─── Tool: Cache task về local ──────────────────────────────────
  server.tool(
    "jira_cache_task",
    "Download tất cả ảnh & file đính kèm của một issue về thư mục local (~/.pnj-task/{issueKey}/). Dùng tool này để tạo knowledge base offline, sau đó Copilot có thể đọc file trực tiếp từ ổ đĩa.",
    {
      issueKey: z.string().describe("Mã issue Jira, ví dụ: PROJ-123"),
    },
    async ({ issueKey }) => {
      const cacheDir = jira.getCacheDir(issueKey);
      
      // getIssue sẽ tự động kiểm tra và cache toàn bộ thông tin mới nhất
      await jira.getIssue(issueKey);

      const lines: string[] = [
        `📥 **Cache task ${issueKey}** → \`${cacheDir}\`\n`,
        `✅ Đã lưu thông tin chi tiết vào \`task_info.md\``,
        `✅ Đã cập nhật chỉ mục tổng hợp tại \`~/.pnj-task/index.md\``,
      ];

      if (fs.existsSync(cacheDir)) {
        const files = fs.readdirSync(cacheDir).filter(f => f !== "task_info.json" && f !== "task_info.md");
        if (files.length > 0) {
          lines.push(`✅ Đã lưu **${files.length}** file đính kèm:`);
          files.forEach(f => lines.push(`   - \`${path.join(cacheDir, f)}\``));
        }
      }

      lines.push(`\n💡 Bạn hoặc Agent có thể đọc các file này offline bằng cách mở trực tiếp đường dẫn.`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // ─── Start server với stdio transport ───────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Jira MCP Server is ready!");
}

// ─── Format helper ─────────────────────────────────────────────────
function formatIssue(issue: any): string {
  const lines = [
    `**[${issue.key}]** ${issue.summary}`,
    `- Status: ${issue.status} | Priority: ${issue.priority} | Type: ${issue.issueType}`,
    `- Assignee: ${issue.assignee || "Unassigned"} | Project: ${issue.project}`,
    `- Created: ${issue.created} | Updated: ${issue.updated}`,
    `- Link: ${issue.url}`,
  ];

  if (issue.parent) {
    lines.push(`- Parent Task: ${issue.parent}`);
  }

  if (issue.subtasks && issue.subtasks.length > 0) {
    const subtaskKeys = issue.subtasks.map((st: any) => `${st.key} (${st.status})`).join(", ");
    lines.push(`- Subtasks: ${subtaskKeys}`);
  }

  if (issue.issueLinks && issue.issueLinks.length > 0) {
    const linkKeys = issue.issueLinks.map((l: any) => `[${l.relationship}] ${l.key} (${l.status})`).join(", ");
    lines.push(`- Related Issues: ${linkKeys}`);
  }

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
