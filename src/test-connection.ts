/**
 * Test script – kiểm tra kết nối Jira trước khi dùng MCP
 *
 * Cách chạy:
 *   1. Sửa file .env với username/password thật
 *   2. Chạy: npx tsx src/test-connection.ts
 *
 * Script này sẽ:
 *   - Kết nối và xác thực với Jira
 *   - Lấy thông tin user hiện tại
 *   - Thử lấy 1 issue bất kỳ (nếu có)
 */

import "dotenv/config";
import { JiraClient } from "./jira-client.js";

async function test() {
  const config = {
    baseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/$/, ""),
    authType: (process.env.JIRA_AUTH_TYPE || "basic") as "basic" | "session",
    username: process.env.JIRA_USERNAME || "",
    password: process.env.JIRA_PASSWORD || "",
    loginEndpoint: process.env.JIRA_LOGIN_ENDPOINT || "/rest/auth/1/session",
  };

  console.log("═══════════════════════════════════════════");
  console.log("  Jira MCP – Connection Test");
  console.log("═══════════════════════════════════════════");
  console.log(`  URL:      ${config.baseUrl}`);
  console.log(`  Auth:     ${config.authType}`);
  console.log(`  User:     ${config.username}`);
  console.log("═══════════════════════════════════════════\n");

  if (!config.baseUrl || !config.username || !config.password) {
    console.error("❌ Thiếu thông tin! Hãy sửa file .env trước khi test.");
    process.exit(1);
  }

  const jira = new JiraClient(config);

  try {
    // Bước 1: Xác thực
    console.log("1️⃣  Đang xác thực...");
    await jira.authenticate();
    console.log("   ✅ Xác thực thành công!\n");

    // Bước 2: Lấy thông tin user
    console.log("2️⃣  Đang lấy thông tin user...");
    const user = await jira.whoami();
    console.log(`   ✅ Bạn đăng nhập với: ${user}\n`);

    // Bước 3: Thử lấy task của bạn
    console.log("3️⃣  Đang lấy danh sách task của bạn...");
    const myTasks = await jira.getMyIssues(5);
    console.log(`   ✅ Tìm thấy ${myTasks.total} task open\n`);
    if (myTasks.issues.length > 0) {
      console.log("   📋 5 task gần nhất:");
      myTasks.issues.forEach((issue, i) => {
        console.log(
          `      ${i + 1}. [${issue.key}] ${issue.summary} (${issue.status})`
        );
      });
    } else {
      console.log("   (Không có task nào đang open)");
    }
    console.log();

    // Bước 4: Thử tìm kiếm JQL
    console.log("4️⃣  Đang thử JQL search...");
    const searchResult = await jira.searchIssues(
      "project IS NOT EMPTY ORDER BY created DESC",
      3
    );
    console.log(`   ✅ Tổng số issue trong hệ thống: ${searchResult.total}`);
    if (searchResult.issues.length > 0) {
      console.log("   📋 3 issue mới nhất:");
      searchResult.issues.forEach((issue, i) => {
        console.log(
          `      ${i + 1}. [${issue.key}] ${issue.summary}`
        );
      });
    }
    console.log();

    console.log("═══════════════════════════════════════════");
    console.log("  ✅ Tất cả test passed! MCP server sẵn sàng.");
    console.log("═══════════════════════════════════════════");
  } catch (error: any) {
    console.error(`\n❌ Lỗi: ${error.message}`);
    console.error("\n💡 Gợi ý khắc phục:");
    console.error("  - Kiểm tra lại username/password trong .env");
    console.error("  - Thử đổi JIRA_AUTH_TYPE=session nếu basic auth không hoạt động");
    console.error(
      "  - Kiểm tra JIRA_BASE_URL đã đúng chưa (có cần thêm /jira không?)"
    );
    process.exit(1);
  }
}

test();
