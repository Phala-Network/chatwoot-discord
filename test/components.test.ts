import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { assigneeMenu, panel, ticketCard } from "../src/commands/components.ts";

type Menu = { custom_id: string; placeholder?: string; options: Array<{ value: string; default?: boolean }> };
type Row = { type: number; components: Menu[] };

/** The panel's menu `customId`. */
function panelSelect(components: unknown, customId: string): Menu | undefined {
  const [card] = components as [{ components: Row[] }];
  return card.components.flatMap((part) => part.components ?? []).find((item) => item.custom_id === customId);
}

/** The options of the panel's menu `customId`. */
function panelMenu(components: unknown, customId: string): Menu["options"] {
  return panelSelect(components, customId)?.options ?? [];
}

const agents = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: `Agent ${index + 1}` }));

describe("ticket menus", () => {
  it("keep the current assignee in a menu of more agents than it holds", () => {
    const [row] = assigneeMenu(agents, 29) as unknown as Row[];
    const options = row?.components[0]?.options ?? [];
    expect(options).toHaveLength(25);
    expect(options.slice(0, 2)).toEqual([
      expect.objectContaining({ value: ":none" }),
      expect.objectContaining({ value: "29", default: true }),
    ]);
    const card = panel("### Acme #1", { assigneeId: 29, labels: [], status: "open" }, agents, []);
    expect(panelMenu(card, "panel:assignee").find((option) => option.default)?.value).toBe("29");
  });

  it("offer every label a menu can hold, a label called none included, and leave longer ones to /label", () => {
    const long = "l".repeat(101);
    const card = panel("### Acme #1", { assigneeId: null, labels: ["none"], status: "open" }, [], ["billing", long]);
    expect(panelMenu(card, "panel:labels").map((option) => `${option.value}${option.default ? "*" : ""}`)).toEqual([
      ":none",
      "none*",
      "billing",
    ]);
  });

  it("name a current label too long for the menu instead of showing it as no label", () => {
    const long = "l".repeat(101);
    const card = panel("### Acme #1", { assigneeId: null, labels: [long], status: "open" }, [], []);
    const menu = panelSelect(card, "panel:labels");
    expect(menu?.placeholder).toMatch(/^🏷️ l+… \(\/label\)$/);
    expect(menu?.options.some((option) => option.default)).toBe(false);
  });

  it("bound a card's overview, however long the names and many the labels", () => {
    const labels = Array.from({ length: 40 }, (_, index) => `${index}`.padEnd(100, "x"));
    const [card] = ticketCard({
      title: "Acme #1",
      customer: "z".repeat(300),
      details: ["Email", "w".repeat(300)],
      url: "https://chatwoot.example.com/app/accounts/3/conversations/1",
      status: "open",
      assignee: "y".repeat(300),
      labels,
    });
    const summary = card?.type === ComponentType.Container ? card.components[0] : undefined;
    const content = summary?.type === ComponentType.TextDisplay ? summary.content : "";
    expect(content.length).toBeLessThan(800);
    expect(content.endsWith(" · +35")).toBe(true);
  });
});
