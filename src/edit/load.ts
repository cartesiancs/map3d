// Buildings into Edit mode: the exact shape of a building (its OSM ring, or its approved map3d edit), read
// with the same query as the GLB export, and a pending changeset reopened as drafts ("Edit my proposal").

import type { ChangesetDetail } from "@/api/changesets";
import { buildingIdOf, refOf } from "@/api/changesets";
import { fetchBuildings } from "@/api/osmSource";
import { prismToMesh } from "@/contrib/mesh";
import { itemShapes } from "@/edit/review";
import { tileManager } from "@/three/Space";
import { buildingHeight } from "@/three/tiles/geo";
import { Draft, levelsOf, newDraftId } from "./drafts";

/** a loaded building (feature id: OSM way id, or negative for one added on map3d) as an unchanged draft */
export async function loadDraft(featureId: number): Promise<Draft> {
  const found = tileManager.findBuilding(featureId);
  const box = found && tileManager.buildingLngLatBox(found.key, found.index);
  if (!box) throw new Error("This building is not loaded: move closer and try again");
  const f = (await fetchBuildings(box)).find((b) => b.type === "way" && b.id === featureId);
  if (!f) throw new Error("This building could not be read");
  // open ring (a closed way repeats its first point)
  const closed = f.parts[0][0];
  const [first, last] = [closed[0], closed[closed.length - 1]];
  const ring = closed.length > 1 && first[0] === last[0] && first[1] === last[1] ? closed.slice(0, -1) : closed;
  const tags = f.tags;
  const original = f.mesh ?? prismToMesh(ring, buildingHeight(tags));
  const ref = refOf(featureId);
  const edited = tags["map3d:edited"];
  const levels = levelsOf(tags);
  return {
    id: ref,
    ref,
    featureId,
    kind: "modify",
    // the first edit of an OSM way sends the original (decides which tile hides it)
    base: featureId > 0 && !edited ? { footprint: ring, tags } : null,
    baseRev: edited ?? "osm",
    tags,
    original,
    originalLevels: levels,
    mesh: original,
    levels,
    deleted: false,
  };
}

/** a pending changeset as drafts, each starting from the building as it is now */
export function draftsOf(detail: ChangesetDetail): Draft[] {
  return detail.items.flatMap((item): Draft[] => {
    const { before, after } = itemShapes(item);
    const tags = item.base?.tags ?? {};
    const originalLevels = item.current?.levels ?? levelsOf(tags);
    const levels = item.proposal.levels !== undefined ? item.proposal.levels : originalLevels;
    if (item.kind === "create") {
      if (!after) return [];
      return [{ id: item.clientId?.startsWith("draft:") ? item.clientId : newDraftId(), ref: null, featureId: null, kind: "create", base: null, baseRev: "new", tags: {}, original: null, originalLevels: null, mesh: after, levels, deleted: false }];
    }
    const mesh = after ?? before;
    if (!item.ref || !mesh) return [];
    const merged = { ...tags, ...(item.current?.name ? { "name:en": item.current.name } : {}) };
    return [
      {
        id: item.ref,
        ref: item.ref,
        featureId: buildingIdOf(item.ref),
        kind: "modify",
        base: item.base,
        baseRev: item.baseRev,
        tags: merged,
        original: before ?? mesh,
        originalLevels,
        mesh,
        levels,
        deleted: item.kind === "delete",
      },
    ];
  });
}
