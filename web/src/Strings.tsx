import type { PvString } from "../../server/types.ts";
import { lazy, Suspense } from "react";

const ProductScene = lazy(() => import("./ProductScene.tsx"));

/**
 * Per-MPPT solar inputs, sitting above the solar node in the flow diagram.
 *
 * PV1-PV3 are measured (voltage x current from registers 10167-10172). PV4 is
 * derived: the device exposes no registers for it, so it is the shortfall
 * between the PV total and the three measured strings. It is hatched and
 * labelled so it never reads as a measurement.
 */
export function Strings({ strings }: { strings: PvString[] }) {
  if (strings.length === 0) return null;
  const peak = Math.max(...strings.map((s) => s.watts), 1);

  return (
    <div className="strings-panel">
      <Suspense fallback={<div className="product-scene" aria-busy="true" />}>
        <ProductScene kind="panels" />
      </Suspense>
      <h2 className="eyebrow">Solar</h2>
      <div className="strings">
        {strings.map((st) => (
          <div className={`string ${st.watts < 1 ? "is-idle" : ""}`} key={st.index}>
            <div className="string-head">
              <span className="string-name">PV{st.index}</span>
              <span className="string-watts">{Math.round(st.watts)} W</span>
            </div>
            <div className="string-bar-track">
              <div
                className={`string-bar ${st.derived ? "is-derived" : ""}`}
                style={{ width: `${Math.min(100, (st.watts / peak) * 100)}%` }}
              />
            </div>
            <div className="string-meta">
              {st.watts < 1 ? (
                "idle"
              ) : st.derived ? (
                <span
                  className="inferred"
                  title="Not exposed by the device; inferred as the shortfall between the PV total and the three measured strings"
                >
                  derived
                </span>
              ) : (
                `${st.volts.toFixed(1)} V · ${st.amps.toFixed(2)} A`
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
