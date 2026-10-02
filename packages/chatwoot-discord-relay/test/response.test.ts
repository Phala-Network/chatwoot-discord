import { describe, expect, it } from "vitest";
import { ACTIVITY_WAIT_MS, eventTarget } from "../src/chatwoot/webhook.ts";
import { hasResponse, interactiveMessage, plainText, responseText } from "../src/relay/response.ts";

const response = (contentType: string, content: string, attributes: Record<string, unknown>) =>
  responseText(interactiveMessage(contentType, content, attributes));

// The examples of chatwoot/chatwoot v4.18.0 spec/lib/integrations/slack/update_slack_message_service_spec.rb.
describe("responses to interactive messages", () => {
  it("formats an option pick", () => {
    const attributes = {
      items: [
        { title: "Option A", value: "a" },
        { title: "Option B", value: "b" },
      ],
      submitted_values: [{ title: "Option A", value: "a" }],
    };
    expect(response("input_select", "Pick one", attributes)).toBe("Pick one\n\n**Response:** Option A");
    expect(response("input_select", "Pick one", { submitted_values: [{ value: "a" }] })).toBe(
      "Pick one\n\n**Response:** a",
    );
    // Ruby's `title || value` only falls through on nil: a blank title shows no response.
    expect(response("input_select", "Pick one", { submitted_values: [{ title: "", value: "a" }] })).toBeUndefined();
  });

  it("formats a form, labelling each value by its item", () => {
    const attributes = {
      items: [
        { name: "email", label: "Email" },
        { name: "company", label: "Company" },
      ],
      submitted_values: [
        { name: "email", value: "a@example.com" },
        { name: "company", value: "Acme" },
        { name: "notes", value: "No label" },
        { name: "empty", value: "" },
      ],
    };
    expect(response("form", "Please fill this", attributes)).toBe(
      "Please fill this\n\n**Responses:**\n• Email: a@example.com\n• Company: Acme\n• notes: No label",
    );
  });

  it("formats a CSAT rating and feedback", () => {
    const rated = { csat_survey_response: { rating: 5, feedback_message: "Great support!" } };
    expect(response("input_csat", "Rate us", { submitted_values: rated })).toBe(
      "Rate us\n\n**CSAT:**\n• Rating: 5\n• Feedback: Great support!",
    );
    expect(response("input_csat", "Rate us", { submitted_values: { csatSurveyResponse: { rating: 3 } } })).toBe(
      "Rate us\n\n**CSAT:**\n• Rating: 3",
    );
  });

  it("formats a submitted email", () => {
    expect(response("input_email", "Get notified by email", { submitted_email: "user@example.com" })).toBe(
      "Get notified by email\n\n**Email:** user@example.com",
    );
  });

  it("shows nothing without a response or for other content types", () => {
    expect(response("input_select", "Pick one", { items: [{ title: "Option A", value: "a" }] })).toBeUndefined();
    expect(response("input_select", "Pick one", { submitted_values: [] })).toBeUndefined();
    expect(response("input_email", "Email?", { submitted_email: "  " })).toBeUndefined();
    expect(response("cards", "Cards", { submitted_values: [{ title: "x" }] })).toBeUndefined();
    expect(response("text", "Hi", { submitted_email: "user@example.com" })).toBeUndefined();
    expect(hasResponse(interactiveMessage("input_csat", "Rate us", null))).toBe(false);
  });

  it("strips markup and turns mentions into names, like Slack's sanitized content", () => {
    expect(
      response("input_email", "Hi [@Sam](mention://user/7/Sam), <b>your</b> email?", {
        submitted_email: " <i>user@example.com</i> ",
      }),
    ).toBe("Hi @Sam, your email?\n\n**Email:** user@example.com");
    expect(response("input_email", "", { submitted_email: "user@example.com" })).toBe("**Email:** user@example.com");
    expect(plainText("Tom &amp; Jerry &lt;3 <!-- note --><a href='x'>link</a> &#169; a < b")).toBe(
      "Tom & Jerry <3 link © a < b",
    );
  });
});

describe("conversation event routing", () => {
  it("queues message_created at once, and conversation changes after their activity message", () => {
    expect(eventTarget({ event: "message_created", id: 1, account: { id: 3 }, conversation: { id: 12 } })).toEqual({
      type: "conversation",
      accountId: 3,
      conversationId: 12,
      delayMs: 0,
    });
    for (const event of ["conversation_updated", "conversation_status_changed"]) {
      expect(eventTarget({ event, id: 12, account: { id: 3 } })).toEqual({
        type: "conversation",
        accountId: 3,
        conversationId: 12,
        delayMs: ACTIVITY_WAIT_MS,
      });
    }
  });
});

describe("message_updated routing", () => {
  const updated = (fields: Record<string, unknown>) => ({
    event: "message_updated",
    id: 55,
    account: { id: 3 },
    conversation: { id: 12 },
    ...fields,
  });
  const target = { type: "message-updated", accountId: 3, conversationId: 12, messageId: 55 };

  it("queues deletions and each supported content type with a response", () => {
    expect(eventTarget(updated({ content_attributes: { deleted: true } }))).toEqual(target);
    for (const [contentType, attributes] of [
      ["input_select", { submitted_values: [{ title: "A", value: "a" }] }],
      ["form", { submitted_values: [{ name: "email", value: "a@example.com" }] }],
      ["input_csat", { submitted_values: { csat_survey_response: { rating: 4 } } }],
      ["input_email", { submitted_email: "user@example.com" }],
    ] as const) {
      expect(eventTarget(updated({ content_type: contentType, content_attributes: attributes }))).toEqual(target);
    }
  });

  it("queues outgoing updates including failed replies retried as sent", () => {
    const failed = { message_type: "outgoing", content_attributes: { external_error: "Outside the 24 hour window" } };
    expect(eventTarget(updated(failed))).toEqual(target);
    expect(eventTarget(updated({ ...failed, message_type: "incoming" }))).toBeUndefined();
    expect(eventTarget(updated({ message_type: "outgoing", status: "sent", content_attributes: {} }))).toEqual(target);
  });

  it("ignores other message updates", () => {
    for (const fields of [
      { content_type: "text", content: "edited", content_attributes: {} },
      { content_type: "input_select", content_attributes: { items: [{ title: "A", value: "a" }] } },
      { content_type: "input_email", content_attributes: { submitted_email: "" } },
      { content_type: "cards", content_attributes: { submitted_values: [{ title: "A" }] } },
      { content_type: "input_csat", content_attributes: { submitted_values: {} } },
    ]) {
      expect(eventTarget(updated(fields))).toBeUndefined();
    }
  });
});
