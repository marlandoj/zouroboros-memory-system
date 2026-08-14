#!/usr/bin/env bun
/**
 * mimir-instructor-digest.ts — standalone wrapper for the Mimir Academy skill-health digest.
 *
 * Used by scheduled automations to deliver 2b (dependency paths) and 2e (skill health)
 * as a periodic briefing. Calls buildInstructorDigest() from mimir-academy-rag.ts.
 *
 * Flags:
 *   --json   emit raw JSON instead of plain text
 *   --sms    send digest via SMS to the operator (uses ZO_CLIENT_IDENTITY_TOKEN)
 */

import { buildInstructorDigest } from "./mimir-academy-rag.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sendSms = args.includes("--sms");

const digest = buildInstructorDigest();

if (asJson) {
  console.log(JSON.stringify({ digest, ts: new Date().toISOString() }, null, 2));
} else {
  console.log(digest);
}

if (sendSms) {
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) {
    console.error("ZO_CLIENT_IDENTITY_TOKEN not set — skipping SMS");
    process.exit(1);
  }
  const res = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: `Send this digest to the user via SMS (send_sms_to_user):\n\n${digest}`,
      model_name: "byok:63a73cf2-224a-4641-8dcb-c3313270d08a",
    }),
  });
  if (!res.ok) {
    console.error(`SMS delivery failed: ${res.status}`);
    process.exit(1);
  }
  console.log("SMS delivered.");
}
