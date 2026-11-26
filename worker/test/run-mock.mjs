// Run the mock GitHub on :8788 for trying the sign-in flow in a browser without a real OAuth App.
// Pair it with: wrangler dev --var GITHUB_WEB_BASE:http://localhost:8788 --var GITHUB_API_BASE:http://localhost:8788
//               --var GITHUB_CLIENT_ID:mock-client --var GITHUB_CLIENT_SECRET:mock-secret --var ADMIN_GITHUB_IDS:1001
import { startMockGitHub } from "./mock-github.mjs";

const mock = await startMockGitHub();
mock.state.user = { id: 1001, login: "octo-admin", avatar_url: null, created_at: "2015-01-01T00:00:00Z" };
console.log("mock GitHub listening on http://localhost:8788 (signs everyone in as @octo-admin, id 1001)");
