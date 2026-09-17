//////////////////////////////////////////////////////
// SERVICE RESOLVERS
//////////////////////////////////////////////////////

type ServiceNode = {
  id: string;
  type?: string;
  isBookable?: boolean;
  durationMinutes?: number | null;
  defaultPrice?: number | null;
  parent?: ServiceNode | null;
};

//////////////////////////////////////////////////////
// BOOKABLE
//////////////////////////////////////////////////////

export function resolveBookable(
  node: ServiceNode
): boolean {

  // direct rule
  if (node.type === "SERVICE") return true;

  if (node.isBookable) return true;

  let parent = node.parent;

  while (parent) {
    if (
      parent.type === "SERVICE" ||
      parent.isBookable
    )
      return true;

    parent = parent.parent;
  }

  return false;
}

//////////////////////////////////////////////////////
// PRICE
//////////////////////////////////////////////////////

export function resolvePrice(
  node: ServiceNode
): number | null {

  if (node.defaultPrice)
    return node.defaultPrice;

  let parent = node.parent;

  while (parent) {
    if (parent.defaultPrice)
      return parent.defaultPrice;

    parent = parent.parent;
  }

  return null;
}

//////////////////////////////////////////////////////
// DURATION
//////////////////////////////////////////////////////

export function resolveDuration(
  node: ServiceNode
): number | null {

  if (node.durationMinutes)
    return node.durationMinutes;

  let parent = node.parent;

  while (parent) {
    if (parent.durationMinutes)
      return parent.durationMinutes;

    parent = parent.parent;
  }

  return null;
}

//////////////////////////////////////////////////////
// FINAL RESOLVER
//////////////////////////////////////////////////////

export function resolveServiceCapabilities(
  node: ServiceNode
) {
  return {
    resolvedBookable:
      resolveBookable(node),

    resolvedPrice:
      resolvePrice(node),

    resolvedDuration:
      resolveDuration(node),
  };
}