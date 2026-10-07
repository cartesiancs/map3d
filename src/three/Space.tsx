import { useEffect, useState } from "react";
import { Canvas, extend, ReactThreeFiber, useThree } from "@react-three/fiber";
import { useAreaStore } from "@/state/areaStore";
import { Html, Sky, Environment, Line } from "@react-three/drei";
import * as THREE from "three";
import { useActionStore } from "@/state/exportStore";
import { GLTFExporter } from "three/examples/jsm/Addons.js";
import Car from "./Car";
import instanceFleet from "@/api/axios";
import { useRoads } from "./useRoads";

const scale = 51000;

function Building({
  shape,
  extrudeSettings,
  tags,
}: {
  shape: THREE.Shape;
  extrudeSettings: any;
  tags: any;
}) {
  const [hovered, setHovered] = useState(false);
  const [clicked, setClicked] = useState(false);
  const [hoverPos, setHoverPos] = useState<THREE.Vector3 | null>(null);
  const [showTranslations, setShowTranslations] = useState(false);
  const [showAdditionalInfo, setShowAdditionalInfo] = useState(false);
  return (
    <mesh
      onPointerOver={(e) => {
        setHovered(true);
        e.stopPropagation();
      }}
      onPointerOut={(e) => {
        setHovered(false);
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        setHoverPos(e.point.clone());
        e.stopPropagation();
      }}
      onClick={(e) => {
        setClicked(!clicked);
        e.stopPropagation();
      }}
      rotation={[-Math.PI / 2, 0, 0]}
      userData={{ exportToGLB: true }}
    >
      <extrudeGeometry args={[shape, extrudeSettings]} />
      <meshStandardMaterial color={hovered || clicked ? "#007bff" : "#9da0a3"} />
      {(hovered || clicked) && hoverPos && (
        <Html position={[hoverPos.x, hoverPos.y + extrudeSettings.depth + 0.5, hoverPos.z]} center>
          <div
            role="dialog"
            aria-label={tags.name || "Building Information"}
            style={{
              color: "#000000",
              backgroundColor: "#ffffff96",
              backdropFilter: "blur(8px)",
              border: "none",
              padding: "14px",
              borderRadius: "10px",
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontSize: "13px",
              width: "200px",
              boxShadow: "0 2px 14px rgba(0, 0, 0, 0.16)",
              transition: "all 0.2s ease-in-out",
            }}
          >
            <div
              style={{
                fontWeight: "600",
                fontSize: "15px",
                borderBottom: tags.name ? "1px solid rgba(0, 0, 0, 0.08)" : "none",
                paddingBottom: tags.name ? "6px" : "0",
                marginBottom: tags.name ? "8px" : "4px",
              }}
            >
              {tags.name || "Building Information"}
            </div>
            {["building", "height", "building:levels", "amenity", "denomination"].map(
              (key) =>
                tags[key] &&
                (key !== "building" || tags[key] !== "yes") && (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      margin: "4px 0",
                    }}
                  >
                    <span style={{ fontWeight: "500", color: "#5f6368" }}>
                      {key === "building"
                        ? "Type"
                        : key === "height"
                        ? "Height"
                        : key === "building:levels"
                        ? "Levels"
                        : key === "amenity"
                        ? "Facility"
                        : key === "denomination"
                        ? "Denomination"
                        : key.replace(/_/g, " ")}
                      :
                    </span>
                    <span style={{ textTransform: "capitalize" }}>
                      {key === "height" ? `${tags[key]} m` : tags[key]}
                    </span>
                  </div>
                )
            )}
            {[
              "addr:street",
              "addr:housenumber",
              "addr:district",
              "addr:city",
              "addr:postcode",
            ].some((key) => tags[key]) && (
              <div
                style={{
                  margin: "10px 0 8px",
                  borderTop: "1px solid rgba(0, 0, 0, 0.08)",
                  paddingTop: "8px",
                }}
              >
                <div style={{ fontWeight: "500", marginBottom: "4px", color: "#5f6368" }}>
                  Address
                </div>
                <div style={{ marginLeft: "4px", fontSize: "12px", color: "#5f6368" }}>
                  {[
                    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
                    tags["addr:district"],
                    tags["addr:city"],
                    tags["addr:postcode"],
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </div>
              </div>
            )}
            {Object.entries(tags).filter(
              ([key]) =>
                ![
                  "building",
                  "name",
                  "height",
                  "building:levels",
                  "source",
                  "amenity",
                  "denomination",
                ].includes(key) &&
                !key.startsWith("addr:") &&
                !key.startsWith("name:") &&
                !key.startsWith("alt_name:")
            ).length > 0 && (
              <div
                style={{
                  margin: "10px 0 4px",
                  borderTop: "1px solid rgba(0, 0, 0, 0.08)",
                  paddingTop: "8px",
                }}
              >
                <div
                  style={{
                    fontWeight: "500",
                    marginBottom: "4px",
                    color: "#5f6368",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                  onClick={() => setShowAdditionalInfo(!showAdditionalInfo)}
                >
                  Additional Information
                  <span>{showAdditionalInfo ? "▲" : "▼"}</span>
                </div>
                {showAdditionalInfo && (
                  <div>
                    {Object.entries(tags)
                      .filter(
                        ([key]) =>
                          ![
                            "building",
                            "name",
                            "height",
                            "building:levels",
                            "source",
                            "amenity",
                            "denomination",
                          ].includes(key) &&
                          !key.startsWith("addr:") &&
                          !key.startsWith("name:") &&
                          !key.startsWith("alt_name:")
                      )
                      .map(([key, value]) => {
                        if (
                          key === "description" ||
                          (typeof value === "string" && value.length > 80)
                        ) {
                          return (
                            <div key={key} style={{ margin: "8px 0" }}>
                              <div
                                style={{ fontWeight: "500", color: "#5f6368", marginBottom: "4px" }}
                              >
                                {key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ")}
                              </div>
                              <div
                                style={{
                                  textAlign: "left",
                                  fontSize: "12px",
                                  color: "#5f6368",
                                  fontWeight: "400",
                                  textWrap: "wrap",
                                  whiteSpace: "pre-wrap",
                                  lineHeight: "1.4",
                                  backgroundColor: "rgba(0,0,0,0.02)",
                                  padding: "6px 8px",
                                  borderRadius: "4px",
                                }}
                              >
                                {String(value)}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={key}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              margin: "4px 0",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: "700",
                                color: "#5f6368",
                                textAlign: "left",
                              }}
                            >
                              {key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ")}:
                            </span>
                            <span
                              style={{
                                textTransform: "capitalize",
                                fontWeight: "400",
                                textAlign: "right",
                              }}
                            >
                              {String(value)}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
            {Object.entries(tags).filter(([key]) => key.startsWith("name:")).length > 0 && (
              <div
                style={{
                  margin: "10px 0 4px",
                  borderTop: "1px solid rgba(0, 0, 0, 0.08)",
                  paddingTop: "8px",
                  textAlign: "right",
                }}
              >
                <div
                  style={{
                    fontWeight: "500",
                    marginBottom: "4px",
                    color: "#5f6368",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                  onClick={() => setShowTranslations(!showTranslations)}
                >
                  Name Translations
                  <span>{showTranslations ? "▲" : "▼"}</span>
                </div>
                {showTranslations && (
                  <div>
                    {Object.entries(tags)
                      .filter(([key]) => key.startsWith("name:"))
                      .map(([key, value]) => (
                        <div
                          key={key}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            margin: "4px 0",
                          }}
                        >
                          <span style={{ fontWeight: "500", color: "#5f6368" }}>
                            {key.replace("name:", "").toUpperCase()}:
                          </span>
                          <span style={{ textTransform: "capitalize" }}>{String(value)}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Html>
      )}
    </mesh>
  );
}

function Roads({ area }: { area: any }) {
  const roads = useRoads(area);
  if (!area || area.length < 2) return null;
  const refLat = (area[1].lat + area[0].lat) / 2;
  const refLng = (area[1].lng + area[0].lng) / 2;

  function project(lat: number, lng: number) {
    const x = (lng - refLng) * scale * Math.cos((refLat * Math.PI) / 180);
    const y = (lat - refLat) * scale;
    return new THREE.Vector2(x, y);
  }


  return (
    <>
      {roads.map((road, index) => {
        if (!road.geometry || road.geometry.length < 2) return null;

        const points = road.geometry.map((pt: any) => {
          const v = project(pt.lat, pt.lon);
          return new THREE.Vector3(v.x, 0.1, -v.y);
        });

        const lineGeometry: any = new THREE.BufferGeometry().setFromPoints(points);

        return (
          <Line
            points={points}
            color="#34f516"
            lineWidth={1}
            userData={{ exportToGLB: true }}
          ></Line>
        );
      })}
    </>
  );
}

export function Export() {
  const { scene } = useThree();
  const action = useActionStore((state) => state.action);
  const fleetSpaceId = useActionStore((state) => state.fleetSpaceId);

  const exportType = useActionStore((state) => state.exportType);

  const setAction = useActionStore((state) => state.setAction);

  useEffect(() => {
    if (action === true) {
      setAction(false);
      exportGLB();
    }
  }, [action, setAction, scene]);

  const uploadFleet = async (blob) => {
    const formData = new FormData();

    formData.append("object", blob, "box3d.glb");
    formData.append("title", "New Object");
    formData.append("description", "");
    formData.append("spaceId", fleetSpaceId);

    await instanceFleet.post("space/file/mesh", formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
  };

  const exportGLB = () => {
    const exportRoot = new THREE.Group();
    scene.traverse((child) => {
      if (child.userData?.exportToGLB === true) {
        exportRoot.add(child.clone(true));
      }
    });
    const exporter = new GLTFExporter();
    const options = { binary: true, embedImages: true };
    exporter.parse(
      exportRoot,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: "model/gltf-binary" });

          if (exportType == "glb") {
            const link = document.createElement("a");
            link.style.display = "none";
            document.body.appendChild(link);
            link.href = URL.createObjectURL(blob);
            link.download = "scene.glb";
            link.click();
            document.body.removeChild(link);
          }

          if (exportType == "fleet") {
            uploadFleet(blob);
          }
        } else {
          console.error("GLB export failed: unexpected result", result);
        }
      },
      (error) => {
        console.error("An error occurred during export", error);
      },
      options
    );
  };
  return null;
}

export function Space() {
  const areas = useAreaStore((state) => state.areas);
  const [realCenter, setRealCenter] = useState<any>();
  const center = useAreaStore((state) => state.center);
  const refLat = (center[1].lat + center[0].lat) / 2;
  const refLng = (center[1].lng + center[0].lng) / 2;

  function project(lat: number, lng: number) {
    const x = (lng - refLng) * scale * Math.cos((refLat * Math.PI) / 180);
    const y = (lat - refLat) * scale;
    return new THREE.Vector2(x, y);
  }

  const areaData = () => {
    const result: Array<{
      shape: THREE.Shape;
      extrudeSettings: any;
      tags: any;
    }> = [];
    areas.forEach((bld: any) => {
      if (!bld.geometry || bld.geometry.length < 3) return;
      const shapePoints = bld.geometry.map((pt: any) => project(pt.lat, pt.lng));
      if (!shapePoints[0].equals(shapePoints[shapePoints.length - 1]))
        shapePoints.push(shapePoints[0]);
      const shape = new THREE.Shape(shapePoints);
      let heightValue = parseFloat(bld.tags.height || "");
      const heightLevels = parseFloat(bld.tags["building:levels"] || "");
      if (isNaN(heightValue)) heightValue = 10;
      if (!isNaN(heightLevels)) heightValue = heightLevels * 2.2;
      const extrudeSettings = {
        steps: 1,
        depth: heightValue,
        bevelEnabled: false,
      };
      result.push({ shape, extrudeSettings, tags: bld.tags });
    });
    return result;
  };

  useEffect(() => {
    setRealCenter(center);
  }, [areas]);

  const buildingsData = areaData();

  return (
    <Canvas camera={{ fov: 90, near: 0.1, far: 7000 }}>
      <ambientLight intensity={Math.PI / 2} />
      <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} decay={0} intensity={Math.PI} />
      {buildingsData.map((item, index) => (
        <Building
          key={index}
          shape={item.shape}
          extrudeSettings={item.extrudeSettings}
          tags={item.tags}
        />
      ))}

      <Roads area={realCenter} />
      <pointLight position={[-10, -10, -10]} decay={0} intensity={Math.PI} />
      <Car />
      <Export />
      <Sky distance={450000} sunPosition={[0, 1, 0]} inclination={0} azimuth={0.25} />
      <Environment preset="city" />
    </Canvas>
  );
}
