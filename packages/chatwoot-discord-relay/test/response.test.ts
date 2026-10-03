import { describe, expect, it } from "vitest";
import { interactiveMessage, responseText } from "../src/relay/response.ts";

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
    expect(response("input_csat", "Rate us", {})).toBeUndefined();
  });

  it("strips markup and turns mentions into names, like Slack's sanitized content", () => {
    expect(
      response("input_email", "Hi [@Sam](mention://user/7/Sam), <b>your</b> email?", {
        submitted_email: " <i>user@example.com</i> ",
      }),
    ).toBe("Hi @Sam, your email?\n\n**Email:** user@example.com");
    expect(response("input_email", "", { submitted_email: "user@example.com" })).toBe("**Email:** user@example.com");
    expect(
      response("input_email", "", {
        submitted_email: "Tom &amp; Jerry &lt;3 <!-- note --><a href='x'>link</a> &#169; a < b",
      }),
    ).toBe("**Email:** Tom & Jerry <3 link © a < b");
  });
});
