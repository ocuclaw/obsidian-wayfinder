import { renderTicketCard, type TicketCardOptions } from "./cards";
import type { MapTree, Snapshot } from "./model";

export function renderTree(
  section: HTMLElement,
  map: MapTree,
  cardOptions: Omit<TicketCardOptions, "asRow">,
): HTMLElement {
  const scroller = section.createDiv({ cls: "wf-tree-scroll" });
  scroller.dataset.mapNumber = String(map.issue.number);
  const tree = scroller.createDiv({ cls: "wf-tree" });
  tree.dataset.mapNumber = String(map.issue.number);
  const svg = tree.createSvg("svg", { cls: "wf-edges" });
  svg.setAttr("aria-hidden", "true");

  for (const layer of map.layers) {
    const layerEl = tree.createDiv({ cls: "wf-layer" });
    for (const ticket of layer) renderTicketCard(layerEl, ticket, map, cardOptions);
  }

  return tree;
}

export function drawAllEdges(root: HTMLElement, snapshot: Snapshot | null): void {
  for (const tree of Array.from(root.querySelectorAll<HTMLElement>(".wf-tree"))) {
    drawEdges(tree, snapshot);
  }
}

function drawEdges(tree: HTMLElement, snapshot: Snapshot | null): void {
  const svg = tree.querySelector<SVGSVGElement>("svg.wf-edges");
  if (!svg || !snapshot) return;
  const treeRect = tree.getBoundingClientRect();
  if (treeRect.width === 0) return;
  svg.setAttr("viewBox", `0 0 ${treeRect.width} ${treeRect.height}`);
  svg.empty();

  const cards = new Map<number, HTMLElement>();
  for (const card of Array.from(tree.querySelectorAll<HTMLElement>(".wf-ticket"))) {
    cards.set(Number(card.dataset.issue), card);
  }

  for (const [number, card] of cards) {
    const dependency = snapshot.deps[String(number)];
    if (!dependency) continue;
    for (const blocker of dependency.blockedBy) {
      const from = cards.get(blocker);
      if (!from) continue;
      drawEdge(svg, treeRect, from, card);
    }
  }
}

function drawEdge(
  svg: SVGSVGElement,
  treeRect: DOMRect,
  from: HTMLElement,
  to: HTMLElement,
): void {
  const source = from.getBoundingClientRect();
  const target = to.getBoundingClientRect();
  const x1 = source.left + source.width / 2 - treeRect.left;
  const y1 = source.bottom - treeRect.top;
  const x2 = target.left + target.width / 2 - treeRect.left;
  const y2 = target.top - treeRect.top;
  const middleY = (y2 - y1) / 2;

  const path = svg.createSvg("path");
  path.setAttr(
    "d",
    `M ${x1} ${y1} C ${x1} ${y1 + middleY}, ${x2} ${y2 - middleY}, ${x2} ${y2}`,
  );
  path.setAttr("fill", "none");
  const frontier = to.hasClass("wf-frontier");
  const closed = to.hasClass("wf-closed");
  path.setAttr(
    "class",
    frontier ? "wf-edge-frontier" : closed ? "wf-edge-closed" : "wf-edge-open",
  );
  if (to.hasClass("wf-blocked")) path.setAttr("stroke-dasharray", "4 3");
}
