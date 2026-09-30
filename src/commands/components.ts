// Buttons on a ticket's posts and the Manage panel. The buttons hold no state: each acts on the
// ticket as it is when pressed. The panel shows the ticket as it was when last drawn and is drawn
// again after every change, so its selections are the ticket's state (see executeCommand).
// Nothing here performs I/O.

import {
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
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

/** The ticket card's buttons (`card`), or the shorter row under each customer message. */
export function ticketButtons(where: "card" | "message"): ActionRow[] {
  const buttons = [
    button(BUTTONS.reply, "Reply", "✏️", ButtonStyle.Primary),
    ...(where === "card"
      ? [button(BUTTONS.take, "Take", "🙋"), button(BUTTONS.resolve, "Resolve", "✅", ButtonStyle.Success)]
      : []),
    button(BUTTONS.manage, "Manage", "⚙️"),
  ];
  return [{ type: ComponentType.ActionRow, components: buttons }];
}

export interface TicketState {
  assigneeId: number | null;
  labels: string[];
  priority: string | null;
  status: string;
}

/** The panel for a ticket: its assignee, labels, priority, and status, each a menu. */
export function panelRows(
  ticket: TicketState,
  agents: Array<{ id: number; name: string }>,
  accountLabels: string[],
): ActionRow[] {
  const option = (value: string, label: string, selected: boolean): APISelectMenuOption => ({
    value,
    label: Array.from(label).slice(0, MAX_OPTION_TEXT).join("") || value,
    default: selected,
  });
  const menu = (
    customId: string,
    placeholder: string,
    options: APISelectMenuOption[],
    multiple = false,
  ): ActionRow => ({
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
  });

  const people = [
    option(NONE, "Unassigned", ticket.assigneeId === null),
    ...agents.map((agent) => option(String(agent.id), agent.name, agent.id === ticket.assigneeId)),
  ].slice(0, MAX_OPTIONS);
  // The ticket's own labels first, so they stay in the menu when the account has too many.
  const labels = [...new Set([...ticket.labels, ...accountLabels])]
    .slice(0, MAX_OPTIONS)
    .map((label) => option(label, label, ticket.labels.includes(label)));
  const priorities = Object.entries(PRIORITY_NAMES).map(([value, name]) =>
    option(value, `Priority: ${name}`, (ticket.priority ?? NONE) === value),
  );
  const statuses = [
    option("open", "Open", ticket.status === "open"),
    option("pending", "Pending", ticket.status === "pending"),
    option("resolved", "Resolved", ticket.status === "resolved"),
    ...Object.entries(SNOOZE_NAMES).map(([value, name]) => option(value, `Snooze: ${name}`, false)),
  ];

  return [
    menu(PANEL.assignee, "Assignee", people),
    ...(labels.length > 0 ? [menu(PANEL.labels, "Labels", labels, true)] : []),
    menu(PANEL.priority, "Priority", priorities),
    menu(PANEL.status, ticket.status === "snoozed" ? "Snoozed" : "Status", statuses),
  ];
}
