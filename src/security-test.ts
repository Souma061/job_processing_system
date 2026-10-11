import fs from "node:fs";
import path from "node:path";
import {
  API_KEY_ADMIN,
  API_KEY_STANDARD,
  API_KEY_VIP,
  UPLOADS_DIR,
} from "./config/constants.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

let passedCount = 0;
let failedCount = 0;

function assert(description: string, condition: boolean, extraInfo?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${description}`);
    if (extraInfo) console.error("    Details:", extraInfo);
    failedCount++;
  }
}

async function runSecurityTestSuite() {
  console.log("\n🛡️ ========================================================");
  console.log("   PHASE 19: SECURITY, AUTHENTICATION & HARDENING TEST SUITE");
  console.log("========================================================\n");

  // TEST 1: Public Healthcheck Access
  console.log(
    "Test 1: Verify /health remains accessible without API Key (for Docker/K8s probes)",
  );
  try {
    const res = await fetch(`${BASE_URL}/health`);
    assert(
      "Public /health returns HTTP 200 without API key",
      res.status === 200,
    );
  } catch (err: any) {
    assert("Failed to query /health", false, err.message);
  }

  // TEST 2: Missing API Key on Protected Endpoint
  console.log(
    "\nTest 2: Enforce 401 Unauthorized when X-API-Key header is omitted",
  );
  try {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "sample.jpg" }),
    });
    const body: any = await res.json();
    assert("Missing API key returns HTTP 401", res.status === 401);
    assert(
      "Error payload specifies UNAUTHORIZED",
      body.error === "UNAUTHORIZED",
    );
  } catch (err: any) {
    assert("Failed missing API key test", false, err.message);
  }

  // TEST 3: Invalid API Key Rejection
  console.log(
    "\nTest 3: Reject bogus / invalid API keys with 401 Unauthorized",
  );
  try {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "bogus_attacker_key_999",
      },
      body: JSON.stringify({ image: "sample.jpg" }),
    });
    const body: any = await res.json();
    assert("Invalid API key returns HTTP 401", res.status === 401);
    assert(
      "Error payload identifies INVALID_API_KEY",
      body.error === "INVALID_API_KEY",
    );
  } catch (err: any) {
    assert("Failed invalid key test", false, err.message);
  }

  // TEST 4: Standard User Enqueueing Normal Job
  console.log("\nTest 4: Allow Standard tier key to enqueue Priority 5 job");
  try {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_STANDARD,
      },
      body: JSON.stringify({ image: "sample.jpg", priority: 5 }),
    });
    const body: any = await res.json();
    assert("Standard user job accepted with HTTP 201", res.status === 201);
    assert("Response identifies standard tier", body.tier === "standard");
    assert("Assigned default priority 5", body.priority === 5);
  } catch (err: any) {
    assert("Failed standard job test", false, err.message);
  }

  // TEST 5: Tier-Enforced VIP Authorization (Queue-Jumping Theft Prevention)
  console.log(
    "\nTest 5: Block Standard tier user attempting to request Priority 1 (VIP)",
  );
  try {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_STANDARD,
      },
      body: JSON.stringify({ image: "sample.jpg", priority: 1 }), // Standard user trying to cut the line!
    });
    const body: any = await res.json();
    assert(
      "Standard user requesting VIP priority returns HTTP 403 Forbidden",
      res.status === 403,
    );
    assert(
      "Error code confirms FORBIDDEN_TIER",
      body.error === "FORBIDDEN_TIER",
    );
  } catch (err: any) {
    assert("Failed VIP theft defense test", false, err.message);
  }

  // TEST 6: Legitimate VIP Key Auto-Prioritization
  console.log(
    "\nTest 6: Legitimate VIP key automatically receives Priority 1 (Expedited Queue)",
  );
  try {
    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_VIP,
      },
      body: JSON.stringify({ image: "sample.jpg" }),
    });
    const body: any = await res.json();
    assert("VIP user job accepted with HTTP 201", res.status === 201);
    assert("Response identifies VIP tier", body.tier === "vip");
    assert("VIP priority 1 automatically assigned", body.priority === 1);
  } catch (err: any) {
    assert("Failed VIP prioritization test", false, err.message);
  }

  // TEST 7: Role-Based Access Control on Administrative Operations (DELETE /jobs)
  console.log("\nTest 7: RBAC on admin endpoints (DELETE /jobs)");
  try {
    // 7a. Standard user attempt
    const stdRes = await fetch(`${BASE_URL}/jobs`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY_STANDARD },
    });
    assert(
      "Standard user calling DELETE /jobs returns HTTP 403 Forbidden",
      stdRes.status === 403,
    );

    // 7b. Admin user attempt
    const adminRes = await fetch(`${BASE_URL}/jobs`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY_ADMIN },
    });
    assert(
      "Admin user calling DELETE /jobs returns HTTP 200 OK",
      adminRes.status === 200,
    );
  } catch (err: any) {
    assert("Failed RBAC delete test", false, err.message);
  }

  // TEST 8: Path Traversal Attack Prevention
  console.log(
    "\nTest 8: Defend against Path Traversal injection ('../../etc/passwd')",
  );
  try {
    const unixTraversal = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_STANDARD,
      },
      body: JSON.stringify({ image: "../../etc/passwd" }),
    });
    const unixBody: any = await unixTraversal.json();
    assert(
      "Unix path traversal rejected with HTTP 400 Bad Request",
      unixTraversal.status === 400,
    );
    assert(
      "Error confirms PATH_TRAVERSAL_DETECTED",
      unixBody.error === "PATH_TRAVERSAL_DETECTED",
    );

    const winTraversal = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_STANDARD,
      },
      body: JSON.stringify({ image: "..\\..\\windows\\system32\\cmd.exe" }),
    });
    const winBody: any = await winTraversal.json();
    assert(
      "Windows path traversal rejected with HTTP 400 Bad Request",
      winTraversal.status === 400,
    );
    assert(
      "Error confirms PATH_TRAVERSAL_DETECTED",
      winBody.error === "PATH_TRAVERSAL_DETECTED",
    );
  } catch (err: any) {
    assert("Failed path traversal test", false, err.message);
  }

  // TEST 9: Magic Byte File Inspection (Disguised Malware Defense)
  console.log(
    "\nTest 9: Defend against disguised scripts with fake image extensions (Magic Bytes)",
  );
  const fakeMaliciousFile = path.resolve(UPLOADS_DIR, "disguised-malware.jpg");
  try {
    // Write fake text file disguised as .jpg (starts with plain text characters, not FF D8 FF)
    fs.writeFileSync(
      fakeMaliciousFile,
      "#!/bin/bash\necho 'rm -rf /'\n",
      "utf-8",
    );

    const res = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY_STANDARD,
      },
      body: JSON.stringify({ image: "disguised-malware.jpg" }),
    });
    const body: any = await res.json();
    assert(
      "Disguised text file rejected with HTTP 400 Bad Request",
      res.status === 400,
    );
    assert(
      "Error confirms INVALID_FILE_SIGNATURE",
      body.error === "INVALID_FILE_SIGNATURE",
    );
  } catch (err: any) {
    assert("Failed magic bytes test", false, err.message);
  } finally {
    // Cleanup fake test file
    try {
      if (fs.existsSync(fakeMaliciousFile)) fs.unlinkSync(fakeMaliciousFile);
    } catch {}
  }

  // TEST 10: Defend against Log/Script Injection in X-Correlation-Id
  console.log(
    "\nTest 10: Defend against Log/Script Injection in X-Correlation-Id",
  );
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: {
        "X-Correlation-Id": "poisoned-trace<script>alert(1)</script>",
      },
    });
    const returnedCorrId = res.headers.get("x-correlation-id") || "";
    assert(
      "Injected script/illegal characters stripped and rejected",
      !returnedCorrId.includes("<") && !returnedCorrId.includes(">"),
    );
    assert(
      "Replaced with safe auto-generated UUID starting with 'corr-'",
      returnedCorrId.startsWith("corr-") && returnedCorrId.length < 64,
    );
  } catch (err: any) {
    assert("Failed injection correlation test", false, err.message);
  }

  // TEST 11: Defend against Memory Bloat / Oversized X-Correlation-Id
  console.log(
    "\nTest 11: Defend against Oversized X-Correlation-Id (>64 chars)",
  );
  try {
    const oversizedId = "A".repeat(2048); // 2KB attack string
    const res = await fetch(`${BASE_URL}/health`, {
      headers: {
        "X-Correlation-Id": oversizedId,
      },
    });
    const returnedCorrId = res.headers.get("x-correlation-id") || "";
    assert(
      "Oversized correlation ID rejected and capped to <= 64 chars",
      returnedCorrId.length <= 64,
    );
    assert(
      "Replaced with safe auto-generated UUID",
      returnedCorrId.startsWith("corr-"),
    );
  } catch (err: any) {
    assert("Failed oversized correlation test", false, err.message);
  }

  // TEST 12: Allow legitimate, clean correlation IDs
  console.log(
    "\nTest 12: Preserve legitimate client correlation IDs matching whitelist",
  );
  try {
    const cleanId = "valid-client-trace-987";
    const res = await fetch(`${BASE_URL}/health`, {
      headers: {
        "X-Correlation-Id": cleanId,
      },
    });
    const returnedCorrId = res.headers.get("x-correlation-id") || "";
    assert(
      "Legitimate correlation ID preserved exactly",
      returnedCorrId === cleanId,
    );
  } catch (err: any) {
    assert("Failed legitimate correlation test", false, err.message);
  }

  // SUMMARY
  console.log("\n========================================================");
  console.log(
    `🛡️ SECURITY TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`,
  );
  console.log("========================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSecurityTestSuite();
