import { useEffect, useState } from "react";

type Point = { lat: number; lng: number };

/** Keep hooks unconditional while the selected area is being initialized. */
export function useRoads(area?: Point[]) {
  const [roads, setRoads] = useState<any[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setRoads([]);
    if (!area || area.length < 2) return;
    const [northEast, southWest] = area;
    if (southWest.lat >= northEast.lat || southWest.lng >= northEast.lng) return;

    const query = `[out:json][timeout:25];(way["highway"](${southWest.lat},${southWest.lng},${northEast.lat},${northEast.lng}););out body geom;`;
    fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Road request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setRoads(data.elements || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error(error);
      });

    return () => controller.abort();
  }, [area]);

  return roads;
}
