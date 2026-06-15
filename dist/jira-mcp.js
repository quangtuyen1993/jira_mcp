#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/jira-client.ts
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
var JiraClient = class {
  client;
  config;
  sessionCookie = null;
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 15e3,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });
  }
  /**
   * Xác thực với Jira. Với basic auth thì chỉ cần set header,
   * với session auth thì gọi API login để lấy JSESSIONID.
   */
  async authenticate() {
    if (this.config.authType === "basic") {
      const token = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString("base64");
      this.client.defaults.headers.common["Authorization"] = `Basic ${token}`;
      console.error("[JiraClient] Using Basic Auth");
    } else {
      try {
        const response = await this.client.post(
          this.config.loginEndpoint,
          {
            username: this.config.username,
            password: this.config.password
          },
          { withCredentials: true }
        );
        const setCookie = response.headers["set-cookie"];
        if (setCookie) {
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const cookie of cookies) {
            const match = cookie.match(/JSESSIONID=([^;]+)/);
            if (match) {
              this.sessionCookie = `JSESSIONID=${match[1]}`;
              break;
            }
          }
        }
        if (this.sessionCookie) {
          this.client.defaults.headers.common["Cookie"] = this.sessionCookie;
          console.error("[JiraClient] Session authenticated successfully");
        } else {
          const sessionData = response.data?.session;
          if (sessionData?.value) {
            this.sessionCookie = `${sessionData.name}=${sessionData.value}`;
            this.client.defaults.headers.common["Cookie"] = this.sessionCookie;
            console.error("[JiraClient] Session from response body");
          } else {
            throw new Error(
              "Could not obtain session cookie. Response: " + JSON.stringify(response.data).substring(0, 200)
            );
          }
        }
      } catch (error) {
        throw new Error(
          `Session login failed: ${error.message}. Endpoint: ${this.config.loginEndpoint}`
        );
      }
    }
  }
  /**
   * Lấy chi tiết một issue theo key (vd: PROJ-123)
   */
  async getIssue(issueKey) {
    try {
      const response = await this.client.get(`/rest/api/2/issue/${issueKey}`);
      const issue = this.mapIssue(response.data);
      await this.autoCacheIssue(issue);
      return issue;
    } catch (error) {
      throw handleAxiosError(error, `Get issue ${issueKey}`);
    }
  }
  /**
   * Tìm kiếm issue bằng JQL
   */
  async searchIssues(jql, maxResults = 20) {
    try {
      const response = await this.client.post("/rest/api/2/search", {
        jql,
        maxResults,
        fields: [
          "summary",
          "status",
          "assignee",
          "priority",
          "issuetype",
          "created",
          "updated",
          "description",
          "project",
          "issuelinks",
          "subtasks",
          "parent"
        ]
      });
      return {
        total: response.data.total,
        issues: response.data.issues.map((i) => this.mapIssue(i))
      };
    } catch (error) {
      throw handleAxiosError(error, `JQL search "${jql}"`);
    }
  }
  /**
   * Lấy danh sách issue được assign cho user hiện tại
   */
  async getMyIssues(maxResults = 20) {
    return this.searchIssues(
      "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
      maxResults
    );
  }
  /**
   * Lấy danh sách issue trong một project
   */
  async getProjectIssues(projectKey, maxResults = 20) {
    return this.searchIssues(
      `project = ${projectKey} ORDER BY updated DESC`,
      maxResults
    );
  }
  /**
   * Kiểm tra kết nối – lấy thông tin user hiện tại
   */
  async whoami() {
    try {
      const response = await this.client.get("/rest/api/2/myself");
      return `${response.data.displayName} (${response.data.emailAddress || response.data.name})`;
    } catch (error) {
      throw handleAxiosError(error, "Whoami check");
    }
  }
  /**
   * Lấy danh sách file đính kèm của một issue
   */
  async getAttachments(issueKey) {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}?fields=attachment`
      );
      const attachments = response.data?.fields?.attachment || [];
      return attachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        size: att.size,
        mimeType: att.mimeType || "",
        created: att.created || "",
        author: att.author?.displayName || "Unknown",
        downloadUrl: att.content || `${this.config.baseUrl}/secure/attachment/${att.id}/${att.filename}`,
        thumbnailUrl: att.thumbnail || void 0
      }));
    } catch (error) {
      throw handleAxiosError(error, `Get attachments for issue ${issueKey}`);
    }
  }
  /**
   * Lấy danh sách comment của một issue
   */
  async getComments(issueKey, maxResults = 50) {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}/comment`,
        { params: { maxResults } }
      );
      const comments = response.data?.comments || [];
      return comments.map((c) => ({
        id: c.id,
        body: c.body || "",
        author: c.author?.displayName || "Unknown",
        created: c.created || "",
        updated: c.updated || ""
      }));
    } catch (error) {
      throw handleAxiosError(error, `Get comments for issue ${issueKey}`);
    }
  }
  /**
   * Lấy danh sách các transitions (trạng thái chuyển đổi) khả dụng của issue
   */
  async getTransitions(issueKey) {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}/transitions`
      );
      return response.data?.transitions || [];
    } catch (error) {
      throw handleAxiosError(error, `Get transitions for issue ${issueKey}`);
    }
  }
  /**
   * Thực hiện chuyển đổi trạng thái (transition) của issue
   */
  async transitionIssue(issueKey, transitionId) {
    try {
      await this.client.post(
        `/rest/api/2/issue/${issueKey}/transitions`,
        {
          transition: {
            id: transitionId
          }
        }
      );
    } catch (error) {
      throw handleAxiosError(error, `Transition issue ${issueKey} with ID ${transitionId}`);
    }
  }
  /**
   * Download nội dung attachment dạng base64.
   * Jira PNJ dùng URL web /secure/attachment/{id}/{filename}, nên ưu tiên cách này.
   */
  async downloadAttachment(attachmentId, url) {
    console.error(`[JiraClient] Downloading attachment ${attachmentId}: ${url}`);
    try {
      const response = await this.client.get(url, {
        responseType: "arraybuffer",
        timeout: 3e4
      });
      const contentType = String(response.headers["content-type"] || "application/octet-stream");
      const base64 = Buffer.from(response.data).toString("base64");
      console.error(`[JiraClient] Downloaded ${attachmentId}: ${(base64.length / 1024).toFixed(1)} KB`);
      return { contentType, base64 };
    } catch (err) {
      console.error(`[JiraClient] Web URL failed: ${err.message}, trying REST API...`);
      const apiUrl = `/rest/api/2/attachment/content/${attachmentId}`;
      const response = await this.client.get(apiUrl, {
        responseType: "arraybuffer",
        timeout: 3e4
      });
      const contentType = String(response.headers["content-type"] || "application/octet-stream");
      const base64 = Buffer.from(response.data).toString("base64");
      return { contentType, base64 };
    }
  }
  /**
   * Download tất cả attachments của 1 issue về thư mục local cache.
   * Thư mục: ~/.pnj-task/{issueKey}/
   */
  getCacheDir(issueKey) {
    return path.join(os.homedir(), ".pnj-task", issueKey);
  }
  async downloadAttachmentsToCache(issueKey, options) {
    const atts = await this.getAttachments(issueKey);
    const cacheDir = this.getCacheDir(issueKey);
    fs.mkdirSync(cacheDir, { recursive: true });
    const saved = [];
    const errors = [];
    const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"];
    let filteredAtts = atts;
    if (options?.onlyImages) {
      filteredAtts = filteredAtts.filter((att) => imageTypes.includes(att.mimeType));
    }
    if (options?.maxSize) {
      filteredAtts = filteredAtts.filter((att) => att.size <= options.maxSize);
    }
    if (options?.maxFiles) {
      filteredAtts = filteredAtts.slice(0, options.maxFiles);
    }
    for (const att of filteredAtts) {
      const filePath = path.join(cacheDir, att.filename);
      try {
        console.error(`[JiraClient] Saving ${att.filename} to ${filePath}...`);
        const { base64 } = await this.downloadAttachment(att.id, att.downloadUrl);
        const buffer = Buffer.from(base64, "base64");
        fs.writeFileSync(filePath, buffer);
        saved.push(filePath);
        console.error(`[JiraClient] Saved: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
      } catch (err) {
        errors.push(`${att.filename}: ${err.message}`);
        console.error(`[JiraClient] Failed to save ${att.filename}: ${err.message}`);
      }
    }
    return { saved, errors };
  }
  async writeTaskMetadataToCache(issue, comments, cacheDir) {
    const filePath = path.join(cacheDir, "task_info.md");
    console.error(`[JiraClient] Writing task metadata to ${filePath}...`);
    const markdown = [
      `# [${issue.key}] ${issue.summary}`,
      ``,
      `| Thu\u1ED9c t\xEDnh | Gi\xE1 tr\u1ECB |`,
      `|---|---|`,
      `| **Tr\u1EA1ng th\xE1i (Status)** | ${issue.status} |`,
      `| **Ng\u01B0\u1EDDi \u0111\u01B0\u1EE3c giao (Assignee)** | ${issue.assignee || "Ch\u01B0a giao (Unassigned)"} |`,
      `| **M\u1EE9c \u0111\u1ED9 \u01B0u ti\xEAn (Priority)** | ${issue.priority} |`,
      `| **Lo\u1EA1i y\xEAu c\u1EA7u (Type)** | ${issue.issueType} |`,
      `| **D\u1EF1 \xE1n (Project)** | ${issue.project} |`,
      `| **Ng\xE0y t\u1EA1o (Created)** | ${issue.created} |`,
      `| **C\u1EADp nh\u1EADt (Updated)** | ${issue.updated} |`,
      `| **\u0110\u01B0\u1EDDng d\u1EABn g\u1ED1c (Jira Link)** | [Browse Issue](${issue.url}) |`,
      ``
    ];
    if (issue.parent) {
      markdown.push(`- \u{1F53A} **Task cha (Parent)**: [${issue.parent}](../${issue.parent}/task_info.md)`);
    }
    if (issue.subtasks && issue.subtasks.length > 0) {
      markdown.push(`## \u{1F53D} Task con (Subtasks)`);
      issue.subtasks.forEach((st) => {
        markdown.push(`- [${st.key}](../${st.key}/task_info.md) - ${st.summary} (*${st.status}*)`);
      });
      markdown.push(``);
    }
    if (issue.issueLinks && issue.issueLinks.length > 0) {
      markdown.push(`## \u{1F517} Task li\xEAn quan (Relationships)`);
      issue.issueLinks.forEach((link) => {
        markdown.push(`- **${link.relationship}**: [${link.key}](../${link.key}/task_info.md) - ${link.summary} (*${link.status}*)`);
      });
      markdown.push(``);
    }
    if (issue.description) {
      markdown.push(`## \u{1F4DD} M\xF4 t\u1EA3 chi ti\u1EBFt (Description)`);
      markdown.push(issue.description);
      markdown.push(``);
    }
    if (comments.length > 0) {
      markdown.push(`## \u{1F4AC} B\xECnh lu\u1EADn (Comments - ${comments.length})`);
      comments.forEach((c, index) => {
        markdown.push(`### ${index + 1}. ${c.author} \u2014 ${c.created}`);
        markdown.push(c.body);
        markdown.push(``);
      });
    }
    fs.writeFileSync(filePath, markdown.join("\n"), "utf-8");
    const jsonPath = path.join(cacheDir, "task_info.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ key: issue.key, updated: issue.updated }, null, 2),
      "utf-8"
    );
  }
  isCacheUpToDate(issueKey, updatedTime) {
    const jsonPath = path.join(this.getCacheDir(issueKey), "task_info.json");
    if (!fs.existsSync(jsonPath)) {
      return false;
    }
    try {
      const content = fs.readFileSync(jsonPath, "utf-8");
      const metadata = JSON.parse(content);
      return metadata.updated === updatedTime;
    } catch {
      return false;
    }
  }
  async autoCacheIssue(issue) {
    const cacheDir = this.getCacheDir(issue.key);
    if (this.isCacheUpToDate(issue.key, issue.updated)) {
      console.error(`[JiraClient] Local cache for ${issue.key} is already up to date.`);
      return;
    }
    console.error(`[JiraClient] Cache for ${issue.key} is outdated or missing. Auto-caching in progress...`);
    try {
      const comments = await this.getComments(issue.key, 100);
      await this.downloadAttachmentsToCache(issue.key);
      await this.writeTaskMetadataToCache(issue, comments, cacheDir);
      await this.updateMasterIndex(issue);
      console.error(`[JiraClient] Auto-cached ${issue.key} successfully.`);
    } catch (err) {
      console.error(`[JiraClient] Auto-caching failed for ${issue.key}: ${err.message}`);
    }
  }
  async updateMasterIndex(issue) {
    const baseDir = path.join(os.homedir(), ".pnj-task");
    fs.mkdirSync(baseDir, { recursive: true });
    const indexPath = path.join(baseDir, "index.md");
    console.error(`[JiraClient] Updating master index at ${indexPath}...`);
    let existingContent = "";
    if (fs.existsSync(indexPath)) {
      existingContent = fs.readFileSync(indexPath, "utf-8");
    } else {
      existingContent = `# \u{1F4C2} Danh s\xE1ch Jira Task Cache Local

| Task | T\xF3m t\u1EAFt | Tr\u1EA1ng th\xE1i | C\u1EADp nh\u1EADt | Chi ti\u1EBFt offline |
|---|---|---|---|---|
`;
    }
    const lines = existingContent.split("\n");
    const taskRowPattern = new RegExp(`^\\|\\s*\\[?${issue.key}\\]?`);
    const newRow = `| [${issue.key}](${issue.url}) | ${issue.summary} | ${issue.status} | ${issue.updated} | [Xem offline](./${issue.key}/task_info.md) |`;
    let foundIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (taskRowPattern.test(lines[i])) {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex !== -1) {
      lines[foundIndex] = newRow;
    } else {
      let insertIndex = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("|")) {
          insertIndex = i + 1;
          break;
        }
      }
      lines.splice(insertIndex, 0, newRow);
    }
    fs.writeFileSync(indexPath, lines.join("\n"), "utf-8");
  }
  /**
   * Map raw API response → JiraIssue
   */
  mapIssue(data) {
    const fields = data.fields || data;
    const subtasks = fields.subtasks?.map((st) => ({
      key: st.key,
      summary: st.fields?.summary || "",
      status: st.fields?.status?.name || ""
    })) || [];
    const parent = fields.parent?.key;
    const issueLinks = (fields.issuelinks || []).map((link) => {
      const isOutward = !!link.outwardIssue;
      const linkedIssue = link.outwardIssue || link.inwardIssue;
      const relationship = isOutward ? link.type?.outward || link.type?.name : link.type?.inward || link.type?.name;
      return {
        key: linkedIssue?.key || "",
        summary: linkedIssue?.fields?.summary || "",
        relationship: relationship || "",
        status: linkedIssue?.fields?.status?.name || ""
      };
    }).filter((link) => !!link.key);
    return {
      key: data.key || fields.key,
      summary: fields.summary || "",
      status: fields.status?.name || "",
      assignee: fields.assignee?.displayName || null,
      priority: fields.priority?.name || "",
      issueType: fields.issuetype?.name || "",
      created: fields.created || "",
      updated: fields.updated || "",
      description: fields.description ? typeof fields.description === "string" ? fields.description : JSON.stringify(fields.description) : void 0,
      project: fields.project?.key || "",
      url: `${this.config.baseUrl}/browse/${data.key || fields.key}`,
      issueLinks,
      subtasks,
      parent
    };
  }
};
function handleAxiosError(error, action) {
  if (error.response) {
    const data = error.response.data;
    let details = "";
    if (data) {
      if (Array.isArray(data.errorMessages) && data.errorMessages.length > 0) {
        details = data.errorMessages.join(", ");
      } else if (data.errors && typeof data.errors === "object") {
        details = Object.entries(data.errors).map(([key, val]) => `${key}: ${val}`).join("; ");
      } else if (typeof data === "string") {
        details = data;
      } else {
        details = JSON.stringify(data);
      }
    }
    return new Error(`${action} failed (${error.response.status}): ${details || error.message}`);
  }
  return new Error(`${action} failed: ${error.message}`);
}

// src/index.ts
import * as fs2 from "fs";
import * as path2 from "path";
function loadConfig() {
  const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
  const authType = process.env.JIRA_AUTH_TYPE || "basic";
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
async function main() {
  const config = loadConfig();
  const jira = new JiraClient(config);
  console.error(`[MCP] Connecting to Jira at ${config.baseUrl} (auth: ${config.authType})...`);
  try {
    await jira.authenticate();
    const user = await jira.whoami();
    console.error(`[MCP] Authenticated as: ${user}`);
  } catch (error) {
    console.error(`[MCP] Authentication failed: ${error.message}`);
    process.exit(1);
  }
  const server = new McpServer({
    name: "jira-mcp",
    version: "1.0.0",
    description: "MCP server to fetch tasks/issues from Jira. Supports JQL search, get issue details, my tasks, and project issues."
  });
  server.tool(
    "jira_get_issue",
    "L\u1EA5y th\xF4ng tin chi ti\u1EBFt c\u1EE7a m\u1ED9t Jira issue theo m\xE3 (v\xED d\u1EE5: PROJ-123). Tr\u1EA3 v\u1EC1 key, summary, status, assignee, priority, type, m\xF4 t\u1EA3, v\xE0 link.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123")
    },
    async ({ issueKey }) => {
      const issue = await jira.getIssue(issueKey);
      return {
        content: [
          {
            type: "text",
            text: formatIssue(issue)
          }
        ]
      };
    }
  );
  server.tool(
    "jira_search",
    `T\xECm ki\u1EBFm Jira issue b\u1EB1ng JQL (Jira Query Language). V\xED d\u1EE5: 'project = PROJ AND status = "In Progress"'`,
    {
      jql: z.string().describe("C\xE2u truy v\u1EA5n JQL, v\xED d\u1EE5: project = PROJ AND status = 'In Progress'"),
      maxResults: z.number().optional().default(20).describe("S\u1ED1 l\u01B0\u1EE3ng k\u1EBFt qu\u1EA3 t\u1ED1i \u0111a (m\u1EB7c \u0111\u1ECBnh 20)")
    },
    async ({ jql, maxResults }) => {
      const result = await jira.searchIssues(jql, maxResults);
      return {
        content: [
          {
            type: "text",
            text: `T\xECm th\u1EA5y **${result.total}** issue(s) v\u1EDBi JQL: \`${jql}\`

${result.issues.map(formatIssue).join("\n---\n")}`
          }
        ]
      };
    }
  );
  server.tool(
    "jira_my_tasks",
    "L\u1EA5y danh s\xE1ch c\xE1c issue \u0111ang \u0111\u01B0\u1EE3c g\xE1n cho b\u1EA1n (assignee = currentUser) v\xE0 ch\u01B0a \u0111\u01B0\u1EE3c resolved.",
    {
      maxResults: z.number().optional().default(20).describe("S\u1ED1 l\u01B0\u1EE3ng k\u1EBFt qu\u1EA3 t\u1ED1i \u0111a (m\u1EB7c \u0111\u1ECBnh 20)")
    },
    async ({ maxResults }) => {
      const result = await jira.getMyIssues(maxResults);
      return {
        content: [
          {
            type: "text",
            text: `B\u1EA1n c\xF3 **${result.total}** issue(s) \u0111ang open:

${result.issues.map(formatIssue).join("\n---\n")}`
          }
        ]
      };
    }
  );
  server.tool(
    "jira_project_issues",
    "L\u1EA5y danh s\xE1ch issue trong m\u1ED9t project, s\u1EAFp x\u1EBFp theo th\u1EDDi gian c\u1EADp nh\u1EADt g\u1EA7n nh\u1EA5t.",
    {
      projectKey: z.string().describe("M\xE3 project Jira, v\xED d\u1EE5: PROJ"),
      maxResults: z.number().optional().default(20).describe("S\u1ED1 l\u01B0\u1EE3ng k\u1EBFt qu\u1EA3 t\u1ED1i \u0111a (m\u1EB7c \u0111\u1ECBnh 20)")
    },
    async ({ projectKey, maxResults }) => {
      const result = await jira.getProjectIssues(projectKey, maxResults);
      return {
        content: [
          {
            type: "text",
            text: `Project **${projectKey}**: **${result.total}** issue(s)

${result.issues.map(formatIssue).join("\n---\n")}`
          }
        ]
      };
    }
  );
  server.tool(
    "jira_get_attachments",
    "L\u1EA5y danh s\xE1ch file \u0111\xEDnh k\xE8m (\u1EA3nh, t\xE0i li\u1EC7u...) c\u1EE7a m\u1ED9t Jira issue. Tr\u1EA3 v\u1EC1 t\xEAn file, k\xEDch th\u01B0\u1EDBc, \u0111\u1ECBnh d\u1EA1ng, v\xE0 link download. V\u1EDBi \u1EA3nh (<5MB), c\xF3 th\u1EC3 xem tr\u1EF1c ti\u1EBFp.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123"),
      downloadImages: z.boolean().optional().default(false).describe("N\u1EBFu true, t\u1EA3i n\u1ED9i dung \u1EA3nh v\u1EC1 d\u1EA1ng base64 \u0111\u1EC3 xem tr\u1EF1c ti\u1EBFp (ch\u1EC9 \u1EA3nh <5MB)")
    },
    async ({ issueKey, downloadImages }) => {
      const attachments = await jira.getAttachments(issueKey);
      if (attachments.length === 0) {
        return {
          content: [{ type: "text", text: `Issue ${issueKey} kh\xF4ng c\xF3 file \u0111\xEDnh k\xE8m.` }]
        };
      }
      const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"];
      const parts = [];
      parts.push({
        type: "text",
        text: `\u{1F4CE} **${issueKey}** c\xF3 **${attachments.length}** file \u0111\xEDnh k\xE8m:
`
      });
      for (const att of attachments) {
        const sizeKB = (att.size / 1024).toFixed(1);
        const isImage = imageTypes.includes(att.mimeType);
        parts.push({
          type: "text",
          text: `
- **${att.filename}** (${sizeKB} KB, ${att.mimeType})
  \u{1F4E5} T\u1EA3i v\u1EC1: ${att.downloadUrl}`
        });
        if (isImage && downloadImages && att.size < 5 * 1024 * 1024) {
          try {
            const { contentType, base64 } = await jira.downloadAttachment(att.id, att.downloadUrl);
            parts.push({ type: "text", text: `  \u{1F5BC}\uFE0F Xem tr\u01B0\u1EDBc:` });
            parts.push({
              type: "image",
              data: base64,
              mimeType: contentType
            });
          } catch {
            parts.push({ type: "text", text: `  \u26A0\uFE0F Kh\xF4ng th\u1EC3 t\u1EA3i \u1EA3nh (c\xF3 th\u1EC3 c\u1EA7n x\xE1c th\u1EF1c b\u1ED5 sung)` });
          }
        }
      }
      return { content: parts };
    }
  );
  server.tool(
    "jira_get_comments",
    "L\u1EA5y danh s\xE1ch comment tr\xEAn m\u1ED9t Jira issue. H\u1EEFu \xEDch \u0111\u1EC3 xem l\u1ECBch s\u1EED th\u1EA3o lu\u1EADn, y\xEAu c\u1EA7u s\u1EEDa, ho\u1EB7c ghi ch\xFA t\u1EEB team.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123"),
      maxResults: z.number().optional().default(20).describe("S\u1ED1 l\u01B0\u1EE3ng comment t\u1ED1i \u0111a (m\u1EB7c \u0111\u1ECBnh 20)")
    },
    async ({ issueKey, maxResults }) => {
      const comments = await jira.getComments(issueKey, maxResults);
      if (comments.length === 0) {
        return {
          content: [{ type: "text", text: `Issue ${issueKey} ch\u01B0a c\xF3 comment n\xE0o.` }]
        };
      }
      const lines = [
        `\u{1F4AC} **${issueKey}** c\xF3 **${comments.length}** comment:
`
      ];
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const body = c.body.length > 1e3 ? c.body.substring(0, 1e3) + "..." : c.body;
        lines.push(`---
### ${i + 1}. ${c.author} \u2014 ${c.created}`);
        lines.push(`${body}
`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
  server.tool(
    "jira_get_transitions",
    "L\u1EA5y danh s\xE1ch c\xE1c transition (tr\u1EA1ng th\xE1i chuy\u1EC3n \u0111\u1ED5i) kh\u1EA3 d\u1EE5ng c\u1EE7a m\u1ED9t Jira issue (v\xED d\u1EE5: 'In Progress', 'Ready to test', 'Done Internal').",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123")
    },
    async ({ issueKey }) => {
      const transitions = await jira.getTransitions(issueKey);
      if (transitions.length === 0) {
        return {
          content: [{ type: "text", text: `Issue ${issueKey} kh\xF4ng c\xF3 tr\u1EA1ng th\xE1i chuy\u1EC3n \u0111\u1ED5i kh\u1EA3 d\u1EE5ng n\xE0o.` }]
        };
      }
      const lines = [
        `\u{1F504} **${issueKey}** c\xF3 **${transitions.length}** tr\u1EA1ng th\xE1i chuy\u1EC3n \u0111\u1ED5i kh\u1EA3 d\u1EE5ng:
`,
        `| ID | T\xEAn Transition | Tr\u1EA1ng th\xE1i chuy\u1EC3n t\u1EDBi |`,
        `|---|---|---|`
      ];
      for (const t of transitions) {
        lines.push(`| **${t.id}** | ${t.name} | ${t.to?.name || "N/A"} |`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
  server.tool(
    "jira_transition_issue",
    "Th\u1EF1c hi\u1EC7n thay \u0111\u1ED5i tr\u1EA1ng th\xE1i c\u1EE7a Jira issue b\u1EB1ng Transition ID.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123"),
      transitionId: z.string().describe("ID c\u1EE7a transition c\u1EA7n th\u1EF1c hi\u1EC7n (l\u1EA5y t\u1EEB tool jira_get_transitions)")
    },
    async ({ issueKey, transitionId }) => {
      await jira.transitionIssue(issueKey, transitionId);
      return {
        content: [
          {
            type: "text",
            text: `\u2705 \u0110\xE3 chuy\u1EC3n \u0111\u1ED5i tr\u1EA1ng th\xE1i th\xE0nh c\xF4ng cho issue **${issueKey}** v\u1EDBi Transition ID **${transitionId}**.`
          }
        ]
      };
    }
  );
  server.tool(
    "jira_analyze_task",
    "Ph\xE2n t\xEDch t\u1ED5ng h\u1EE3p m\u1ED9t Jira issue: l\u1EA5y description, comments, v\xE0 c\xE1c \u1EA3nh \u0111\xEDnh k\xE8m (d\u1EA1ng base64 \u0111\u1EC3 Copilot Vision \u0111\u1ECDc text trong \u1EA3nh). D\xF9ng tool n\xE0y khi c\u1EA7n hi\u1EC3u r\xF5 y\xEAu c\u1EA7u task t\u1EEB m\u1ECDi ngu\u1ED3n d\u1EEF li\u1EC7u.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123"),
      includeComments: z.boolean().optional().default(true).describe("C\xF3 l\u1EA5y comment kh\xF4ng (m\u1EB7c \u0111\u1ECBnh: true)"),
      includeImages: z.boolean().optional().default(true).describe("C\xF3 t\u1EA3i \u1EA3nh v\u1EC1 \u0111\u1EC3 \u0111\u1ECDc text kh\xF4ng (m\u1EB7c \u0111\u1ECBnh: true)")
    },
    async ({ issueKey, includeComments, includeImages }) => {
      const issue = await jira.getIssue(issueKey);
      const cacheDir = jira.getCacheDir(issueKey);
      const parts = [];
      const info = [
        `# \u{1F4CB} Ph\xE2n t\xEDch Task: ${issue.key}`,
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
        ``
      ];
      if (issue.description) {
        info.push(`## \u{1F4DD} Description`);
        info.push(issue.description);
        info.push(``);
      }
      parts.push({ type: "text", text: info.join("\n") });
      if (includeComments) {
        const comments = await jira.getComments(issueKey, 100);
        if (comments.length > 0) {
          const cmtLines = [`## \u{1F4AC} Comments (${comments.length})`, ``];
          for (let i = 0; i < comments.length; i++) {
            const c = comments[i];
            const body = c.body.length > 1500 ? c.body.substring(0, 1500) + "..." : c.body;
            cmtLines.push(`### ${i + 1}. ${c.author} \u2014 ${c.created}`);
            cmtLines.push(body);
            cmtLines.push(``);
          }
          parts.push({ type: "text", text: cmtLines.join("\n") });
        }
      }
      if (includeImages) {
        let saved = [];
        if (fs2.existsSync(cacheDir)) {
          const files = fs2.readdirSync(cacheDir);
          const imageExtensions = [".png", ".jpeg", ".jpg", ".gif", ".webp", ".svg", ".bmp"];
          saved = files.filter((f) => imageExtensions.includes(path2.extname(f).toLowerCase())).map((f) => path2.join(cacheDir, f));
        }
        if (saved.length > 0) {
          parts.push({
            type: "text",
            text: `## \u{1F5BC}\uFE0F \u1EA2nh \u0111\xEDnh k\xE8m (\u0111\xE3 cache v\u1EC1 local)
\u{1F4C1} \`${cacheDir}\`
`
          });
          saved.forEach((f) => {
            parts.push({
              type: "text",
              text: `- \u{1F4F8} \`${f}\` \u2192 **H\xE3y d\xF9ng tool read_file \u0111\u1EC3 \u0111\u1ECDc \u1EA3nh n\xE0y v\xE0 tr\xEDch xu\u1EA5t text b\u1EB1ng Vision**`
            });
          });
        }
      }
      parts.push({
        type: "text",
        text: `---
## \u{1F916} Y\xEAu c\u1EA7u ph\xE2n t\xEDch
D\u1EF1a tr\xEAn t\u1EA5t c\u1EA3 th\xF4ng tin tr\xEAn (description, comments, v\xE0 text trong \u1EA3nh \u0111\xE3 cache \u1EDF local), h\xE3y:
1. D\xF9ng Vision \u0111\u1ECDc t\u1EEBng file \u1EA3nh trong th\u01B0 m\u1EE5c cache
2. T\xF3m t\u1EAFt y\xEAu c\u1EA7u ch\xEDnh c\u1EE7a task
3. Li\u1EC7t k\xEA c\xE1c \u0111i\u1EC3m c\u1EA7n l\xE0m c\u1EE5 th\u1EC3
4. T\u1ED5ng h\u1EE3p c\xE1c \xFD ki\u1EBFn quan tr\u1ECDng t\u1EEB comment
5. \u0110\u1ED1i chi\u1EBFu text trong \u1EA3nh v\u1EDBi m\xF4 t\u1EA3`
      });
      return { content: parts };
    }
  );
  server.tool(
    "jira_cache_task",
    "Download t\u1EA5t c\u1EA3 \u1EA3nh & file \u0111\xEDnh k\xE8m c\u1EE7a m\u1ED9t issue v\u1EC1 th\u01B0 m\u1EE5c local (~/.pnj-task/{issueKey}/). D\xF9ng tool n\xE0y \u0111\u1EC3 t\u1EA1o knowledge base offline, sau \u0111\xF3 Copilot c\xF3 th\u1EC3 \u0111\u1ECDc file tr\u1EF1c ti\u1EBFp t\u1EEB \u1ED5 \u0111\u0129a.",
    {
      issueKey: z.string().describe("M\xE3 issue Jira, v\xED d\u1EE5: PROJ-123")
    },
    async ({ issueKey }) => {
      const cacheDir = jira.getCacheDir(issueKey);
      await jira.getIssue(issueKey);
      const lines = [
        `\u{1F4E5} **Cache task ${issueKey}** \u2192 \`${cacheDir}\`
`,
        `\u2705 \u0110\xE3 l\u01B0u th\xF4ng tin chi ti\u1EBFt v\xE0o \`task_info.md\``,
        `\u2705 \u0110\xE3 c\u1EADp nh\u1EADt ch\u1EC9 m\u1EE5c t\u1ED5ng h\u1EE3p t\u1EA1i \`~/.pnj-task/index.md\``
      ];
      if (fs2.existsSync(cacheDir)) {
        const files = fs2.readdirSync(cacheDir).filter((f) => f !== "task_info.json" && f !== "task_info.md");
        if (files.length > 0) {
          lines.push(`\u2705 \u0110\xE3 l\u01B0u **${files.length}** file \u0111\xEDnh k\xE8m:`);
          files.forEach((f) => lines.push(`   - \`${path2.join(cacheDir, f)}\``));
        }
      }
      lines.push(`
\u{1F4A1} B\u1EA1n ho\u1EB7c Agent c\xF3 th\u1EC3 \u0111\u1ECDc c\xE1c file n\xE0y offline b\u1EB1ng c\xE1ch m\u1EDF tr\u1EF1c ti\u1EBFp \u0111\u01B0\u1EDDng d\u1EABn.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Jira MCP Server is ready!");
}
function formatIssue(issue) {
  const lines = [
    `**[${issue.key}]** ${issue.summary}`,
    `- Status: ${issue.status} | Priority: ${issue.priority} | Type: ${issue.issueType}`,
    `- Assignee: ${issue.assignee || "Unassigned"} | Project: ${issue.project}`,
    `- Created: ${issue.created} | Updated: ${issue.updated}`,
    `- Link: ${issue.url}`
  ];
  if (issue.parent) {
    lines.push(`- Parent Task: ${issue.parent}`);
  }
  if (issue.subtasks && issue.subtasks.length > 0) {
    const subtaskKeys = issue.subtasks.map((st) => `${st.key} (${st.status})`).join(", ");
    lines.push(`- Subtasks: ${subtaskKeys}`);
  }
  if (issue.issueLinks && issue.issueLinks.length > 0) {
    const linkKeys = issue.issueLinks.map((l) => `[${l.relationship}] ${l.key} (${l.status})`).join(", ");
    lines.push(`- Related Issues: ${linkKeys}`);
  }
  if (issue.description) {
    const desc = issue.description.length > 300 ? issue.description.substring(0, 300) + "..." : issue.description;
    lines.push(`- Description: ${desc}`);
  }
  return lines.join("\n");
}
main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
