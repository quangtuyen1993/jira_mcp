import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface JiraConfig {
  baseUrl: string;
  authType: "basic" | "session";
  username: string;
  password: string;
  loginEndpoint: string;
}

export interface JiraIssueLink {
  key: string;
  summary: string;
  relationship: string;
  status: string;
}

export interface JiraSubtask {
  key: string;
  summary: string;
  status: string;
}

export interface JiraIssue {
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
  issueLinks?: JiraIssueLink[];
  subtasks?: JiraSubtask[];
  parent?: string;
}

export interface CacheOptions {
  onlyImages?: boolean;
  maxFiles?: number;
  maxSize?: number; // in bytes
}

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  author: string;
  downloadUrl: string;
  thumbnailUrl?: string;
}

export interface JiraComment {
  id: string;
  body: string;
  author: string;
  created: string;
  updated: string;
}

export interface JiraSearchResult {
  total: number;
  issues: JiraIssue[];
}

export interface CreateIssuePayload {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  priority?: string;
  assignee?: string;
}

/**
 * Jira API Client – hỗ trợ cả Basic Auth và Session-based Auth
 */
export class JiraClient {
  private client: AxiosInstance;
  private config: JiraConfig;
  private sessionCookie: string | null = null;

  constructor(config: JiraConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  }

  /**
   * Xác thực với Jira. Với basic auth thì chỉ cần set header,
   * với session auth thì gọi API login để lấy JSESSIONID.
   */
  async authenticate(): Promise<void> {
    if (this.config.authType === "basic") {
      const token = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString("base64");
      this.client.defaults.headers.common["Authorization"] = `Basic ${token}`;
      console.error("[JiraClient] Using Basic Auth");
    } else {
      // Session-based auth: login để lấy cookie
      try {
        const response = await this.client.post(
          this.config.loginEndpoint,
          {
            username: this.config.username,
            password: this.config.password,
          },
          { withCredentials: true }
        );

        // Lấy JSESSIONID từ Set-Cookie header
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
          this.client.defaults.headers.common["Cookie"] =
            this.sessionCookie;
          console.error("[JiraClient] Session authenticated successfully");
        } else {
          // Fallback: thử lấy session từ response body (một số Jira version)
          const sessionData = response.data?.session;
          if (sessionData?.value) {
            this.sessionCookie = `${sessionData.name}=${sessionData.value}`;
            this.client.defaults.headers.common["Cookie"] =
              this.sessionCookie;
            console.error("[JiraClient] Session from response body");
          } else {
            throw new Error(
              "Could not obtain session cookie. Response: " +
              JSON.stringify(response.data).substring(0, 200)
            );
          }
        }
      } catch (error: any) {
        throw new Error(
          `Session login failed: ${error.message}. Endpoint: ${this.config.loginEndpoint}`
        );
      }
    }
  }

  /**
   * Lấy chi tiết một issue theo key (vd: PROJ-123)
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    try {
      const response = await this.client.get(`/rest/api/2/issue/${issueKey}`);
      const issue = this.mapIssue(response.data);
      
      // Tự động kiểm tra và cập nhật cache local khi fetch
      await this.autoCacheIssue(issue);
      
      return issue;
    } catch (error: any) {
      throw handleAxiosError(error, `Get issue ${issueKey}`);
    }
  }

  /**
   * Tạo 1 hoặc nhiều issue mới. Sử dụng API Bulk nếu có nhiều hơn 1 issue.
   */
  async createIssues(payloads: CreateIssuePayload[]): Promise<string[]> {
    if (payloads.length === 0) return [];

    const formatIssueUpdate = (p: CreateIssuePayload) => {
      const fields: any = {
        project: { key: p.projectKey },
        summary: p.summary,
        issuetype: { name: p.issueType },
      };
      if (p.description) fields.description = p.description;
      if (p.priority) fields.priority = { name: p.priority };
      if (p.assignee) fields.assignee = { name: p.assignee }; // Hoặc accountId tuỳ phiên bản Jira
      return { fields };
    };

    if (payloads.length === 1) {
      // API tạo 1 issue
      const response = await this.client.post("/rest/api/2/issue", formatIssueUpdate(payloads[0]));
      return [response.data.key];
    } else {
      // API tạo nhiều issue (bulk)
      try {
        const issueUpdates = payloads.map(formatIssueUpdate);
        const response = await this.client.post("/rest/api/2/issue/bulk", { issueUpdates });
        return response.data.issues.map((i: any) => i.key);
      } catch (err: any) {
        console.error("[JiraClient] Bulk create failed, falling back to sequential creation:", err.message);
        const keys: string[] = [];
        for (const p of payloads) {
          const response = await this.client.post("/rest/api/2/issue", formatIssueUpdate(p));
          keys.push(response.data.key);
        }
        return keys;
      }
    }
  }

  /**
   * Tìm kiếm issue bằng JQL
   */
  async searchIssues(
    jql: string,
    maxResults: number = 20
  ): Promise<JiraSearchResult> {
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
          "parent",
        ],
      });

      return {
        total: response.data.total,
        issues: response.data.issues.map((i: any) => this.mapIssue(i)),
      };
    } catch (error: any) {
      throw handleAxiosError(error, `JQL search "${jql}"`);
    }
  }

  /**
   * Lấy danh sách issue được assign cho user hiện tại
   */
  async getMyIssues(maxResults: number = 20): Promise<JiraSearchResult> {
    return this.searchIssues(
      "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
      maxResults
    );
  }

  /**
   * Lấy danh sách issue trong một project
   */
  async getProjectIssues(
    projectKey: string,
    maxResults: number = 20
  ): Promise<JiraSearchResult> {
    return this.searchIssues(
      `project = ${projectKey} ORDER BY updated DESC`,
      maxResults
    );
  }

  /**
   * Kiểm tra kết nối – lấy thông tin user hiện tại
   */
  async whoami(): Promise<string> {
    try {
      const response = await this.client.get("/rest/api/2/myself");
      return `${response.data.displayName} (${response.data.emailAddress || response.data.name})`;
    } catch (error: any) {
      throw handleAxiosError(error, "Whoami check");
    }
  }

  /**
   * Lấy danh sách file đính kèm của một issue
   */
  async getAttachments(issueKey: string): Promise<JiraAttachment[]> {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}?fields=attachment`
      );
      const attachments = response.data?.fields?.attachment || [];
      return attachments.map((att: any) => ({
        id: att.id,
        filename: att.filename,
        size: att.size,
        mimeType: att.mimeType || "",
        created: att.created || "",
        author: att.author?.displayName || "Unknown",
        downloadUrl: att.content || `${this.config.baseUrl}/secure/attachment/${att.id}/${att.filename}`,
        thumbnailUrl: att.thumbnail || undefined,
      }));
    } catch (error: any) {
      throw handleAxiosError(error, `Get attachments for issue ${issueKey}`);
    }
  }

  /**
   * Lấy danh sách comment của một issue
   */
  async getComments(issueKey: string, maxResults: number = 50): Promise<JiraComment[]> {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}/comment`,
        { params: { maxResults } }
      );
      const comments = response.data?.comments || [];
      return comments.map((c: any) => ({
        id: c.id,
        body: c.body || "",
        author: c.author?.displayName || "Unknown",
        created: c.created || "",
        updated: c.updated || "",
      }));
    } catch (error: any) {
      throw handleAxiosError(error, `Get comments for issue ${issueKey}`);
    }
  }

  /**
   * Lấy danh sách các transitions (trạng thái chuyển đổi) khả dụng của issue
   */
  async getTransitions(issueKey: string): Promise<any[]> {
    try {
      const response = await this.client.get(
        `/rest/api/2/issue/${issueKey}/transitions`
      );
      return response.data?.transitions || [];
    } catch (error: any) {
      throw handleAxiosError(error, `Get transitions for issue ${issueKey}`);
    }
  }

  /**
   * Thực hiện chuyển đổi trạng thái (transition) của issue
   */
  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    try {
      await this.client.post(
        `/rest/api/2/issue/${issueKey}/transitions`,
        {
          transition: {
            id: transitionId,
          },
        }
      );
    } catch (error: any) {
      throw handleAxiosError(error, `Transition issue ${issueKey} with ID ${transitionId}`);
    }
  }

  /**
   * Download nội dung attachment dạng base64.
   * Jira PNJ dùng URL web /secure/attachment/{id}/{filename}, nên ưu tiên cách này.
   */
  async downloadAttachment(attachmentId: string, url: string): Promise<{ contentType: string; base64: string }> {
    console.error(`[JiraClient] Downloading attachment ${attachmentId}: ${url}`);

    // Cách 1: Dùng URL từ att.content (thường là /secure/attachment/...)
    try {
      const response = await this.client.get(url, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const contentType: string = String(response.headers["content-type"] || "application/octet-stream");
      const base64 = Buffer.from(response.data).toString("base64");
      console.error(`[JiraClient] Downloaded ${attachmentId}: ${(base64.length / 1024).toFixed(1)} KB`);
      return { contentType, base64 };
    } catch (err: any) {
      // Cách 2: Fallback REST API endpoint
      console.error(`[JiraClient] Web URL failed: ${err.message}, trying REST API...`);
      const apiUrl = `/rest/api/2/attachment/content/${attachmentId}`;
      const response = await this.client.get(apiUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const contentType: string = String(response.headers["content-type"] || "application/octet-stream");
      const base64 = Buffer.from(response.data).toString("base64");
      return { contentType, base64 };
    }
  }

  /**
   * Download tất cả attachments của 1 issue về thư mục local cache.
   * Thư mục: ~/.pnj-task/{issueKey}/
   */
  getCacheDir(issueKey: string): string {
    return path.join(os.homedir(), ".pnj-task", issueKey);
  }

  async downloadAttachmentsToCache(
    issueKey: string,
    options?: CacheOptions
  ): Promise<{ saved: string[]; errors: string[] }> {
    const atts = await this.getAttachments(issueKey);
    const cacheDir = this.getCacheDir(issueKey);
    fs.mkdirSync(cacheDir, { recursive: true });

    const saved: string[] = [];
    const errors: string[] = [];
    
    const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"];

    let filteredAtts = atts;

    // Apply onlyImages filter
    if (options?.onlyImages) {
      filteredAtts = filteredAtts.filter(att => imageTypes.includes(att.mimeType));
    }

    // Apply maxSize filter
    if (options?.maxSize) {
      filteredAtts = filteredAtts.filter(att => att.size <= options.maxSize!);
    }

    // Apply maxFiles filter
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
      } catch (err: any) {
        errors.push(`${att.filename}: ${err.message}`);
        console.error(`[JiraClient] Failed to save ${att.filename}: ${err.message}`);
      }
    }

    return { saved, errors };
  }

  async writeTaskMetadataToCache(
    issue: JiraIssue,
    comments: JiraComment[],
    cacheDir: string
  ): Promise<void> {
    const filePath = path.join(cacheDir, "task_info.md");
    console.error(`[JiraClient] Writing task metadata to ${filePath}...`);

    const markdown: string[] = [
      `# [${issue.key}] ${issue.summary}`,
      ``,
      `| Thuộc tính | Giá trị |`,
      `|---|---|`,
      `| **Trạng thái (Status)** | ${issue.status} |`,
      `| **Người được giao (Assignee)** | ${issue.assignee || "Chưa giao (Unassigned)"} |`,
      `| **Mức độ ưu tiên (Priority)** | ${issue.priority} |`,
      `| **Loại yêu cầu (Type)** | ${issue.issueType} |`,
      `| **Dự án (Project)** | ${issue.project} |`,
      `| **Ngày tạo (Created)** | ${issue.created} |`,
      `| **Cập nhật (Updated)** | ${issue.updated} |`,
      `| **Đường dẫn gốc (Jira Link)** | [Browse Issue](${issue.url}) |`,
      ``,
    ];

    if (issue.parent) {
      markdown.push(`- 🔺 **Task cha (Parent)**: [${issue.parent}](../${issue.parent}/task_info.md)`);
    }

    if (issue.subtasks && issue.subtasks.length > 0) {
      markdown.push(`## 🔽 Task con (Subtasks)`);
      issue.subtasks.forEach(st => {
        markdown.push(`- [${st.key}](../${st.key}/task_info.md) - ${st.summary} (*${st.status}*)`);
      });
      markdown.push(``);
    }

    if (issue.issueLinks && issue.issueLinks.length > 0) {
      markdown.push(`## 🔗 Task liên quan (Relationships)`);
      issue.issueLinks.forEach(link => {
        markdown.push(`- **${link.relationship}**: [${link.key}](../${link.key}/task_info.md) - ${link.summary} (*${link.status}*)`);
      });
      markdown.push(``);
    }

    if (issue.description) {
      markdown.push(`## 📝 Mô tả chi tiết (Description)`);
      markdown.push(issue.description);
      markdown.push(``);
    }

    if (comments.length > 0) {
      markdown.push(`## 💬 Bình luận (Comments - ${comments.length})`);
      comments.forEach((c, index) => {
        markdown.push(`### ${index + 1}. ${c.author} — ${c.created}`);
        markdown.push(c.body);
        markdown.push(``);
      });
    }

    fs.writeFileSync(filePath, markdown.join("\n"), "utf-8");

    // Ghi JSON metadata để check cập nhật sau này
    const jsonPath = path.join(cacheDir, "task_info.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ key: issue.key, updated: issue.updated }, null, 2),
      "utf-8"
    );
  }

  isCacheUpToDate(issueKey: string, updatedTime: string): boolean {
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

  async autoCacheIssue(issue: JiraIssue): Promise<void> {
    const cacheDir = this.getCacheDir(issue.key);
    
    // Nếu cache local đã trùng với thời gian cập nhật trên Jira, bỏ qua không tải lại
    if (this.isCacheUpToDate(issue.key, issue.updated)) {
      console.error(`[JiraClient] Local cache for ${issue.key} is already up to date.`);
      return;
    }

    console.error(`[JiraClient] Cache for ${issue.key} is outdated or missing. Auto-caching in progress...`);
    try {
      // 1. Lấy danh sách bình luận (lấy tối đa 100)
      const comments = await this.getComments(issue.key, 100);
      
      // 2. Tải toàn bộ attachments (hình ảnh và file đính kèm)
      await this.downloadAttachmentsToCache(issue.key);
      
      // 3. Ghi thông tin metadata và comments
      await this.writeTaskMetadataToCache(issue, comments, cacheDir);
      
      // 4. Cập nhật master index
      await this.updateMasterIndex(issue);
      
      console.error(`[JiraClient] Auto-cached ${issue.key} successfully.`);
    } catch (err: any) {
      console.error(`[JiraClient] Auto-caching failed for ${issue.key}: ${err.message}`);
    }
  }

  async updateMasterIndex(issue: JiraIssue): Promise<void> {
    const baseDir = path.join(os.homedir(), ".pnj-task");
    fs.mkdirSync(baseDir, { recursive: true });
    const indexPath = path.join(baseDir, "index.md");

    console.error(`[JiraClient] Updating master index at ${indexPath}...`);

    let existingContent = "";
    if (fs.existsSync(indexPath)) {
      existingContent = fs.readFileSync(indexPath, "utf-8");
    } else {
      existingContent = `# 📂 Danh sách Jira Task Cache Local\n\n| Task | Tóm tắt | Trạng thái | Cập nhật | Chi tiết offline |\n|---|---|---|---|---|\n`;
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
  private mapIssue(data: any): JiraIssue {
    const fields = data.fields || data;
    
    // Parse subtasks
    const subtasks = fields.subtasks?.map((st: any) => ({
      key: st.key,
      summary: st.fields?.summary || "",
      status: st.fields?.status?.name || "",
    })) || [];

    // Parse parent
    const parent = fields.parent?.key;

    // Parse issueLinks
    const issueLinks = (fields.issuelinks || []).map((link: any) => {
      const isOutward = !!link.outwardIssue;
      const linkedIssue = link.outwardIssue || link.inwardIssue;
      const relationship = isOutward ? link.type?.outward || link.type?.name : link.type?.inward || link.type?.name;
      return {
        key: linkedIssue?.key || "",
        summary: linkedIssue?.fields?.summary || "",
        relationship: relationship || "",
        status: linkedIssue?.fields?.status?.name || "",
      };
    }).filter((link: any) => !!link.key);

    return {
      key: data.key || fields.key,
      summary: fields.summary || "",
      status: fields.status?.name || "",
      assignee: fields.assignee?.displayName || null,
      priority: fields.priority?.name || "",
      issueType: fields.issuetype?.name || "",
      created: fields.created || "",
      updated: fields.updated || "",
      description: fields.description
        ? typeof fields.description === "string"
          ? fields.description
          : JSON.stringify(fields.description)
        : undefined,
      project: fields.project?.key || "",
      url: `${this.config.baseUrl}/browse/${data.key || fields.key}`,
      issueLinks,
      subtasks,
      parent,
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────
function handleAxiosError(error: any, action: string): Error {
  if (error.response) {
    const data = error.response.data;
    let details = "";
    if (data) {
      if (Array.isArray(data.errorMessages) && data.errorMessages.length > 0) {
        details = data.errorMessages.join(", ");
      } else if (data.errors && typeof data.errors === "object") {
        details = Object.entries(data.errors)
          .map(([key, val]) => `${key}: ${val}`)
          .join("; ");
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
