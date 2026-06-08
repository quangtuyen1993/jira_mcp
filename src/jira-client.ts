import axios, { AxiosInstance, AxiosRequestConfig } from "axios";

export interface JiraConfig {
  baseUrl: string;
  authType: "basic" | "session";
  username: string;
  password: string;
  loginEndpoint: string;
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
    const response = await this.client.get(`/rest/api/2/issue/${issueKey}`);
    return this.mapIssue(response.data);
  }

  /**
   * Tìm kiếm issue bằng JQL
   */
  async searchIssues(
    jql: string,
    maxResults: number = 20
  ): Promise<JiraSearchResult> {
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
      ],
    });

    return {
      total: response.data.total,
      issues: response.data.issues.map((i: any) => this.mapIssue(i)),
    };
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
    const response = await this.client.get("/rest/api/2/myself");
    return `${response.data.displayName} (${response.data.emailAddress || response.data.name})`;
  }

  /**
   * Lấy danh sách file đính kèm của một issue
   */
  async getAttachments(issueKey: string): Promise<JiraAttachment[]> {
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
  }

  /**
   * Lấy danh sách comment của một issue
   */
  async getComments(issueKey: string, maxResults: number = 50): Promise<JiraComment[]> {
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
   * Map raw API response → JiraIssue
   */
  private mapIssue(data: any): JiraIssue {
    const fields = data.fields || data;
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
    };
  }
}
