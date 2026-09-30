// Buttons on a ticket's posts and the Manage panel. The buttons hold no state: each acts on the
// ticket as it is when pressed. The panel (a Components V2 message: a heading above each menu)
// shows the ticket as it was when last drawn and is drawn again after every change, so its
// selections are the ticket's state (see executeCommand). Nothing here performs I/O.

import {
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIMessageTopLevelComponent,
  type APISelectMenuOption,
  ButtonStyle,
  ComponentType,
} from "discord-api-types/v10";
import { PRIORITY_NAMES, SNOOZE_NAMES } from "./definitions.ts";

/** Custom ids of the ticket buttons. */
export const BUTTONS = {
  reply: "ticket:reply",
  take: "ticket:take",
  resolve: "ticket:resolve",
  manage: "ticket:manage",
} as const;

/** Custom ids of the panel's menus. */
export const PANEL = {
  assignee: "panel:assignee",
  labels: "panel:labels",
  priority: "panel:priority",
  status: "panel:status",
} as const;

export type ActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;

/** The panel's value for "no assignee" and "no priority". */
export const NONE = "none";

/** Discord's limits for a select menu. */
const MAX_OPTIONS = 25;
const MAX_OPTION_TEXT = 100;

function button(
  customId: string,
  label: string,
  emoji: string,
  style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success = ButtonStyle.Secondary,
): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: customId, label, emoji: { name: emoji }, style };
}

/** The buttons on the ticket card and under each message. */
export function ticketButtons(): ActionRow[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        button(BUTTONS.reply, "Reply", "✏️", ButtonStyle.Primary),
        button(BUTTONS.take, "Take", "🙋"),
        button(BUTTONS.resolve, "Resolve", "✅", ButtonStyle.Success),
        button(BUTTONS.manage, "Manage", "⚙️"),
      ],
    },
  ];
}

/** Text in a Components V2 message. */
export function text(content: string): APIMessageTopLevelComponent {
  return { type: ComponentType.TextDisplay, content };
}

export interface TicketState {
  assigneeId: number | null;
  labels: string[];
  priority: string | null;
  status: string;
}

/**
 * The panel for a ticket: a title (and what was just done), then its assignee, labels, priority,
 * and status, each a menu under a heading.
 */
export function panel(
  heading: string,
  ticket: TicketState,
  agents: Array<{ id: number; name: string }>,
  accountLabels: string[],
): APIMessageTopLevelComponent[] {
  const option = (value: string, label: string, selected: boolean): APISelectMenuOption => ({
    value,
    label: Array.from(label).slice(0, MAX_OPTION_TEXT).join("") || value,
    default: selected,
  });
  const menu = (
    customId: string,
    title: string,
    options: APISelectMenuOption[],
    { multiple = false, placeholder = title }: { multiple?: boolean; placeholder?: string } = {},
  ): APIMessageTopLevelComponent[] => [
    text(`**${title}**`),
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: customId,
          placeholder,
          options,
          ...(multiple ? { min_values: 0, max_values: options.length } : {}),
        },
      ],
    },
  ];

  const people = [
    option(NONE, "Unassigned", ticket.assigneeId === null),
    ...agents.map((agent) => option(String(agent.id), agent.name, agent.id === ticket.assigneeId)),
  ].slice(0, MAX_OPTIONS);
  // The ticket's own labels first, so they stay in the menu when the account has too many.
  const labels = [...new Set([...ticket.labels, ...accountLabels])]
    .slice(0, MAX_OPTIONS)
    .map((label) => option(label, label, ticket.labels.includes(label)));
  const priorities = Object.entries(PRIORITY_NAMES).map(([value, name]) =>
    option(value, name, (ticket.priority ?? NONE) === value),
  );
  const statuses = [
    option("open", "Open", ticket.status === "open"),
    option("pending", "Pending", ticket.status === "pending"),
    option("resolved", "Resolved", ticket.status === "resolved"),
    ...Object.entries(SNOOZE_NAMES).map(([value, name]) => option(value, `Snooze: ${name}`, false)),
  ];

  return [
    text(heading),
    ...menu(PANEL.assignee, "Assignee", people),
    ...(labels.length > 0 ? menu(PANEL.labels, "Labels", labels, { multiple: true, placeholder: "No labels" }) : []),
    ...menu(PANEL.priority, "Priority", priorities),
    ...menu(PANEL.status, "Status", statuses, { placeholder: ticket.status === "snoozed" ? "Snoozed" : "Status" }),
  ];
}
