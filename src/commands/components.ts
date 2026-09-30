// Buttons on a ticket's posts and the Manage panel. The buttons hold no state: each acts on the
// ticket as it is when pressed. The panel (a Components V2 card) shows the ticket as it was when
// last drawn and is drawn again after every change, so its selections and highlighted buttons are
// the ticket's state (see executeCommand). Nothing here performs I/O.

import {
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIMessageTopLevelComponent,
  type APISelectMenuOption,
  ButtonStyle,
  ComponentType,
} from "discord-api-types/v10";

/** Custom ids of the ticket buttons. */
export const BUTTONS = {
  reply: "ticket:reply",
  take: "ticket:take",
  resolve: "ticket:resolve",
  manage: "ticket:manage",
} as const;

/** Custom ids of the panel's menus, and the prefix of its status buttons. */
export const PANEL = {
  assignee: "panel:assignee",
  labels: "panel:labels",
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
  status: string;
}

/** The panel's statuses, with the value each button sets: "Snooze" snoozes until the next reply. */
const STATUSES: Array<[status: string, value: string, name: string, emoji: string]> = [
  ["open", "open", "Open", "🟢"],
  ["resolved", "resolved", "Resolved", "✅"],
  ["snoozed", "until_next_reply", "Snooze", "💤"],
];

/** The card's accent: the ticket's status at a glance. */
const STATUS_COLORS: Record<string, number> = {
  open: 0x3ba55c,
  pending: 0xfaa61a,
  snoozed: 0x5865f2,
  resolved: 0x80848e,
};

/**
 * The panel for a ticket, a card: its title (and what was just done), menus for its assignee and
 * labels, and a row of buttons for its status, the current one highlighted. (Priority and
 * "pending" are left to the commands.)
 */
export function panel(
  heading: string,
  ticket: TicketState,
  agents: Array<{ id: number; name: string }>,
  accountLabels: string[],
): APIMessageTopLevelComponent[] {
  const option = (value: string, label: string, emoji: string, selected: boolean): APISelectMenuOption => ({
    value,
    label: Array.from(label).slice(0, MAX_OPTION_TEXT).join("") || value,
    emoji: { name: emoji },
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
  const choices = (
    field: string,
    items: Array<[value: string, name: string, emoji: string, current: boolean]>,
  ): ActionRow => ({
    type: ComponentType.ActionRow,
    components: items.map(([value, name, emoji, current]) =>
      button(`${field}:${value}`, name, emoji, current ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  });

  const people = [
    option(NONE, "Unassigned", "👤", ticket.assigneeId === null),
    ...agents.map((agent) => option(String(agent.id), agent.name, "👤", agent.id === ticket.assigneeId)),
  ].slice(0, MAX_OPTIONS);
  // The ticket's own labels first, so they stay in the menu when the account has too many.
  const labels = [...new Set([...ticket.labels, ...accountLabels])]
    .slice(0, MAX_OPTIONS)
    .map((label) => option(label, label, "🏷️", ticket.labels.includes(label)));

  return [
    {
      type: ComponentType.Container,
      accent_color: STATUS_COLORS[ticket.status] ?? null,
      components: [
        { type: ComponentType.TextDisplay, content: heading },
        menu(PANEL.assignee, "👤 Unassigned", people),
        ...(labels.length > 0 ? [menu(PANEL.labels, "🏷️ No labels", labels, true)] : []),
        choices(
          PANEL.status,
          STATUSES.map(([status, value, name, emoji]) => [value, name, emoji, status === ticket.status]),
        ),
      ],
    },
  ];
}
