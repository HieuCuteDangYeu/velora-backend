import type { MediaNodeRecord } from './media-node.contract';

const priorityOf = (node: MediaNodeRecord): number =>
  Number.isFinite(node.priority) && (node.priority as number) > 0
    ? Math.floor(node.priority as number)
    : 0;

const hasRoom = (node: MediaNodeRecord): boolean =>
  !(Number.isFinite(node.maxRooms) && (node.maxRooms as number) > 0) ||
  node.rooms < (node.maxRooms as number);

function fewestRooms(
  nodes: MediaNodeRecord[],
  random: () => number,
): MediaNodeRecord {
  const fewest = Math.min(...nodes.map((node) => node.rooms));
  const candidates = nodes.filter((node) => node.rooms === fewest);
  // Random among equals so replicas placing at once do not pile on one node.
  return candidates[Math.floor(random() * candidates.length)];
}

/**
 * Chooses the node for a new call from the live media nodes.
 *
 * Nodes are grouped by priority (lower is preferred). The most preferred group
 * with a node below its room limit takes the call, on its least loaded node. A
 * less preferred group, for example a node in another region, only gets calls
 * when every more preferred node is full or gone, so it acts as overflow and
 * failover. When every live node is full the call still goes to the least
 * loaded one instead of being refused. Records without priority or maxRooms
 * (older nodes) count as priority 0 with no limit, which is the former
 * "fewest rooms" behaviour.
 */
export function selectMediaNode(
  live: MediaNodeRecord[],
  random: () => number = Math.random,
): MediaNodeRecord | undefined {
  if (!live.length) return undefined;

  const priorities = [...new Set(live.map(priorityOf))].sort((a, b) => a - b);
  for (const priority of priorities) {
    const open = live.filter(
      (node) => priorityOf(node) === priority && hasRoom(node),
    );
    if (open.length) return fewestRooms(open, random);
  }
  return fewestRooms(live, random);
}
