// Customer responses to interactive messages (options, forms, CSAT surveys, email requests),
// formatted like Chatwoot's Slack integration does when a response is submitted
// (lib/integrations/slack/update_slack_message_service.rb at v4.18.0), in Discord markdown.
// Nothing here performs I/O.

import { isRecord } from "../json.js";
import { chatwootMentions } from "./format.js";

/** Message content types whose submitted response is posted (SUPPORTED_CONTENT_TYPES). */
const RESPONSE_CONTENT_TYPES: ReadonlySet<string> = new Set(["input_select", "form", "input_csat", "input_email"]);

/** The fields of a Chatwoot message (webhook payload or API) that carry a submitted response. */
interface InteractiveMessage {
  contentType: unknown;
  /** The question: the message content. */
  content: unknown;
  /** content_attributes.submitted_values, submitted_email, and items. */
  submittedValues: unknown;
  submittedEmail: unknown;
  items: unknown;
}

/** Reads the response fields from a message's `content_type` and `content_attributes`. */
export function interactiveMessage(contentType: unknown, content: unknown, attributes: unknown): InteractiveMessage {
  const record = isRecord(attributes) ? attributes : {};
  return {
    contentType,
    content,
    submittedValues: record.submitted_values,
    submittedEmail: record.submitted_email,
    items: record.items,
  };
}

/** A supported interactive message with a submitted response (`updateable_message?`). */
export function hasResponse(message: InteractiveMessage): boolean {
  return (
    typeof message.contentType === "string" &&
    RESPONSE_CONTENT_TYPES.has(message.contentType) &&
    (present(message.submittedValues) || present(message.submittedEmail))
  );
}

/**
 * The question followed by the formatted response (`updated_message_content`), or undefined
 * when there is no response to show. Slack then keeps the question alone; here there is nothing
 * to post.
 */
export function responseText(message: InteractiveMessage): string | undefined {
  if (!hasResponse(message)) return undefined;
  const response = formattedResponse(message);
  if (!response) return undefined;
  const question = plainText(typeof message.content === "string" ? chatwootMentions(message.content) : message.content);
  return [question, response].filter((part) => part !== "").join("\n\n");
}

function formattedResponse(message: InteractiveMessage): string | undefined {
  switch (message.contentType) {
    case "input_select":
      return selectResponse(message);
    case "form":
      return formResponse(message);
    case "input_csat":
      return csatResponse(message);
    case "input_email":
      return emailResponse(message);
    default:
      return undefined;
  }
}

function selectResponse(message: InteractiveMessage): string | undefined {
  const item = toArray(message.submittedValues)[0];
  if (!isRecord(item) || !present(item)) return undefined;
  const value = plainText(firstSet(item.title, item.value));
  return value === "" ? undefined : `**Response:** ${value}`;
}

function emailResponse(message: InteractiveMessage): string | undefined {
  const email = plainText(message.submittedEmail);
  return email === "" ? undefined : `**Email:** ${email}`;
}

function formResponse(message: InteractiveMessage): string | undefined {
  const submitted = toArray(message.submittedValues);
  if (submitted.length === 0) return undefined;
  const itemsByName = new Map<unknown, unknown>();
  for (const item of toArray(message.items)) itemsByName.set(flexValue(item, "name"), item);
  const lines = submitted.flatMap((submittedValue) => {
    const name = flexValue(submittedValue, "name");
    const value = plainText(flexValue(submittedValue, "value"));
    if (value === "") return [];
    const label = plainText(firstSet(flexValue(itemsByName.get(name), "label"), name));
    return label === "" ? [] : [`• ${label}: ${value}`];
  });
  return lines.length === 0 ? undefined : `**Responses:**\n${lines.join("\n")}`;
}

function csatResponse(message: InteractiveMessage): string | undefined {
  const csat = flexValue(message.submittedValues, "csat_survey_response", "csatSurveyResponse");
  if (!present(csat)) return undefined;
  const rating = flexValue(csat, "rating");
  const feedback = flexValue(csat, "feedback_message", "feedbackMessage");
  const lines: string[] = [];
  if (present(rating)) lines.push(`• Rating: ${String(rating)}`);
  if (present(feedback)) lines.push(`• Feedback: ${plainText(feedback)}`);
  return lines.length === 0 ? undefined : `**CSAT:**\n${lines.join("\n")}`;
}

/** The first of `keys` whose value is present (`flex_value`); JSON keys are always strings. */
function flexValue(hash: unknown, ...keys: string[]): unknown {
  if (!isRecord(hash) || !present(hash)) return undefined;
  for (const key of keys) {
    if (present(hash[key])) return hash[key];
  }
  return undefined;
}

/**
 * Tag-free text (`ActionView::Base.full_sanitizer.sanitize(text.to_s).strip`). Slack's output
 * keeps `&`, `<`, and `>` as entities, which Slack decodes; Discord does not, so entities are
 * decoded here instead.
 */
export function plainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[a-z][^>]*(?:>|$)/gi, "");
  return decodeEntities(text).trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Ruby's `a || b`: only nil and false fall through. */
function firstSet(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined && value !== false);
}

/** Ruby's `present?`: not nil, false, blank text, or an empty array or hash. */
function present(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Ruby's `Array(value)` for JSON values; a hash, which Ruby turns into pairs, has no items here. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || isRecord(value)) return [];
  return [value];
}
