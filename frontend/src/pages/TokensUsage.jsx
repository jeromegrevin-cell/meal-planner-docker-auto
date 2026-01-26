import { useEffect, useMemo, useState } from "react";
import axios from "axios";

function TokensGraph({ data }) {
  if (!data?.length) return null;
  const max = Math.max(...data.map((d) => d.tokens), 1);

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Évolution des tokens par semaine
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          height: 80,
          borderBottom: "1px solid #ddd",
          paddingBottom: 4
        }}
      >
        {data.map((w) => (
          <div
            key={w.week_id}
            title={`${w.week_id} : ${w.tokens} tokens`}
            style={{
              width: 22,
              height: `${(w.tokens / max) * 100}%`,
              background: "#6366f1",
              borderRadius: 4
            }}
          />
        ))}
      </div>
    </div>
  );
}

function toCsv(rows) {
  const header = ["week_id", "tokens_total", "model", "input_tokens", "output_tokens"].join(",");
  const lines = rows.map((r) =>
    [
      r.week_id,
      r.tokens_total,
      r.model || "ALL",
      r.input_tokens ?? "",
      r.output_tokens ?? ""
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

export default function TokensUsage() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [weekStart, setWeekStart] = useState("");
  const [weekEnd, setWeekEnd] = useState("");
  const [modelFilter, setModelFilter] = useState("ALL");
  const [pricePer1k, setPricePer1k] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data: all } = await axios.get("/api/chat/usage/all");
      const sorted = [...all].sort((a, b) => a.week_id.localeCompare(b.week_id));
      setHistory(sorted);
      if (sorted.length > 0) {
        setWeekStart(sorted[0].week_id);
        setWeekEnd(sorted[sorted.length - 1].week_id);
      }
      setLoading(false);
    }
    load();
  }, []);

  const weekIds = useMemo(() => history.map((h) => h.week_id), [history]);

  const filtered = useMemo(() => {
    if (!history.length) return [];
    const startIdx = weekStart ? weekIds.indexOf(weekStart) : 0;
    const endIdx = weekEnd ? weekIds.indexOf(weekEnd) : weekIds.length - 1;
    const lo = Math.max(0, Math.min(startIdx, endIdx));
    const hi = Math.max(startIdx, endIdx);
    return history.slice(lo, hi + 1);
  }, [history, weekIds, weekStart, weekEnd]);

  const availableModels = useMemo(() => {
    const set = new Set();
    history.forEach((h) => {
      const byModel = h.usage_by_model || {};
      Object.keys(byModel).forEach((m) => set.add(m));
    });
    return ["ALL", ...Array.from(set).sort()];
  }, [history]);

  const series = useMemo(() => {
    return filtered.map((h) => {
      if (modelFilter === "ALL") {
        return { week_id: h.week_id, tokens: h.usage_totals?.total_tokens ?? h.total_tokens ?? 0 };
      }
      const m = h.usage_by_model?.[modelFilter] || {};
      return { week_id: h.week_id, tokens: m.total_tokens ?? 0 };
    });
  }, [filtered, modelFilter]);

  const totals = useMemo(() => {
    const totalTokens = series.reduce((sum, s) => sum + (s.tokens || 0), 0);
    const lastWeek = series.length ? series[series.length - 1] : null;
    const weekTokens = lastWeek?.tokens ?? 0;
    return { totalTokens, weekTokens };
  }, [series]);

  const costEstimate = useMemo(() => {
    const rate = Number(pricePer1k);
    if (!rate) return null;
    return Math.round((totals.totalTokens / 1000) * rate * 100) / 100;
  }, [pricePer1k, totals.totalTokens]);

  const exportRows = useMemo(() => {
    return filtered.map((h) => {
      if (modelFilter === "ALL") {
        return {
          week_id: h.week_id,
          tokens_total: h.usage_totals?.total_tokens ?? h.total_tokens ?? 0,
          model: "ALL",
          input_tokens: h.usage_totals?.input_tokens ?? 0,
          output_tokens: h.usage_totals?.output_tokens ?? 0
        };
      }
      const m = h.usage_by_model?.[modelFilter] || {};
      return {
        week_id: h.week_id,
        tokens_total: m.total_tokens ?? 0,
        model: modelFilter,
        input_tokens: m.input_tokens ?? 0,
        output_tokens: m.output_tokens ?? 0
      };
    });
  }, [filtered, modelFilter]);

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Tokens & Usage</h2>

      {loading ? (
        <div>Chargement…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "#555" }}>Période</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={weekStart} onChange={(e) => setWeekStart(e.target.value)}>
                  {weekIds.map((id) => (
                    <option key={`start-${id}`} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <select value={weekEnd} onChange={(e) => setWeekEnd(e.target.value)}>
                  {weekIds.map((id) => (
                    <option key={`end-${id}`} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "#555" }}>Modèle</div>
              <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 12, marginLeft: "auto" }}>
              <button
                onClick={() =>
                  download(
                    "tokens_usage.json",
                    JSON.stringify(exportRows, null, 2),
                    "application/json"
                  )
                }
              >
                Export JSON
              </button>
              <button
                onClick={() =>
                  download("tokens_usage.csv", toCsv(exportRows), "text/csv")
                }
              >
                Export CSV
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 24, marginTop: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: "#555" }}>
                Tokens période ({series.length} semaine(s))
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {totals.totalTokens}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#555" }}>
                Tokens semaine courante (période)
              </div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                {totals.weekTokens}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "#555" }}>Coût estimé (€/1k)</div>
              <input
                type="number"
                placeholder="ex: 0.5"
                value={pricePer1k}
                onChange={(e) => setPricePer1k(e.target.value)}
                style={{ width: 120 }}
              />
              {costEstimate != null ? (
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  ≈ {costEstimate} €
                </div>
              ) : null}
            </div>
          </div>

          <TokensGraph data={series} />
        </>
      )}
    </div>
  );
}
