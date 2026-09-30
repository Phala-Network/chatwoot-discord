// Buttons on a ticket's posts, the menus they open, and the Manage panel. The buttons hold no
// state: each acts on the ticket as it is when pressed. The panel (a Components V2 card) shows the
// ticket as it was when drawn, and is drawn again after each change made from it (see
// executeCommand). Nothing here performs I/O.

import {
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIMessageTopLevelComponent,
  type APISelectMenuOption,
  ButtonStyle,
  ComponentType,
} from "discord-api-types/v10";

/** Custom ids of the ticket buttons and the menus they show. */
export const BUTTONS = {
  reply: "ticket:reply",
  /** Followed by ":<answer message id>": under a triage bot's answer with a draft. */
  draft: "ticket:draft",
  take: "ticket:take",
  assign: "ticket:assign",
  /** The menu Assign to shows. */
  assignee: "ticket:assignee",
  resolve: "ticket:resolve",
  snooze: "ticket:snooze",
  block: "ticket:block",
  /** On the confirmation Block asks for. */
  blockConfirmed: "ticket:block-confirmed",
  manage: "ticket:manage",
} as const;

/** Custom ids of the panel's menus, and the prefix of its status buttons. */
export const PANEL = {
  assignee: "panel:assignee",
  labels: "panel:labels",
  status: "panel:status",
} as const;

export type ActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;

/**
 * A menu's value for "no assignee" or "no label". A Chatwoot label has only letters, digits, "-",
 * and "_", and an agent is a number, so it cannot be either.
 */
export const NONE = ":none";

/** Discord's limits for a select menu. */
const MAX_OPTIONS = 25;
const MAX_OPTION_TEXT = 100;

type Style = ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger;

function button(
  customId: string,
  label: string,
  emoji: string,
  style: Style = ButtonStyle.Secondary,
): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: customId, label, emoji: { name: emoji }, style };
}

function row(components: APIComponentInMessageActionRow[]): ActionRow {
  return { type: ComponentType.ActionRow, components };
}

function option(value: string, label: string, emoji: string, selected: boolean): APISelectMenuOption {
  return {
    value,
    label: Array.from(label).slice(0, MAX_OPTION_TEXT).join("") || value,
    emoji: { name: emoji },
    ...(selected ? { default: true } : {}),
  };
}

/**
 * The ticket buttons, a row per concern: answering (Reply; under a triage bot's answer with a
 * draft, led by Use draft for that answer, highlighted), who owns the ticket (Take; Assign to,
 * which shows a menu of agents), and its state (Resolve, Snooze until the next reply, Block, and
 * Manage for the panel).
 */
export function ticketButtons(answerId?: string): ActionRow[] {
  return [
    row(
      answerId
        ? [
            button(`${BUTTONS.draft}:${answerId}`, "Use draft", "🤖", ButtonStyle.Primary),
            button(BUTTONS.reply, "Reply", "✏️"),
          ]
        : [button(BUTTONS.reply, "Reply", "✏️", ButtonStyle.Primary)],
    ),
    row([button(BUTTONS.take, "Take", "🙋"), button(BUTTONS.assign, "Assign to…", "👤")]),
    row([
      button(BUTTONS.resolve, "Resolve", "✅", ButtonStyle.Success),
      button(BUTTONS.snooze, "Snooze", "💤"),
      button(BUTTONS.block, "Block", "🚫", ButtonStyle.Danger),
      button(BUTTONS.manage, "Manage", "⚙️"),
    ]),
  ];
}

/**
 * The agents to choose from: Unassigned, the current assignee, then the others, as many as a menu
 * holds (an account with more agents assigns the rest with /assign or in Chatwoot).
 */
function agentOptions(agents: Array<{ id: number; name: string }>, assigneeId: number | null): APISelectMenuOption[] {
  const current = agents.filter((agent) => agent.id === assigneeId);
  const others = agents.filter((agent) => agent.id !== assigneeId);
  return [
    option(NONE, "Unassigned", "👤", assigneeId === null),
    ...[...current, ...others].map((agent) => option(String(agent.id), agent.name, "👤", agent.id === assigneeId)),
  ].slice(0, MAX_OPTIONS);
}

/** Assign to's menu: the account's agents, the current assignee selected. */
export function assigneeMenu(agents: Array<{ id: number; name: string }>, assigneeId: number | null): ActionRow[] {
  return [
    row([
      {
        type: ComponentType.StringSelect,
        custom_id: BUTTONS.assignee,
        placeholder: "Assign to…",
        options: agentOptions(agents, assigneeId),
      },
    ]),
  ];
}

/** Block asks first: it resolves the ticket and mutes the contact. */
export function blockConfirmation(): ActionRow[] {
  return [row([button(BUTTONS.blockConfirmed, "Block contact", "🚫", ButtonStyle.Danger)])];
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
 * its label (the Manage card sets one label per ticket; /label adds and removes several), and a
 * row of buttons for its status, the current one highlighted. Priority and "pending" are left to
 * their commands.
 */
export function panel(
  heading: string,
  ticket: TicketState,
  agents: Array<{ id: number; name: string }>,
  accountLabels: string[],
): APIMessageTopLevelComponent[] {
  const menu = (customId: string, placeholder: string, options: APISelectMenuOption[]): ActionRow =>
    row([{ type: ComponentType.StringSelect, custom_id: customId, placeholder, options }]);

  // The ticket's own label first, so it stays in the menu when the account has too many. A label
  // longer than an option value can be is left to /label; the menu still names the current one.
  const current = ticket.labels[0];
  const labels = [
    option(NONE, "No label", "🏷️", current === undefined),
    ...[...new Set([...ticket.labels, ...accountLabels])]
      .filter((label) => label.length <= MAX_OPTION_TEXT)
      .map((label) => option(label, label, "🏷️", label === current)),
  ].slice(0, MAX_OPTIONS);
  const unlisted = current !== undefined && current.length > MAX_OPTION_TEXT;
  const labelPlaceholder = unlisted ? `🏷️ ${Array.from(current).slice(0, 80).join("")}… (/label)` : "🏷️ No label";
  const statuses = STATUSES.map(([status, value, name, emoji]) =>
    button(
      `${PANEL.status}:${value}`,
      name,
      emoji,
      status === ticket.status ? ButtonStyle.Primary : ButtonStyle.Secondary,
    ),
  );

  return [
    {
      type: ComponentType.Container,
      accent_color: STATUS_COLORS[ticket.status] ?? null,
      components: [
        { type: ComponentType.TextDisplay, content: heading },
        menu(PANEL.assignee, "👤 Unassigned", agentOptions(agents, ticket.assigneeId)),
        ...(labels.length > 1 ? [menu(PANEL.labels, labelPlaceholder, labels)] : []),
        row(statuses),
      ],
    },
  ];
}
